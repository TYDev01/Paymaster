// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "account-abstraction/core/UserOperationLib.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title TenantPaymaster
/// @notice A verifying paymaster that holds a separate balance per tenant, so a customer's
///         operations are paid for out of the customer's own money.
///
/// @dev WHY THIS EXISTS ALONGSIDE VerifyingPaymaster
///
///      `VerifyingPaymaster` is the single-tenant contract: one operator, one shared deposit. This
///      is the multi-tenant one. They are separate contracts rather than one with a mode flag
///      because the difference is not a setting — this one takes `postOp` on every operation and
///      refuses a tenant with no balance, and imposing that on a single-tenant deployment would
///      make it pay for accounting it does not need.
///
/// @dev WHY BALANCES LIVE HERE RATHER THAN IN A CONTRACT PER TENANT
///
///      The EntryPoint's stake is per paymaster ADDRESS (`mapping(address => DepositInfo)`), and a
///      paymaster must be staked to read its own storage during validation. A contract per tenant
///      would therefore mean a full stake per tenant per chain, locked behind the unstake delay —
///      capital that secures nothing but that tenant's own reputation. One staked contract holding
///      a balance per tenant costs one stake per chain and still lets the CHAIN, rather than our
///      bookkeeping, enforce that only a tenant's own money pays for their operations.
///
/// @dev THE INVARIANT
///
///      `sum(balances) <= entryPoint.balanceOf(this)`.
///
///      Every credit to a tenant is accompanied by an equal deposit to the EntryPoint, and every
///      debit happens only where the EntryPoint has already charged us. If it ever failed, tenants
///      would collectively be owed more than the paymaster can actually pay, and the last one to
///      spend would find the deposit empty. It is asserted by an invariant test, not argued for.
///
/// @dev STORAGE ACCESS DURING VALIDATION
///
///      Validation reads and writes `_balances`, `_isSigner` and the pause flag — all storage of
///      this contract, which ERC-7562 permits only for a STAKED paymaster. This contract is
///      therefore unusable unstaked, exactly like its single-tenant sibling, and for the same reason.
contract TenantPaymaster is BasePaymaster, Ownable2Step, Pausable, EIP712 {
    using UserOperationLib for PackedUserOperation;

    /*//////////////////////////////////////////////////////////////
                                 LAYOUT
    //////////////////////////////////////////////////////////////*/

    // paymasterAndData:
    //   [0  : 20]  paymaster address            (EntryPoint's layout)
    //   [20 : 36]  paymasterVerificationGasLimit
    //   [36 : 52]  postOpGasLimit
    //   [52 : 58]  validUntil
    //   [58 : 64]  validAfter
    //   [64 : 96]  tenant                       <-- added here
    //   [96 :   ]  signature
    uint256 internal constant VALID_UNTIL_OFFSET = 52;
    uint256 internal constant VALID_AFTER_OFFSET = 58;
    uint256 internal constant TENANT_OFFSET = 64;
    uint256 internal constant SIGNATURE_OFFSET = 96;

    /// @dev The tenant is INSIDE the signed digest. Without that, a caller holding one valid
    ///      attestation could edit the tenant field and spend a different customer's balance.
    bytes32 private constant SPONSORSHIP_TYPEHASH = keccak256(
        "Sponsorship(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 paymasterGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes32 tenant,uint48 validUntil,uint48 validAfter)"
    );

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    mapping(address signer => bool authorised) private _isSigner;
    uint256 public signerCount;

    /// @dev Wei credited to each tenant. The sum of these may never exceed the EntryPoint deposit.
    mapping(bytes32 tenant => uint256 balance) private _balances;

    /// @dev Running total of `_balances`, maintained rather than computed: a mapping cannot be
    ///      summed on chain, and the invariant needs the total to be readable in O(1).
    uint256 public totalTenantBalance;

    /// @notice Who may withdraw a tenant's balance, besides the owner.
    /// @dev Unset means only the owner can. Setting it is how a customer is given the ability to
    ///      take their own money out without asking us — which is the difference between a balance
    ///      that is theirs and a balance we say is theirs.
    mapping(bytes32 tenant => address controller) public controllerOf;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event SignerAdded(address indexed signer, address indexed by);
    event SignerRemoved(address indexed signer, address indexed by);
    event TenantDeposited(bytes32 indexed tenant, address indexed from, uint256 amount, uint256 balance);
    event TenantWithdrawn(bytes32 indexed tenant, address indexed to, uint256 amount, uint256 balance);
    event TenantCharged(bytes32 indexed tenant, uint256 reserved, uint256 charged, uint256 balance);
    event ControllerSet(bytes32 indexed tenant, address indexed controller);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error SignerAlreadyAuthorised(address signer);
    error SignerNotAuthorised(address signer);
    error InvalidPaymasterDataLength(uint256 length);
    error InvalidSignatureLength(uint256 length);
    error ZeroTenant();
    error InsufficientTenantBalance(bytes32 tenant, uint256 balance, uint256 required);
    error NotTenantController(bytes32 tenant, address caller);
    error NothingToWithdraw();

    constructor(
        IEntryPoint entryPoint_,
        address owner_,
        address initialSigner
    ) BasePaymaster(entryPoint_) EIP712("TenantPaymaster", "1") {
        if (owner_ == address(0)) revert ZeroAddress();
        if (initialSigner == address(0)) revert ZeroAddress();

        _addSigner(initialSigner);
        _transferOwnership(owner_);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUNDING
    //////////////////////////////////////////////////////////////*/

    /// @notice Credit a tenant's balance, and deposit the same amount with the EntryPoint.
    /// @dev Ungated on purpose: anyone may fund a tenant. Refilling is not a privileged action, and
    ///      requiring the owner would put us in the path of every customer's top-up.
    ///
    ///      The two moves are inseparable — the credit and the deposit happen together, which is
    ///      what keeps `sum(balances) <= deposit` true by construction rather than by reconciliation.
    function depositFor(
        bytes32 tenant
    ) public payable {
        if (tenant == bytes32(0)) revert ZeroTenant();

        _balances[tenant] += msg.value;
        totalTenantBalance += msg.value;
        entryPoint.depositTo{value: msg.value}(address(this));

        emit TenantDeposited(tenant, msg.sender, msg.value, _balances[tenant]);
    }

    /// @notice A tenant's remaining balance, in wei.
    function balanceOf(
        bytes32 tenant
    ) external view returns (uint256) {
        return _balances[tenant];
    }

    /// @notice Nominate who may withdraw a tenant's balance.
    /// @dev Owner-only, because the mapping from a tenant id to a customer lives off chain — this
    ///      contract cannot tell who "should" control `t_acme`. Handing control over is therefore a
    ///      deliberate act by the platform, and once done the customer can take their money without
    ///      further permission.
    function setController(
        bytes32 tenant,
        address controller
    ) external onlyOwner {
        if (tenant == bytes32(0)) revert ZeroTenant();
        controllerOf[tenant] = controller;
        emit ControllerSet(tenant, controller);
    }

    /// @notice Withdraw part of a tenant's balance from the EntryPoint deposit.
    /// @dev Debits the tenant BEFORE moving funds, so a re-entrant call sees the reduced balance
    ///      and cannot withdraw twice. `withdrawTo` on the EntryPoint sends value to `to`, which
    ///      may be a contract, so this ordering is load-bearing rather than stylistic.
    function withdrawFor(
        bytes32 tenant,
        address payable to,
        uint256 amount
    ) external {
        address controller = controllerOf[tenant];
        if (msg.sender != owner() && msg.sender != controller) revert NotTenantController(tenant, msg.sender);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingToWithdraw();

        uint256 balance = _balances[tenant];
        if (balance < amount) revert InsufficientTenantBalance(tenant, balance, amount);

        unchecked {
            _balances[tenant] = balance - amount;
            totalTenantBalance -= amount;
        }

        entryPoint.withdrawTo(to, amount);
        emit TenantWithdrawn(tenant, to, amount, _balances[tenant]);
    }

    /*//////////////////////////////////////////////////////////////
                                VALIDATION
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc BasePaymaster
    /// @dev Reserves `maxCost` from the tenant's balance and returns a context so `postOp` can
    ///      refund the difference. Reserving the WORST CASE rather than charging the actual cost is
    ///      the only safe order: the actual cost is not known until after execution, and a paymaster
    ///      that checked a balance without holding it would let two concurrent operations both pass
    ///      a check that only one of them could afford.
    ///
    ///      A reservation only persists if the operation is included — validation state is discarded
    ///      with the rest of the transaction otherwise — so an abandoned operation costs the tenant
    ///      nothing.
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32, /* userOpHash */
        uint256 maxCost
    ) internal override whenNotPaused returns (bytes memory context, uint256 validationData) {
        (uint48 validUntil, uint48 validAfter, bytes32 tenant, bytes calldata signature) =
            parsePaymasterAndData(userOp.paymasterAndData);

        if (signature.length != 64 && signature.length != 65) {
            revert InvalidSignatureLength(signature.length);
        }

        bytes32 digest = _hashTypedDataV4(_sponsorshipStructHash(userOp, tenant, validUntil, validAfter));

        // A bad signature must NOT revert: ERC-4337 requires SIG_VALIDATION_FAILED so the bundler
        // drops the operation without the whole bundle reverting.
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || !_isSigner[recovered]) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        // Insufficient balance DOES revert, unlike a bad signature. The backend only signs for a
        // tenant it believes can pay, so reaching here means the balance moved between signing and
        // inclusion — a real error worth surfacing, rather than a routine rejection. The cost is
        // that a bundler counts it against this paymaster's reputation, which is the right trade for
        // an event that should be rare.
        uint256 balance = _balances[tenant];
        if (balance < maxCost) revert InsufficientTenantBalance(tenant, balance, maxCost);

        unchecked {
            _balances[tenant] = balance - maxCost;
            totalTenantBalance -= maxCost;
        }

        // postOpGasLimit is carried through so the refund can account for the gas the EntryPoint
        // will charge for postOp itself — see _postOp.
        uint128 postOpGasLimit = uint128(bytes16(userOp.paymasterAndData[36:52]));
        return (abi.encode(tenant, maxCost, postOpGasLimit), _packValidationData(false, validUntil, validAfter));
    }

    /// @inheritdoc BasePaymaster
    /// @dev Refunds what the operation did not use.
    ///
    ///      `actualGasCost` EXCLUDES the gas the EntryPoint will charge for this very `postOp` call —
    ///      it cannot include it, because that gas is still being spent. Refunding
    ///      `reserved - actualGasCost` would therefore hand back money the EntryPoint is about to
    ///      take from the deposit, and `sum(balances)` would creep above the deposit one operation
    ///      at a time until the invariant broke.
    ///
    ///      So the charge assumes postOp uses its FULL limit. That slightly over-charges the tenant
    ///      — by the unused part of a limit the tenant themselves chose — and errs in the only
    ///      direction that keeps the contract solvent.
    function _postOp(
        PostOpMode, /* mode */
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) internal override {
        (bytes32 tenant, uint256 reserved, uint128 postOpGasLimit) = abi.decode(context, (bytes32, uint256, uint128));

        uint256 charge = actualGasCost + (uint256(postOpGasLimit) * actualUserOpFeePerGas);
        // Never refund more than was reserved, whatever the arithmetic above produces.
        if (charge > reserved) charge = reserved;

        uint256 refund = reserved - charge;
        if (refund > 0) {
            _balances[tenant] += refund;
            totalTenantBalance += refund;
        }

        emit TenantCharged(tenant, reserved, charge, _balances[tenant]);
    }

    /*//////////////////////////////////////////////////////////////
                                  HASHING
    //////////////////////////////////////////////////////////////*/

    /// @notice The EIP-712 digest the backend must sign to sponsor `userOp` for `tenant`.
    function getHash(
        PackedUserOperation calldata userOp,
        bytes32 tenant,
        uint48 validUntil,
        uint48 validAfter
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_sponsorshipStructHash(userOp, tenant, validUntil, validAfter));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _sponsorshipStructHash(
        PackedUserOperation calldata userOp,
        bytes32 tenant,
        uint48 validUntil,
        uint48 validAfter
    ) private pure returns (bytes32) {
        uint256 paymasterGasLimits = uint256(
            bytes32(
                userOp.paymasterAndData[UserOperationLib.PAYMASTER_VALIDATION_GAS_OFFSET:UserOperationLib.PAYMASTER_DATA_OFFSET

                ]
            )
        );

        return keccak256(
            abi.encode(
                SPONSORSHIP_TYPEHASH,
                userOp.getSender(),
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                paymasterGasLimits,
                userOp.preVerificationGas,
                userOp.gasFees,
                tenant,
                validUntil,
                validAfter
            )
        );
    }

    /// @notice Decode the paymaster-specific tail of `paymasterAndData`.
    function parsePaymasterAndData(
        bytes calldata paymasterAndData
    ) public pure returns (uint48 validUntil, uint48 validAfter, bytes32 tenant, bytes calldata signature) {
        if (paymasterAndData.length < SIGNATURE_OFFSET) {
            revert InvalidPaymasterDataLength(paymasterAndData.length);
        }
        validUntil = uint48(bytes6(paymasterAndData[VALID_UNTIL_OFFSET:VALID_AFTER_OFFSET]));
        validAfter = uint48(bytes6(paymasterAndData[VALID_AFTER_OFFSET:TENANT_OFFSET]));
        tenant = bytes32(paymasterAndData[TENANT_OFFSET:SIGNATURE_OFFSET]);
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    /*//////////////////////////////////////////////////////////////
                             SIGNER MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    function isSigner(
        address signer
    ) external view returns (bool) {
        return _isSigner[signer];
    }

    function addSigner(
        address signer
    ) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        if (_isSigner[signer]) revert SignerAlreadyAuthorised(signer);
        _addSigner(signer);
    }

    /// @dev Signatures already issued by `signer` and still inside their window become invalid
    ///      immediately. Rotate by adding the replacement first and letting the old one expire.
    function removeSigner(
        address signer
    ) external onlyOwner {
        if (!_isSigner[signer]) revert SignerNotAuthorised(signer);
        _isSigner[signer] = false;
        unchecked {
            --signerCount;
        }
        emit SignerRemoved(signer, msg.sender);
    }

    function _addSigner(
        address signer
    ) private {
        _isSigner[signer] = true;
        unchecked {
            ++signerCount;
        }
        emit SignerAdded(signer, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                              EMERGENCY STOP
    //////////////////////////////////////////////////////////////*/

    /// @notice Halt all sponsorship immediately. Balances are untouched and remain withdrawable.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                          INHERITANCE RESOLUTION
    //////////////////////////////////////////////////////////////*/

    /// @dev BasePaymaster brings in single-step `Ownable`; `Ownable2Step` is layered on top so a
    ///      transfer to a mistyped address does not brick the contract.
    function transferOwnership(
        address newOwner
    ) public override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(
        address newOwner
    ) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }
}
