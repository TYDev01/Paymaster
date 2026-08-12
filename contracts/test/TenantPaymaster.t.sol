// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {SimpleAccountFactory} from "account-abstraction/samples/SimpleAccountFactory.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";

import {TenantPaymaster} from "../src/TenantPaymaster.sol";

/// @notice Per-tenant balances, against a real EntryPoint executing real operations.
///
/// @dev The assertions that matter are about MONEY: that a tenant's operation is paid out of that
///      tenant's balance and no one else's, that the contract can never owe more than it holds, and
///      that an unused reservation comes back. None of those can be checked against a mock — the
///      EntryPoint decides what an operation actually costs and when the paymaster is charged.
contract TenantPaymasterTest is Test {
    EntryPoint internal entryPoint;
    SimpleAccountFactory internal factory;
    SimpleAccount internal account;
    TenantPaymaster internal paymaster;

    address internal owner = makeAddr("owner");
    address internal beneficiary = payable(makeAddr("beneficiary"));

    address internal signer;
    uint256 internal signerKey;
    address internal accountOwner;
    uint256 internal accountOwnerKey;

    bytes32 internal constant ACME = keccak256("t_acme");
    bytes32 internal constant RIVAL = keccak256("t_rival");

    uint128 internal constant VERIFICATION_GAS = 500_000;
    uint128 internal constant CALL_GAS = 200_000;
    uint128 internal constant PM_VERIFICATION_GAS = 300_000;
    uint128 internal constant POSTOP_GAS = 50_000;
    uint256 internal constant PRE_VERIFICATION_GAS = 100_000;
    uint128 internal constant MAX_FEE = 20 gwei;
    uint128 internal constant MAX_PRIORITY_FEE = 1 gwei;

    function setUp() public {
        (signer, signerKey) = makeAddrAndKey("signer");
        (accountOwner, accountOwnerKey) = makeAddrAndKey("accountOwner");

        entryPoint = new EntryPoint();
        factory = new SimpleAccountFactory(entryPoint);
        account = factory.createAccount(accountOwner, 0);

        paymaster = new TenantPaymaster(IEntryPoint(address(entryPoint)), owner, signer);

        vm.deal(owner, 1000 ether);
        vm.prank(owner);
        // Mandatory: this contract reads its own storage during validation.
        paymaster.addStake{value: 1 ether}(1 days);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUNDING
    //////////////////////////////////////////////////////////////*/

    function test_depositCreditsTheTenantAndTheEntryPointTogether() public {
        vm.deal(address(this), 5 ether);
        paymaster.depositFor{value: 3 ether}(ACME);

        assertEq(paymaster.balanceOf(ACME), 3 ether, "tenant not credited");
        // The two moves are inseparable: this is what makes the solvency invariant true by
        // construction rather than something to reconcile afterwards.
        assertEq(entryPoint.balanceOf(address(paymaster)), 3 ether, "deposit not made");
        assertEq(paymaster.totalTenantBalance(), 3 ether);
    }

    function test_anyoneMayFundATenant() public {
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);

        // Refilling is not privileged. Requiring the owner would put the platform in the path of
        // every customer's top-up.
        vm.prank(stranger);
        paymaster.depositFor{value: 1 ether}(ACME);
        assertEq(paymaster.balanceOf(ACME), 1 ether);
    }

    function test_refusesTheZeroTenant() public {
        vm.deal(address(this), 1 ether);
        // bytes32(0) is what an uninitialised field looks like; crediting it would silently create a
        // balance nobody owns and nobody can withdraw.
        vm.expectRevert(TenantPaymaster.ZeroTenant.selector);
        paymaster.depositFor{value: 1 ether}(bytes32(0));
    }

    function test_onlyTheOwnerOrControllerMayWithdraw() public {
        vm.deal(address(this), 2 ether);
        paymaster.depositFor{value: 2 ether}(ACME);

        address thief = makeAddr("thief");
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(TenantPaymaster.NotTenantController.selector, ACME, thief));
        paymaster.withdrawFor(ACME, payable(thief), 1 ether);
    }

    function test_aControllerWithdrawsWithoutAskingThePlatform() public {
        vm.deal(address(this), 2 ether);
        paymaster.depositFor{value: 2 ether}(ACME);

        address customer = makeAddr("customer");
        vm.prank(owner);
        paymaster.setController(ACME, customer);

        vm.prank(customer);
        paymaster.withdrawFor(ACME, payable(customer), 1.5 ether);

        // The difference between a balance that is theirs and one we say is theirs.
        assertEq(customer.balance, 1.5 ether, "customer did not receive their funds");
        assertEq(paymaster.balanceOf(ACME), 0.5 ether);
        assertEq(paymaster.totalTenantBalance(), 0.5 ether);
    }

    function test_cannotWithdrawMoreThanTheTenantHas() public {
        vm.deal(address(this), 1 ether);
        paymaster.depositFor{value: 1 ether}(ACME);
        paymaster.depositFor{value: 0}(RIVAL);

        vm.prank(owner);
        // Withdrawing "the deposit" rather than "this tenant's balance" would be one customer
        // taking another's money, which the per-tenant check is the only thing preventing.
        vm.expectRevert(abi.encodeWithSelector(TenantPaymaster.InsufficientTenantBalance.selector, RIVAL, 0, 1 ether));
        paymaster.withdrawFor(RIVAL, payable(owner), 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                              SPONSORSHIP
    //////////////////////////////////////////////////////////////*/

    function test_sponsoredOperationIsPaidByItsOwnTenant() public {
        vm.deal(address(this), 10 ether);
        paymaster.depositFor{value: 5 ether}(ACME);
        paymaster.depositFor{value: 5 ether}(RIVAL);

        uint256 acmeBefore = paymaster.balanceOf(ACME);
        uint256 rivalBefore = paymaster.balanceOf(RIVAL);
        uint256 accountBefore = address(account).balance;

        _handleOps(_sponsored(ACME, 0));

        assertLt(paymaster.balanceOf(ACME), acmeBefore, "acme was not charged");
        // The property the whole design exists for.
        assertEq(paymaster.balanceOf(RIVAL), rivalBefore, "another tenant was charged");
        assertEq(address(account).balance, accountBefore, "the account paid something");
    }

    function test_refundsTheUnusedReservation() public {
        vm.deal(address(this), 5 ether);
        paymaster.depositFor{value: 5 ether}(ACME);

        uint256 before = paymaster.balanceOf(ACME);
        _handleOps(_sponsored(ACME, 0));
        uint256 charged = before - paymaster.balanceOf(ACME);

        // The reservation is the worst case — every gas limit at the maximum fee. A real operation
        // uses a fraction of it, and the difference must come back or a tenant is billed for gas
        // nobody spent.
        uint256 worstCase =
            (uint256(VERIFICATION_GAS) + CALL_GAS + PM_VERIFICATION_GAS + POSTOP_GAS + PRE_VERIFICATION_GAS) * MAX_FEE;
        assertLt(charged, worstCase, "the full reservation was kept");
        assertGt(charged, 0, "nothing was charged at all");
    }

    function test_chargesAtLeastWhatTheEntryPointTook() public {
        vm.deal(address(this), 5 ether);
        paymaster.depositFor{value: 5 ether}(ACME);

        uint256 depositBefore = entryPoint.balanceOf(address(paymaster));
        uint256 balanceBefore = paymaster.balanceOf(ACME);

        _handleOps(_sponsored(ACME, 0));

        uint256 depositSpent = depositBefore - entryPoint.balanceOf(address(paymaster));
        uint256 tenantCharged = balanceBefore - paymaster.balanceOf(ACME);

        // Charging the tenant LESS than the EntryPoint took would mean the platform quietly
        // subsidising them, one operation at a time, until the deposit ran dry with every balance
        // still looking healthy. This is the single most important assertion in the file.
        assertGe(tenantCharged, depositSpent, "the tenant was under-charged; the platform paid the difference");
    }

    function test_refusesATenantWithoutEnoughBalance() public {
        vm.deal(address(this), 6 ether);
        // Enough to be interesting, nowhere near the worst-case reservation.
        paymaster.depositFor{value: 0.0001 ether}(ACME);
        paymaster.depositFor{value: 5 ether}(RIVAL);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sponsored(ACME, 0);

        // Reverts rather than returning SIG_VALIDATION_FAILED: the backend only signs for a tenant
        // it believes can pay, so this means the balance moved after signing — an error, not a
        // routine rejection.
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(beneficiary));

        // And the neighbour's money is untouched by the attempt.
        assertEq(paymaster.balanceOf(RIVAL), 5 ether);
    }

    function test_cannotRedirectAnAttestationToAnotherTenant() public {
        vm.deal(address(this), 10 ether);
        paymaster.depositFor{value: 5 ether}(ACME);
        paymaster.depositFor{value: 5 ether}(RIVAL);

        PackedUserOperation memory op = _sponsored(ACME, 0);

        // Rewrite the tenant field, keeping the signature. If the tenant were outside the signed
        // digest this would spend the rival's balance with Acme's attestation.
        bytes memory data = op.paymasterAndData;
        bytes32 rival = RIVAL;
        assembly {
            // 32 (length prefix) + 64 (tenant offset) = 96 bytes into the allocation.
            mstore(add(data, 96), rival)
        }
        op.paymasterAndData = data;
        op.signature = _signAccount(op);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(); // AA34: the recovered signer no longer matches, so validation fails.
        entryPoint.handleOps(ops, payable(beneficiary));

        assertEq(paymaster.balanceOf(RIVAL), 5 ether, "the rival's balance moved");
    }

    function test_pauseHaltsSponsorshipButNotWithdrawal() public {
        vm.deal(address(this), 5 ether);
        paymaster.depositFor{value: 5 ether}(ACME);

        vm.prank(owner);
        paymaster.pause();

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sponsored(ACME, 0);
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(beneficiary));

        // A pause is an emergency stop on SPENDING. Trapping customers' money behind it would turn
        // an incident into a much worse one.
        vm.prank(owner);
        paymaster.withdrawFor(ACME, payable(owner), 1 ether);
        assertEq(paymaster.balanceOf(ACME), 4 ether);
    }

    /*//////////////////////////////////////////////////////////////
                           CONSTRUCTION & ACCESS
    //////////////////////////////////////////////////////////////*/

    function test_refusesToDeployWithoutAnOwnerOrASigner() public {
        // A paymaster with no owner can never be paused, staked or unstaked, and one with no signer
        // can never sponsor anything. Both are unrecoverable after deployment, so both are refused
        // at construction rather than discovered later.
        vm.expectRevert(TenantPaymaster.ZeroAddress.selector);
        new TenantPaymaster(IEntryPoint(address(entryPoint)), address(0), signer);

        vm.expectRevert(TenantPaymaster.ZeroAddress.selector);
        new TenantPaymaster(IEntryPoint(address(entryPoint)), owner, address(0));
    }

    function test_ownershipMovesInTwoSteps() public {
        address successor = makeAddr("successor");

        vm.prank(owner);
        paymaster.transferOwnership(successor);

        // Still the old owner until the new one accepts. BasePaymaster brings in single-step
        // Ownable, so this asserts the override actually took effect — a transfer to a mistyped
        // address under single-step ownership would have bricked the stake permanently.
        assertEq(paymaster.owner(), owner);
        assertEq(paymaster.pendingOwner(), successor);

        vm.prank(successor);
        paymaster.acceptOwnership();
        assertEq(paymaster.owner(), successor);
    }

    function test_onlyTheOwnerManagesSigners() public {
        address intruder = makeAddr("intruder");
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, intruder));
        paymaster.addSigner(intruder);
    }

    function test_addsAndRemovesSigners() public {
        address second = makeAddr("second");
        assertFalse(paymaster.isSigner(second));

        vm.prank(owner);
        paymaster.addSigner(second);
        assertTrue(paymaster.isSigner(second));
        assertEq(paymaster.signerCount(), 2);

        vm.prank(owner);
        paymaster.removeSigner(second);
        assertFalse(paymaster.isSigner(second));
        assertEq(paymaster.signerCount(), 1);
    }

    function test_refusesNonsensicalSignerChanges() public {
        vm.startPrank(owner);

        vm.expectRevert(TenantPaymaster.ZeroAddress.selector);
        paymaster.addSigner(address(0));

        // Adding twice would double-count `signerCount`, and the count is what tells an operator
        // whether removing a compromised key would leave the paymaster unable to sponsor at all.
        vm.expectRevert(abi.encodeWithSelector(TenantPaymaster.SignerAlreadyAuthorised.selector, signer));
        paymaster.addSigner(signer);

        vm.expectRevert(abi.encodeWithSelector(TenantPaymaster.SignerNotAuthorised.selector, address(0xabcd)));
        paymaster.removeSigner(address(0xabcd));

        vm.stopPrank();
    }

    function test_aRemovedSignerCanNoLongerSponsor() public {
        vm.deal(address(this), 5 ether);
        paymaster.depositFor{value: 5 ether}(ACME);

        vm.prank(owner);
        paymaster.removeSigner(signer);

        // The point of removal is that leaked keys stop working NOW, including for attestations
        // already signed and still inside their validity window.
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sponsored(ACME, 0);
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(beneficiary));
    }

    function test_unpauseResumesSponsorship() public {
        vm.deal(address(this), 5 ether);
        paymaster.depositFor{value: 5 ether}(ACME);

        vm.startPrank(owner);
        paymaster.pause();
        paymaster.unpause();
        vm.stopPrank();

        _handleOps(_sponsored(ACME, 0));
        assertLt(paymaster.balanceOf(ACME), 5 ether, "an unpaused paymaster must sponsor again");
    }

    /*//////////////////////////////////////////////////////////////
                              INPUT GUARDS
    //////////////////////////////////////////////////////////////*/

    function test_refusesToSetAControllerForTheZeroTenant() public {
        // bytes32(0) is what an uninitialised variable and a failed lookup both produce. Letting it
        // name a tenant would give a caller control of the balance every such bug credits.
        vm.prank(owner);
        vm.expectRevert(TenantPaymaster.ZeroTenant.selector);
        paymaster.setController(bytes32(0), makeAddr("controller"));
    }

    function test_refusesToWithdrawToNowhereOrForNothing() public {
        vm.deal(address(this), 1 ether);
        paymaster.depositFor{value: 1 ether}(ACME);

        vm.startPrank(owner);

        // Withdrawing to address(0) would burn a customer's balance irreversibly.
        vm.expectRevert(TenantPaymaster.ZeroAddress.selector);
        paymaster.withdrawFor(ACME, payable(address(0)), 1 ether);

        vm.expectRevert(TenantPaymaster.NothingToWithdraw.selector);
        paymaster.withdrawFor(ACME, payable(owner), 0);

        vm.stopPrank();
        assertEq(paymaster.balanceOf(ACME), 1 ether, "a refused withdrawal must not move money");
    }

    function test_refusesPaymasterDataTooShortToDecode() public {
        // Anything shorter than the signature offset has no tenant in it. Decoding it anyway would
        // read whatever followed in calldata and treat it as a tenant id.
        bytes memory truncated = abi.encodePacked(address(paymaster), PM_VERIFICATION_GAS, POSTOP_GAS);
        vm.expectRevert(abi.encodeWithSelector(TenantPaymaster.InvalidPaymasterDataLength.selector, truncated.length));
        paymaster.parsePaymasterAndData(truncated);
    }

    function test_refusesASignatureThatIsNotAnEcdsaSignature() public {
        vm.deal(address(this), 5 ether);
        paymaster.depositFor{value: 5 ether}(ACME);

        PackedUserOperation memory op = _unsigned(0);
        op.paymasterAndData = abi.encodePacked(
            address(paymaster), PM_VERIFICATION_GAS, POSTOP_GAS, uint48(0), uint48(0), ACME, hex"0badc0de"
        );
        op.signature = _signAccount(op);

        // A wrong-length signature reverts rather than returning SIG_VALIDATION_FAILED: it is
        // malformed input, not a signature that failed to verify, and `tryRecover` on 4 bytes would
        // otherwise be decided by whatever ECDSA does with garbage.
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(beneficiary));
    }

    /*//////////////////////////////////////////////////////////////
                            POSTOP UNDER ABUSE
    //////////////////////////////////////////////////////////////*/

    function test_postOpNeverRefundsMoreThanItReserved() public {
        vm.deal(address(this), 1 ether);
        paymaster.depositFor{value: 1 ether}(ACME);
        uint256 before = paymaster.balanceOf(ACME);

        // Called as the EntryPoint, with a context claiming a small reservation and a cost far
        // larger than it. The clamp is what stops the subtraction from being reached with a charge
        // above the reservation; without it, `reserved - charge` would revert and strand the
        // operation, or — written the other way — credit a tenant money nobody deposited.
        vm.prank(address(entryPoint));
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(ACME, uint256(1 gwei), POSTOP_GAS), 10 ether, 1);

        assertEq(paymaster.balanceOf(ACME), before, "a runaway cost report must not change the balance");
        assertEq(paymaster.totalTenantBalance(), before);
    }

    function test_onlyTheEntryPointMayReportCosts() public {
        vm.expectRevert("Sender not EntryPoint");
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(ACME, uint256(1 gwei), POSTOP_GAS), 1, 1);
    }

    function test_publishesItsEip712DomainSeparator() public view {
        // The backend needs this to build signatures off chain; if it drifts from what the contract
        // verifies against, every sponsorship silently fails to validate.
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("TenantPaymaster"),
                keccak256("1"),
                block.chainid,
                address(paymaster)
            )
        );
        assertEq(paymaster.domainSeparator(), expected);
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _sponsored(
        bytes32 tenant,
        uint256 nonce
    ) internal view returns (PackedUserOperation memory op) {
        op = _unsigned(nonce);

        // Through byte 96: the signature tail is what we are about to produce.
        op.paymasterAndData = abi.encodePacked(
            address(paymaster),
            PM_VERIFICATION_GAS,
            POSTOP_GAS,
            uint48(0), // validUntil: 0 means no expiry
            uint48(0), // validAfter
            tenant
        );

        bytes32 digest = paymaster.getHash(op, tenant, 0, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, r, s, v);

        op.signature = _signAccount(op);
    }

    function _unsigned(
        uint256 nonce
    ) internal view returns (PackedUserOperation memory op) {
        op = PackedUserOperation({
            sender: address(account),
            nonce: nonce,
            initCode: "",
            callData: abi.encodeCall(SimpleAccount.execute, (address(0xdead), 0, "")),
            accountGasLimits: bytes32((uint256(VERIFICATION_GAS) << 128) | CALL_GAS),
            preVerificationGas: PRE_VERIFICATION_GAS,
            gasFees: bytes32((uint256(MAX_PRIORITY_FEE) << 128) | MAX_FEE),
            paymasterAndData: "",
            signature: ""
        });
    }

    function _signAccount(
        PackedUserOperation memory op
    ) internal view returns (bytes memory) {
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(accountOwnerKey, hash);
        return abi.encodePacked(r, s, v);
    }

    function _handleOps(
        PackedUserOperation memory op
    ) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(beneficiary));
    }
}
