// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";
import {TenantPaymaster} from "../src/TenantPaymaster.sol";

/// @notice The surface this script needs, common to both paymasters.
///
/// @dev Declared here rather than extracted into a shared base contract. The two paymasters are
///      deliberately independent — see the header of TenantPaymaster — and giving them a common
///      ancestor purely so a deploy script could hold one variable would couple them on chain for
///      an off-chain convenience. An interface costs nothing at runtime and expresses the same
///      thing: these happen to share a management surface, not a lineage.
interface IDeployedPaymaster {
    function deposit() external payable;
    function addStake(
        uint32 unstakeDelaySec
    ) external payable;
    function getDeposit() external view returns (uint256);
    function signerCount() external view returns (uint256);
    function isSigner(
        address signer
    ) external view returns (bool);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(
        address newOwner
    ) external;
    function acceptOwnership() external;
}

/// @title DeployPaymaster
/// @notice Deploys a VerifyingPaymaster, then funds and stakes it in one broadcast.
///
/// @dev The funding and staking are part of the deploy, not a follow-up, because a paymaster is
///      non-functional without both and the gap between "deployed" and "usable" is where an
///      operator forgets a step and then debugs an opaque bundler rejection. Specifically:
///
///        - DEPOSIT pays for sponsored gas. Without it, every sponsored op fails AA31.
///        - STAKE is mandatory for THIS paymaster: it reads its own storage during validation,
///          which ERC-7562 permits only for a staked entity. An unstaked deployment is silently
///          rejected by every conforming bundler (measured: rundler returns -32502). The minimums
///          are the bundler's policy, not consensus — 1 ETH / 1 day is rundler's default, so the
///          defaults here match it. Verify your target bundler's requirement before production.
///
/// @dev OWNERSHIP HANDOVER. `addStake` is `onlyOwner`, so the paymaster cannot be staked by anyone
///      but its owner. It is therefore deployed owned by the DEPLOYER, funded and staked, and only
///      then handed to `PAYMASTER_OWNER` — through `Ownable2Step`, so the handover completes when
///      the new owner calls `acceptOwnership()`.
///
///      Constructing it owned by the multisig directly does not work: the deployer would no longer
///      be the owner by the time `addStake` runs, and the deploy would revert
///      `OwnableUnauthorizedAccount` having already deployed the contract and made the deposit —
///      leaving a funded, UNSTAKED paymaster that every conforming bundler rejects. Two-step
///      ownership is also the right shape for the handover itself: a typo in `PAYMASTER_OWNER`
///      leaves ownership with the deployer instead of burning the contract.
///
///      The deploy is therefore not finished until the new owner accepts. Until then the DEPLOYER
///      key still controls the paymaster, so treat it as a privileged key for that window.
///
/// @dev Run:
///        forge script script/DeployPaymaster.s.sol \
///          --rpc-url $RPC_URL --broadcast --verify \
///          --private-key $DEPLOYER_KEY
///
///      Or, for every configured chain at once, with verification and generated backend config:
///        ./deploy/deploy-chains.sh
///
///      Configured entirely by environment, so the same script deploys to every chain:
///        ENTRYPOINT       (default: canonical v0.7, identical on every chain)
///        PAYMASTER_OWNER  (required — should be a multisig in production)
///        PAYMASTER_SIGNER (required — the sponsorship signer's address)
///        DEPOSIT_WEI      (default 1 ether)
///        STAKE_WEI        (default 1 ether)
///        UNSTAKE_DELAY_SEC(default 86400)
///        PAYMASTER_KIND   (default "verifying"; "tenant" for the multi-tenant contract)
contract DeployPaymaster is Script {
    /// The canonical EntryPoint v0.7, deployed at this address on every supported chain.
    address internal constant CANONICAL_ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    /// @dev Which contract to deploy. `Verifying` is first so the zero value is the single-tenant
    ///      contract every existing deployment uses — a struct built without naming this field gets
    ///      the behaviour it had before the field existed.
    enum Kind {
        Verifying,
        Tenant
    }

    struct Config {
        Kind kind;
        address entryPoint;
        address owner;
        address signer;
        uint256 depositWei;
        uint256 stakeWei;
        uint32 unstakeDelaySec;
    }

    function run() external returns (IDeployedPaymaster paymaster) {
        return deploy(configFromEnv());
    }

    /// @notice Reads the deploy configuration from the environment.
    /// @dev Separated from `deploy` so the deploy itself is testable without touching the
    ///      environment. Foundry's `vm.setEnv` mutates the real process environment, which is
    ///      shared by every test in the run — tests that each set the same variable interfere with
    ///      one another. Passing a struct removes that coupling entirely, and mirrors how the
    ///      backend separates parsing its environment from building anything out of it.
    function configFromEnv() public view returns (Config memory) {
        return Config({
            kind: _kindFromEnv(),
            entryPoint: vm.envOr("ENTRYPOINT", CANONICAL_ENTRYPOINT_V07),
            owner: vm.envAddress("PAYMASTER_OWNER"),
            signer: vm.envAddress("PAYMASTER_SIGNER"),
            depositWei: vm.envOr("DEPOSIT_WEI", uint256(1 ether)),
            stakeWei: vm.envOr("STAKE_WEI", uint256(1 ether)),
            unstakeDelaySec: uint32(vm.envOr("UNSTAKE_DELAY_SEC", uint256(86_400)))
        });
    }

    /// @dev An unrecognised value is rejected rather than defaulted. Silently deploying the
    ///      single-tenant contract because someone wrote "multitenant" would hand every customer a
    ///      shared deposit while the backend signed tenant-scoped attestations against it.
    function _kindFromEnv() private view returns (Kind) {
        string memory kind = vm.envOr("PAYMASTER_KIND", string("verifying"));
        bytes32 hash = keccak256(bytes(kind));
        if (hash == keccak256("verifying")) return Kind.Verifying;
        if (hash == keccak256("tenant")) return Kind.Tenant;
        revert(string.concat('PAYMASTER_KIND must be "verifying" or "tenant", got: ', kind));
    }

    function deploy(
        Config memory config
    ) public returns (IDeployedPaymaster paymaster) {
        address entryPoint = config.entryPoint;
        address owner = config.owner;
        address signer = config.signer;
        uint256 depositWei = config.depositWei;
        uint256 stakeWei = config.stakeWei;
        uint32 unstakeDelaySec = config.unstakeDelaySec;

        // Fail before broadcasting, not after a half-done deploy, if the EntryPoint has no code.
        // A wrong EntryPoint address is the single most common misconfiguration and produces the
        // least legible failure (every sponsorship reverts AA34).
        require(entryPoint.code.length > 0, "ENTRYPOINT has no code on this chain; check the address");
        require(owner != address(0), "PAYMASTER_OWNER is required");
        require(signer != address(0), "PAYMASTER_SIGNER is required");

        console.log("Kind:            ", config.kind == Kind.Verifying ? "verifying" : "tenant");
        console.log("EntryPoint:      ", entryPoint);
        console.log("Owner:           ", owner);
        console.log("Initial signer:  ", signer);
        console.log("Deposit (wei):   ", depositWei);
        console.log("Stake (wei):     ", stakeWei);
        console.log("Unstake delay:   ", unstakeDelaySec);

        vm.startBroadcast();

        // The address actually broadcasting — whether that came from --private-key, --account or
        // --ledger. It owns the paymaster for the duration of the deploy, because staking requires
        // it (see the ownership note above).
        (, address deployer,) = vm.readCallers();

        paymaster = config.kind == Kind.Verifying
            ? IDeployedPaymaster(address(new VerifyingPaymaster(IEntryPoint(entryPoint), deployer, signer)))
            : IDeployedPaymaster(address(new TenantPaymaster(IEntryPoint(entryPoint), deployer, signer)));
        console.log(config.kind == Kind.Verifying ? "VerifyingPaymaster deployed:" : "TenantPaymaster deployed:");
        console.log(" ", address(paymaster));

        if (depositWei > 0) {
            paymaster.deposit{value: depositWei}();
            console.log("Deposited:", depositWei);
        }
        if (stakeWei > 0) {
            paymaster.addStake{value: stakeWei}(unstakeDelaySec);
            console.log("Staked:", stakeWei, "for", unstakeDelaySec);
        }

        // Handed over last, once the contract is fully usable. Skipped when the deployer IS the
        // intended owner (local devnets), where a pending handover to yourself would be noise.
        if (owner != deployer) {
            paymaster.transferOwnership(owner);
            console.log("Ownership offered to:", owner);
        }

        vm.stopBroadcast();

        // The paymaster now reads its own storage during validation and is staked, so a bundler
        // will accept it. Re-assert the invariants that make it usable, so a misconfigured run
        // fails here rather than at the first sponsored operation.
        require(paymaster.getDeposit() >= depositWei, "deposit not registered on EntryPoint");
        require(paymaster.signerCount() == 1, "initial signer not registered");
        require(
            IEntryPoint(entryPoint).getDepositInfo(address(paymaster)).stake >= stakeWei,
            "stake not registered on EntryPoint"
        );

        if (owner != deployer) {
            require(paymaster.pendingOwner() == owner, "ownership handover was not offered");
            console.log("");
            console.log("ACTION REQUIRED: the deploy is not complete until the new owner accepts.");
            console.log("  cast send", address(paymaster), '"acceptOwnership()"');
            console.log("Until then the deployer key still owns this paymaster.");
        }
    }
}
