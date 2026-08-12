// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";

import {DeployPaymaster, IDeployedPaymaster} from "../script/DeployPaymaster.s.sol";
import {TenantPaymaster} from "../src/TenantPaymaster.sol";
import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";

/// @notice Tests the DEPLOY SCRIPT, not the paymaster.
///
/// @dev This exists because the script was broken in exactly the configuration it documents as the
///      production one. `addStake` is `onlyOwner`; the script constructed the paymaster owned by
///      `PAYMASTER_OWNER` and then staked it as the deployer, so any deploy where the owner is a
///      multisig — the documented recommendation — reverted `OwnableUnauthorizedAccount` AFTER the
///      contract was deployed and the deposit was made, leaving a funded, UNSTAKED paymaster that
///      every conforming bundler rejects.
///
///      It went unnoticed because every existing path sets the owner to the deployer:
///      `local-setup.sh` does, and the unit tests construct the paymaster directly. The failure was
///      reachable only on a real multi-chain deploy, which is where it was found. The case that
///      matters most is therefore the one asserted first.
///
///      Configuration is passed as a struct rather than through `vm.setEnv`, because that mutates
///      the shared process environment and makes tests that each set the same variable interfere.
contract DeployPaymasterTest is Test {
    EntryPoint internal entryPoint;
    DeployPaymaster internal script;

    address internal multisigOwner = makeAddr("multisigOwner");
    address internal sponsorSigner = makeAddr("sponsorSigner");

    uint256 internal constant DEPOSIT_WEI = 1 ether;
    uint256 internal constant STAKE_WEI = 2 ether;
    uint32 internal constant UNSTAKE_DELAY = 1 days;

    function setUp() public {
        entryPoint = new EntryPoint();
        script = new DeployPaymaster();
        // The script broadcasts from the default script sender; fund it for the deposit and stake.
        vm.deal(DEFAULT_SENDER, 100 ether);
    }

    function config() internal view returns (DeployPaymaster.Config memory) {
        return DeployPaymaster.Config({
            kind: DeployPaymaster.Kind.Verifying,
            entryPoint: address(entryPoint),
            owner: multisigOwner,
            signer: sponsorSigner,
            depositWei: DEPOSIT_WEI,
            stakeWei: STAKE_WEI,
            unstakeDelaySec: UNSTAKE_DELAY
        });
    }

    /// The production shape: the intended owner is a multisig that is not the deployer. This is the
    /// case that used to revert.
    function test_deploysFundsAndStakesWhenOwnerIsNotTheDeployer() public {
        IDeployedPaymaster paymaster = script.deploy(config());

        assertEq(paymaster.getDeposit(), DEPOSIT_WEI, "deposit not registered");

        IStakeManager.DepositInfo memory info = entryPoint.getDepositInfo(address(paymaster));
        assertEq(info.stake, STAKE_WEI, "stake not registered");
        assertTrue(info.staked, "not staked");
        assertEq(info.unstakeDelaySec, UNSTAKE_DELAY, "wrong unstake delay");
    }

    /// The handover is offered, not completed: `Ownable2Step` means a mistyped owner leaves control
    /// with the deployer rather than burning the contract.
    function test_offersOwnershipToTheIntendedOwnerWithoutCompletingIt() public {
        IDeployedPaymaster paymaster = script.deploy(config());

        assertEq(paymaster.owner(), DEFAULT_SENDER, "deployer should still own it until accepted");
        assertEq(paymaster.pendingOwner(), multisigOwner, "handover not offered");

        vm.prank(multisigOwner);
        paymaster.acceptOwnership();

        assertEq(paymaster.owner(), multisigOwner, "handover did not complete");
        assertEq(paymaster.pendingOwner(), address(0), "pending owner not cleared");
    }

    /// A local devnet, where the deployer is the intended owner. No pending handover to itself.
    function test_leavesNoPendingHandoverWhenTheDeployerIsTheOwner() public {
        DeployPaymaster.Config memory cfg = config();
        cfg.owner = DEFAULT_SENDER;

        IDeployedPaymaster paymaster = script.deploy(cfg);

        assertEq(paymaster.owner(), DEFAULT_SENDER, "owner should be the deployer");
        assertEq(paymaster.pendingOwner(), address(0), "should not offer ownership to itself");
        assertEq(entryPoint.getDepositInfo(address(paymaster)).stake, STAKE_WEI, "stake not registered");
    }

    /// The initial sponsorship signer must be registered, or the paymaster cannot attest anything.
    function test_registersTheInitialSigner() public {
        IDeployedPaymaster paymaster = script.deploy(config());

        assertEq(paymaster.signerCount(), 1, "expected exactly one signer");
        assertTrue(paymaster.isSigner(sponsorSigner), "configured signer not registered");
    }

    /// The multi-tenant contract is deployed, funded and staked by the same path. Asserted because
    /// a backend configured with `paymasterKind: "tenant"` is unusable until one exists on chain,
    /// and the two contracts share no ancestor that would make this true by construction.
    function test_deploysTheMultiTenantPaymasterWhenAsked() public {
        DeployPaymaster.Config memory cfg = config();
        cfg.kind = DeployPaymaster.Kind.Tenant;

        IDeployedPaymaster paymaster = script.deploy(cfg);

        // It really is the other contract: `balanceOf` exists on no VerifyingPaymaster.
        TenantPaymaster tenant = TenantPaymaster(payable(address(paymaster)));
        assertEq(tenant.balanceOf(keccak256("t_acme")), 0, "a fresh tenant should hold nothing");
        assertEq(tenant.totalTenantBalance(), 0);

        // And the staking that ERC-7562 requires of it happened, exactly as for its sibling.
        assertEq(entryPoint.getDepositInfo(address(paymaster)).stake, STAKE_WEI, "stake not registered");
        assertEq(paymaster.getDeposit(), DEPOSIT_WEI, "deposit not registered");
        assertEq(paymaster.pendingOwner(), multisigOwner, "handover not offered");
        assertTrue(paymaster.isSigner(sponsorSigner), "configured signer not registered");
    }

    /// A wrong EntryPoint address is the most common misconfiguration and produces the least
    /// legible failure (every sponsorship reverts AA34). It must fail before anything is deployed.
    function test_refusesAnEntryPointWithNoCode() public {
        DeployPaymaster.Config memory cfg = config();
        cfg.entryPoint = makeAddr("notAContract");

        vm.expectRevert("ENTRYPOINT has no code on this chain; check the address");
        script.deploy(cfg);
    }

    function test_refusesAZeroOwner() public {
        DeployPaymaster.Config memory cfg = config();
        cfg.owner = address(0);

        vm.expectRevert("PAYMASTER_OWNER is required");
        script.deploy(cfg);
    }

    function test_refusesAZeroSigner() public {
        DeployPaymaster.Config memory cfg = config();
        cfg.signer = address(0);

        vm.expectRevert("PAYMASTER_SIGNER is required");
        script.deploy(cfg);
    }

    /// Deposit and stake are independently optional — a chain funded separately can deploy with
    /// zero of either — but the handover must still happen.
    function test_allowsAZeroDepositAndStake() public {
        DeployPaymaster.Config memory cfg = config();
        cfg.depositWei = 0;
        cfg.stakeWei = 0;

        IDeployedPaymaster paymaster = script.deploy(cfg);

        assertEq(paymaster.getDeposit(), 0, "expected no deposit");
        assertEq(paymaster.pendingOwner(), multisigOwner, "handover not offered");
    }
}
