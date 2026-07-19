// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";

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
/// @dev Run:
///        forge script script/DeployPaymaster.s.sol \
///          --rpc-url $RPC_URL --broadcast --verify \
///          --private-key $DEPLOYER_KEY
///
///      Configured entirely by environment, so the same script deploys to every chain:
///        ENTRYPOINT       (default: canonical v0.7, identical on every chain)
///        PAYMASTER_OWNER  (required — should be a multisig in production)
///        PAYMASTER_SIGNER (required — the sponsorship signer's address)
///        DEPOSIT_WEI      (default 1 ether)
///        STAKE_WEI        (default 1 ether)
///        UNSTAKE_DELAY_SEC(default 86400)
contract DeployPaymaster is Script {
    /// The canonical EntryPoint v0.7, deployed at this address on every supported chain.
    address internal constant CANONICAL_ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external returns (VerifyingPaymaster paymaster) {
        address entryPoint = vm.envOr("ENTRYPOINT", CANONICAL_ENTRYPOINT_V07);
        address owner = vm.envAddress("PAYMASTER_OWNER");
        address signer = vm.envAddress("PAYMASTER_SIGNER");
        uint256 depositWei = vm.envOr("DEPOSIT_WEI", uint256(1 ether));
        uint256 stakeWei = vm.envOr("STAKE_WEI", uint256(1 ether));
        uint32 unstakeDelaySec = uint32(vm.envOr("UNSTAKE_DELAY_SEC", uint256(86_400)));

        // Fail before broadcasting, not after a half-done deploy, if the EntryPoint has no code.
        // A wrong EntryPoint address is the single most common misconfiguration and produces the
        // least legible failure (every sponsorship reverts AA34).
        require(entryPoint.code.length > 0, "ENTRYPOINT has no code on this chain; check the address");
        require(owner != address(0), "PAYMASTER_OWNER is required");
        require(signer != address(0), "PAYMASTER_SIGNER is required");

        console.log("EntryPoint:      ", entryPoint);
        console.log("Owner:           ", owner);
        console.log("Initial signer:  ", signer);
        console.log("Deposit (wei):   ", depositWei);
        console.log("Stake (wei):     ", stakeWei);
        console.log("Unstake delay:   ", unstakeDelaySec);

        vm.startBroadcast();

        paymaster = new VerifyingPaymaster(IEntryPoint(entryPoint), owner, signer);
        console.log("Paymaster deployed:", address(paymaster));

        if (depositWei > 0) {
            paymaster.deposit{value: depositWei}();
            console.log("Deposited:", depositWei);
        }
        if (stakeWei > 0) {
            paymaster.addStake{value: stakeWei}(unstakeDelaySec);
            console.log("Staked:", stakeWei, "for", unstakeDelaySec);
        }

        vm.stopBroadcast();

        // The paymaster now reads its own storage during validation and is staked, so a bundler
        // will accept it. Re-assert the two invariants that make it usable, so a misconfigured run
        // fails here rather than at the first sponsored operation.
        require(paymaster.getDeposit() >= depositWei, "deposit not registered on EntryPoint");
        require(paymaster.signerCount() == 1, "initial signer not registered");
    }
}
