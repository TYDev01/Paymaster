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
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";

/// @notice Exercises the paymaster against a real EntryPoint and a real SimpleAccount. Nothing
///         here is mocked: every assertion about sponsorship is the result of the actual
///         EntryPoint executing the actual validation path.
contract VerifyingPaymasterTest is Test {
    EntryPoint internal entryPoint;
    SimpleAccountFactory internal factory;
    SimpleAccount internal account;
    VerifyingPaymaster internal paymaster;

    address internal owner = makeAddr("owner");
    address internal beneficiary = payable(makeAddr("beneficiary"));
    address internal target = makeAddr("target");

    address internal signer;
    uint256 internal signerKey;
    address internal accountOwner;
    uint256 internal accountOwnerKey;

    // Gas parameters used across tests. Deliberately generous: these tests assert on
    // authorisation behaviour, not on gas estimation accuracy.
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

        paymaster = new VerifyingPaymaster(IEntryPoint(address(entryPoint)), owner, signer);

        vm.deal(owner, 100 ether);
        vm.startPrank(owner);
        paymaster.deposit{value: 10 ether}();
        // Mandatory: this paymaster reads its own storage during validation.
        paymaster.addStake{value: 1 ether}(1 days);
        vm.stopPrank();

        vm.fee(1 gwei);
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _packGasLimits(
        uint128 high,
        uint128 low
    ) internal pure returns (bytes32) {
        return bytes32((uint256(high) << 128) | uint256(low));
    }

    /// @dev Builds the paymasterAndData prefix (everything the signature covers).
    function _pmDataPrefix(
        uint48 validUntil,
        uint48 validAfter
    ) internal view returns (bytes memory) {
        return abi.encodePacked(address(paymaster), PM_VERIFICATION_GAS, POSTOP_GAS, validUntil, validAfter);
    }

    function _baseOp() internal view returns (PackedUserOperation memory op) {
        op = PackedUserOperation({
            sender: address(account),
            nonce: entryPoint.getNonce(address(account), 0),
            initCode: "",
            callData: abi.encodeCall(SimpleAccount.execute, (target, 0, "")),
            accountGasLimits: _packGasLimits(VERIFICATION_GAS, CALL_GAS),
            preVerificationGas: PRE_VERIFICATION_GAS,
            gasFees: _packGasLimits(MAX_PRIORITY_FEE, MAX_FEE),
            paymasterAndData: "",
            signature: ""
        });
    }

    /// @dev Signs the paymaster digest with `key`, then signs the resulting UserOp with the
    ///      account owner's key. Mirrors exactly what the backend + wallet do in production.
    function _sponsorAndSign(
        PackedUserOperation memory op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 key
    ) internal view returns (PackedUserOperation memory) {
        op.paymasterAndData = _pmDataPrefix(validUntil, validAfter);

        bytes32 digest = paymaster.getHash(op, validUntil, validAfter);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.paymasterAndData = abi.encodePacked(_pmDataPrefix(validUntil, validAfter), r, s, v);

        return _signAccount(op);
    }

    function _signAccount(
        PackedUserOperation memory op
    ) internal view returns (PackedUserOperation memory) {
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(accountOwnerKey, MessageHashUtils.toEthSignedMessageHash(userOpHash));
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    function _handle(
        PackedUserOperation memory op
    ) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(beneficiary));
    }

    /*//////////////////////////////////////////////////////////////
                          END-TO-END SPONSORSHIP
    //////////////////////////////////////////////////////////////*/

    /// The load-bearing test: a real UserOp, sponsored by a real signature, executed by a real
    /// EntryPoint. Proves the account spends nothing and the paymaster's deposit covers the gas.
    function test_sponsorsUserOp_endToEnd() public {
        uint256 depositBefore = paymaster.getDeposit();
        assertEq(address(account).balance, 0, "account should start with no ETH");

        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, signerKey);
        _handle(op);

        assertEq(address(account).balance, 0, "account must not have paid for gas");
        assertLt(paymaster.getDeposit(), depositBefore, "paymaster deposit must have funded the op");
        assertGt(beneficiary.balance, 0, "bundler must have been compensated");
    }

    function test_sponsorsUserOp_consumesAccountNonce() public {
        uint256 nonceBefore = entryPoint.getNonce(address(account), 0);

        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, signerKey);
        _handle(op);

        assertEq(entryPoint.getNonce(address(account), 0), nonceBefore + 1, "nonce must advance");
    }

    /// A sponsorship signature cannot be replayed, because the EntryPoint rejects the reused
    /// nonce it is bound to. This is the test that justifies not adding a paymaster-side nonce.
    function test_replayOfSameSignature_reverts() public {
        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, signerKey);
        _handle(op);

        // Same op, same signature, second submission. The EntryPoint rejects it on the nonce it
        // was bound to — which is precisely the mechanism a paymaster-side nonce would duplicate.
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA25 invalid account nonce"));
        _handle(op);
    }

    /*//////////////////////////////////////////////////////////////
                           SIGNATURE AUTHORISATION
    //////////////////////////////////////////////////////////////*/

    /// An unauthorised signer must produce SIG_VALIDATION_FAILED (EntryPoint error AA34), not a
    /// revert from inside the paymaster.
    function test_unauthorisedSigner_failsValidation() public {
        (, uint256 attackerKey) = makeAddrAndKey("attacker");
        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, attackerKey);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    function test_revokedSigner_failsValidation() public {
        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, signerKey);

        vm.prank(owner);
        paymaster.removeSigner(signer);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    /// Zero-downtime rotation: a signature from a newly added signer is honoured immediately.
    function test_rotatedSigner_isHonoured() public {
        (address newSigner, uint256 newKey) = makeAddrAndKey("newSigner");

        vm.startPrank(owner);
        paymaster.addSigner(newSigner);
        paymaster.removeSigner(signer);
        vm.stopPrank();

        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, newKey);
        _handle(op);

        assertEq(address(account).balance, 0, "rotated signer's sponsorship must be honoured");
    }

    /*//////////////////////////////////////////////////////////////
                          SIGNATURE BINDING / TAMPERING
    //////////////////////////////////////////////////////////////*/

    /// The reason `paymasterGasLimits` is in the signed struct: a bundler must not be able to
    /// inflate the postOp gas limit the paymaster committed to pay for.
    function test_tamperedPostOpGasLimit_failsValidation() public {
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), validUntil, 0, signerKey);

        // Re-pack paymasterAndData with an inflated postOp gas limit, keeping the signature.
        bytes memory sig = new bytes(65);
        for (uint256 i = 0; i < 65; i++) {
            sig[i] = op.paymasterAndData[64 + i];
        }
        op.paymasterAndData =
            abi.encodePacked(address(paymaster), PM_VERIFICATION_GAS, POSTOP_GAS * 10, validUntil, uint48(0), sig);
        op = _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    /// A signature must not survive callData being swapped out from under it.
    function test_tamperedCallData_failsValidation() public {
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), validUntil, 0, signerKey);

        op.callData = abi.encodeCall(SimpleAccount.execute, (target, 1 ether, ""));
        op = _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    /// EIP-712 binds the signature to this contract, so a signature produced for a sibling
    /// deployment — same signer, same chain, same UserOp — must not be accepted here.
    function test_signatureFromAnotherPaymaster_failsValidation() public {
        VerifyingPaymaster other = new VerifyingPaymaster(IEntryPoint(address(entryPoint)), owner, signer);
        assertTrue(
            paymaster.domainSeparator() != other.domainSeparator(),
            "sibling deployments must have distinct domain separators"
        );

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        PackedUserOperation memory op = _baseOp();

        // Sign the *other* paymaster's digest...
        op.paymasterAndData = abi.encodePacked(address(other), PM_VERIFICATION_GAS, POSTOP_GAS, validUntil, uint48(0));
        bytes32 otherDigest = other.getHash(op, validUntil, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, otherDigest);

        // ...then present it to this one.
        op.paymasterAndData = abi.encodePacked(_pmDataPrefix(validUntil, uint48(0)), r, s, v);
        op = _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    /// The same binding across chains: a signature minted on one chain must be worthless on
    /// another. This exercises OZ's EIP-712 chainId cache invalidation, not just our own code.
    function test_signatureFromAnotherChain_failsValidation() public {
        uint48 validUntil = uint48(block.timestamp + 1 hours);

        uint256 originalChainId = block.chainid;
        vm.chainId(8453); // Base
        bytes32 baseSeparator = paymaster.domainSeparator();

        PackedUserOperation memory op = _baseOp();
        op.paymasterAndData = _pmDataPrefix(validUntil, uint48(0));
        bytes32 digestOnBase = paymaster.getHash(op, validUntil, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digestOnBase);

        vm.chainId(originalChainId);
        assertTrue(paymaster.domainSeparator() != baseSeparator, "domain separator must track chainId");

        op.paymasterAndData = abi.encodePacked(_pmDataPrefix(validUntil, uint48(0)), r, s, v);
        op = _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    /*//////////////////////////////////////////////////////////////
                              TIME WINDOWS
    //////////////////////////////////////////////////////////////*/

    function test_expiredSponsorship_reverts() public {
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), validUntil, 0, signerKey);

        vm.warp(uint256(validUntil) + 1);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due"));
        _handle(op);
    }

    function test_notYetValidSponsorship_reverts() public {
        uint48 validAfter = uint48(block.timestamp + 1 hours);
        PackedUserOperation memory op =
            _sponsorAndSign(_baseOp(), uint48(block.timestamp + 2 hours), validAfter, signerKey);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due"));
        _handle(op);
    }

    /*//////////////////////////////////////////////////////////////
                                  PAUSE
    //////////////////////////////////////////////////////////////*/

    function test_pausedPaymaster_rejectsSponsorship() public {
        vm.prank(owner);
        paymaster.pause();

        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, signerKey);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(Pausable.EnforcedPause.selector)
            )
        );
        _handle(op);
    }

    function test_unpause_restoresSponsorship() public {
        vm.startPrank(owner);
        paymaster.pause();
        paymaster.unpause();
        vm.stopPrank();

        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, signerKey);
        _handle(op);

        assertEq(address(account).balance, 0, "sponsorship must work after unpause");
    }

    /*//////////////////////////////////////////////////////////////
                            ACCESS CONTROL
    //////////////////////////////////////////////////////////////*/

    function test_onlyOwnerCanPause() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        paymaster.pause();
    }

    function test_onlyOwnerCanAddSigner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        paymaster.addSigner(address(1));
    }

    /// Ownership must be two-step: a transfer to a typo'd address must not take effect.
    function test_ownershipTransferIsTwoStep() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(owner);
        paymaster.transferOwnership(newOwner);

        assertEq(paymaster.owner(), owner, "owner must not change before acceptance");
        assertEq(paymaster.pendingOwner(), newOwner, "transfer must be pending");

        vm.prank(newOwner);
        paymaster.acceptOwnership();
        assertEq(paymaster.owner(), newOwner, "owner must change after acceptance");
    }

    /*//////////////////////////////////////////////////////////////
                            MALFORMED INPUT
    //////////////////////////////////////////////////////////////*/

    function test_shortPaymasterData_reverts() public {
        bytes memory tooShort = abi.encodePacked(address(paymaster), PM_VERIFICATION_GAS, POSTOP_GAS);
        vm.expectRevert(abi.encodeWithSelector(VerifyingPaymaster.InvalidPaymasterDataLength.selector, 52));
        paymaster.parsePaymasterAndData(tooShort);
    }

    function test_wrongSignatureLength_reverts() public {
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        PackedUserOperation memory op = _baseOp();
        op.paymasterAndData = abi.encodePacked(_pmDataPrefix(validUntil, uint48(0)), hex"deadbeef");
        op = _signAccount(op);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(VerifyingPaymaster.InvalidSignatureLength.selector, 4)
            )
        );
        _handle(op);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(VerifyingPaymaster.ZeroAddress.selector);
        new VerifyingPaymaster(IEntryPoint(address(entryPoint)), address(0), signer);

        vm.expectRevert(VerifyingPaymaster.ZeroAddress.selector);
        new VerifyingPaymaster(IEntryPoint(address(entryPoint)), owner, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    /// Only the authorised key may sponsor, for any key the fuzzer can produce.
    function testFuzz_onlyAuthorisedSignerSponsors(
        uint256 key
    ) public {
        key = bound(key, 1, type(uint128).max);
        vm.assume(vm.addr(key) != signer);

        PackedUserOperation memory op = _sponsorAndSign(_baseOp(), uint48(block.timestamp + 1 hours), 0, key);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    /// The timestamps that come back out of paymasterAndData must be the ones that went in.
    function testFuzz_parsePaymasterAndDataRoundTrips(
        uint48 validUntil,
        uint48 validAfter
    ) public view {
        bytes memory data = abi.encodePacked(
            address(paymaster), PM_VERIFICATION_GAS, POSTOP_GAS, validUntil, validAfter, new bytes(65)
        );
        (uint48 gotUntil, uint48 gotAfter, bytes memory sig) = paymaster.parsePaymasterAndData(data);

        assertEq(gotUntil, validUntil, "validUntil must round-trip");
        assertEq(gotAfter, validAfter, "validAfter must round-trip");
        assertEq(sig.length, 65, "signature must be recovered intact");
    }
}
