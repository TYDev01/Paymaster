// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {UserOperationLib} from "account-abstraction/core/UserOperationLib.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title VerifyingPaymaster
/// @notice ERC-4337 (EntryPoint v0.7) paymaster that sponsors a UserOperation when an
///         off-chain signer, controlled by the sponsorship backend, has attested to it.
///
/// @dev Trust model: this contract does not decide *whether* to sponsor. It only proves that
///      an authorised signer agreed to sponsor this exact UserOperation within a time window.
///      All policy (quotas, allowlists, spend caps) lives off-chain in the backend policy engine;
///      this contract is the enforcement boundary that makes those decisions unforgeable.
///
/// @dev Replay protection is inherited rather than reimplemented, and deliberately so. A
///      signature is bound to:
///        - `sender` + `nonce`  -> the EntryPoint rejects a reused nonce, so a signature cannot
///                                 be replayed for the same account twice;
///        - `chainId`           -> via the EIP-712 domain separator;
///        - `address(this)`     -> via the EIP-712 domain separator, so a signature for one
///                                 chain's paymaster is invalid on every other deployment.
///      A paymaster-side nonce would add an SSTORE (~20k gas) to every sponsored operation while
///      closing no window that the above does not already close.
///
/// @dev Storage access during validation: reading `_isSigner` and the `Pausable` flag are SLOADs
///      of this contract's own storage. ERC-4337 permits this only for a *staked* paymaster, so
///      this contract MUST have stake on the EntryPoint before bundlers will accept its
///      operations. See `addStake`.
contract VerifyingPaymaster is BasePaymaster, Ownable2Step, Pausable, EIP712 {
    using UserOperationLib for PackedUserOperation;

    /*//////////////////////////////////////////////////////////////
                          PAYMASTER-AND-DATA LAYOUT
    //////////////////////////////////////////////////////////////*/

    /// @dev `paymasterAndData` is laid out as:
    ///        [0:20]   paymaster address                     (enforced by EntryPoint)
    ///        [20:36]  paymasterVerificationGasLimit         (enforced by EntryPoint)
    ///        [36:52]  postOpGasLimit                        (enforced by EntryPoint)
    ///        [52:58]  validUntil   (uint48, big-endian)
    ///        [58:64]  validAfter   (uint48, big-endian)
    ///        [64:]    signature    (65-byte ECDSA, or 64-byte EIP-2098 compact)
    ///
    ///      The two timestamps are packed into 6 bytes each rather than ABI-encoded into a
    ///      32-byte word each. This is not cosmetic: four of the six target chains are L2s where
    ///      calldata is posted to L1 and dominates the fee. Packing saves 52 calldata bytes on
    ///      every sponsored operation.
    uint256 private constant VALID_UNTIL_OFFSET = UserOperationLib.PAYMASTER_DATA_OFFSET; // 52
    uint256 private constant VALID_AFTER_OFFSET = VALID_UNTIL_OFFSET + 6; // 58
    uint256 private constant SIGNATURE_OFFSET = VALID_AFTER_OFFSET + 6; // 64

    /// @dev EIP-712 struct hash for a sponsorship attestation.
    ///      `chainId` and `verifyingContract` are supplied by the EIP-712 domain separator and so
    ///      are intentionally absent from the struct itself.
    ///      `paymasterGasLimits` covers `paymasterAndData[20:52]`, binding the signature to the
    ///      gas limits the paymaster is committing to pay for. Without it a bundler could inflate
    ///      `postOpGasLimit` against a signature that never agreed to it.
    bytes32 private constant SPONSORSHIP_TYPEHASH = keccak256(
        "Sponsorship(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,"
        "bytes32 accountGasLimits,uint256 paymasterGasLimits,uint256 preVerificationGas,"
        "bytes32 gasFees,uint48 validUntil,uint48 validAfter)"
    );

    /*//////////////////////////////////////////////////////////////
                                  STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Signers authorised to attest to sponsorships.
    /// @dev A set rather than a single address so keys can be rotated with zero downtime: add the
    ///      new signer, drain in-flight signatures from the old one, then remove the old one.
    mapping(address signer => bool authorised) private _isSigner;

    /// @notice Number of currently authorised signers. Exposed for operational alerting.
    uint256 public signerCount;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Deposit, withdrawal, and stake events are intentionally NOT re-emitted here. The
    ///      EntryPoint's StakeManager already emits `Deposited`, `Withdrawn`, `StakeLocked`,
    ///      `StakeUnlocked`, and `StakeWithdrawn`, each indexed by `account` — which is this
    ///      contract's address. The deposit monitor subscribes to those, filtered by paymaster.
    ///      Mirroring them here would cost gas to publish strictly less information.
    event SignerAdded(address indexed signer, address indexed by);
    event SignerRemoved(address indexed signer, address indexed by);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error SignerAlreadyAuthorised(address signer);
    error SignerNotAuthorised(address signer);
    error InvalidPaymasterDataLength(uint256 length);
    error InvalidSignatureLength(uint256 length);
    error InvalidTimeRange(uint48 validUntil, uint48 validAfter);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param entryPoint_ The EntryPoint v0.7 deployment for this chain.
    /// @param owner_      Address that will own the paymaster. Should be a multisig in production.
    /// @param initialSigner The first authorised sponsorship signer.
    constructor(
        IEntryPoint entryPoint_,
        address owner_,
        address initialSigner
    ) BasePaymaster(entryPoint_) EIP712("VerifyingPaymaster", "1") {
        if (owner_ == address(0)) revert ZeroAddress();
        if (initialSigner == address(0)) revert ZeroAddress();

        _addSigner(initialSigner);

        // BasePaymaster's constructor sets the deployer as owner; hand off to the real owner.
        // Done directly rather than via the two-step flow because there is no one to accept yet.
        _transferOwnership(owner_);
    }

    /*//////////////////////////////////////////////////////////////
                                VALIDATION
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc BasePaymaster
    /// @dev Returns an empty context, so the EntryPoint will not call `postOp` at all. A verifying
    ///      paymaster has nothing to settle after execution: sponsorship was already decided at
    ///      signing time, and actual gas cost is available off-chain from the EntryPoint's
    ///      `UserOperationEvent`. Returning a context would add a second paymaster call to every
    ///      operation to record data we can already observe for free.
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32, /* userOpHash */
        uint256 /* maxCost */
    ) internal view override whenNotPaused returns (bytes memory context, uint256 validationData) {
        (uint48 validUntil, uint48 validAfter, bytes calldata signature) =
            parsePaymasterAndData(userOp.paymasterAndData);

        // ECDSA.recover accepts 65-byte and 64-byte (EIP-2098) signatures. Checking here means an
        // operator debugging a malformed request sees this contract's error, not ECDSA's.
        if (signature.length != 64 && signature.length != 65) {
            revert InvalidSignatureLength(signature.length);
        }

        bytes32 digest = _hashTypedDataV4(_sponsorshipStructHash(userOp, validUntil, validAfter));

        // A bad signature must NOT revert: ERC-4337 requires returning SIG_VALIDATION_FAILED so
        // the bundler can drop the operation without the whole bundle reverting.
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        bool sigFailed = err != ECDSA.RecoverError.NoError || !_isSigner[recovered];

        return ("", _packValidationData(sigFailed, validUntil, validAfter));
    }

    /*//////////////////////////////////////////////////////////////
                                  HASHING
    //////////////////////////////////////////////////////////////*/

    /// @notice The EIP-712 digest the backend must sign to sponsor `userOp`.
    /// @dev Exposed so the signing service and integration tests derive the digest from the
    ///      contract itself rather than from a reimplementation that can silently drift.
    ///      `userOp.paymasterAndData` need only be populated through byte 52; the signature tail
    ///      is not covered by the hash (it cannot be — it is the thing being produced).
    function getHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_sponsorshipStructHash(userOp, validUntil, validAfter));
    }

    /// @notice The EIP-712 domain separator for this deployment.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _sponsorshipStructHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SPONSORSHIP_TYPEHASH,
                userOp.getSender(),
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(
                    bytes32(
                        userOp.paymasterAndData[UserOperationLib.PAYMASTER_VALIDATION_GAS_OFFSET:
                            UserOperationLib.PAYMASTER_DATA_OFFSET]
                    )
                ),
                userOp.preVerificationGas,
                userOp.gasFees,
                validUntil,
                validAfter
            )
        );
    }

    /// @notice Decode the paymaster-specific tail of `paymasterAndData`.
    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public
        pure
        returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
    {
        // Checked explicitly: a bare calldata slice on a short buffer reverts with no reason data,
        // which is opaque to debug from a failed simulation.
        if (paymasterAndData.length < SIGNATURE_OFFSET) {
            revert InvalidPaymasterDataLength(paymasterAndData.length);
        }
        validUntil = uint48(bytes6(paymasterAndData[VALID_UNTIL_OFFSET:VALID_AFTER_OFFSET]));
        validAfter = uint48(bytes6(paymasterAndData[VALID_AFTER_OFFSET:SIGNATURE_OFFSET]));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    /*//////////////////////////////////////////////////////////////
                             SIGNER MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    function isSigner(address signer) external view returns (bool) {
        return _isSigner[signer];
    }

    /// @notice Authorise a new sponsorship signer.
    function addSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        if (_isSigner[signer]) revert SignerAlreadyAuthorised(signer);
        _addSigner(signer);
    }

    /// @notice Revoke a sponsorship signer.
    /// @dev Signatures already issued by `signer` and still inside their validity window become
    ///      invalid immediately. Rotate by adding the replacement first and letting in-flight
    ///      signatures expire before revoking.
    ///      Revoking the last signer is permitted: it halts sponsorship, and is recoverable by the
    ///      owner adding a signer. It is not a lockout.
    function removeSigner(address signer) external onlyOwner {
        if (!_isSigner[signer]) revert SignerNotAuthorised(signer);
        _isSigner[signer] = false;
        unchecked {
            --signerCount;
        }
        emit SignerRemoved(signer, msg.sender);
    }

    function _addSigner(address signer) private {
        _isSigner[signer] = true;
        unchecked {
            ++signerCount;
        }
        emit SignerAdded(signer, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                              EMERGENCY PAUSE
    //////////////////////////////////////////////////////////////*/

    /// @notice Halt all sponsorship. Deposits and withdrawals remain available.
    /// @dev Pausing does not strand in-flight operations' funds; it only stops validation from
    ///      succeeding, so affected operations are dropped by bundlers rather than executed.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                         DEPOSIT / STAKE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev `deposit`, `withdrawTo`, `addStake`, `unlockStake`, and `withdrawStake` are inherited
    ///      from BasePaymaster unchanged. They are non-virtual there, and re-implementing them
    ///      would be wrong regardless: the owner-gating and EntryPoint forwarding are already
    ///      correct, and the EntryPoint emits the events an operator needs.
    ///
    ///      Note that stake is not optional for this contract. It reads its own storage during
    ///      validation (`_isSigner`, the pause flag), which ERC-4337 permits only for a staked
    ///      paymaster. An unstaked deployment will have its operations rejected by bundlers.

    /// @notice Accept plain ETH transfers as deposits, so an automated refill can be a bare send.
    receive() external payable {
        deposit();
    }

    /*//////////////////////////////////////////////////////////////
                          INHERITANCE RESOLUTION
    //////////////////////////////////////////////////////////////*/

    /// @dev BasePaymaster brings in single-step `Ownable`; `Ownable2Step` is layered on top so a
    ///      typo'd owner address cannot brick administration of a funded paymaster.

    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }
}
