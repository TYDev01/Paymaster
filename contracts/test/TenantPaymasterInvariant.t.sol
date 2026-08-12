// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {SimpleAccountFactory} from "account-abstraction/samples/SimpleAccountFactory.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {TenantPaymaster} from "../src/TenantPaymaster.sol";

/// @notice The solvency invariant, under arbitrary sequences of funding, spending and withdrawal.
///
/// @dev `sum(tenant balances) <= entryPoint.balanceOf(paymaster)`.
///
///      Example-based tests check the sequences someone thought of. This checks the ones nobody
///      did — deposits interleaved with sponsorships interleaved with withdrawals, in orders and
///      amounts chosen by the fuzzer — because the way an accounting bug actually reaches
///      production is a combination no one wrote a test for.
///
///      If it ever fails, tenants are collectively owed more than the contract can pay, and the
///      last customer to spend finds the deposit empty while their balance still reads healthy.
///      That is the failure this contract exists to make impossible, so it is asserted rather than
///      argued for.
contract TenantPaymasterInvariantTest is Test {
    PaymasterHandler internal handler;
    TenantPaymaster internal paymaster;
    EntryPoint internal entryPoint;

    function setUp() public {
        entryPoint = new EntryPoint();
        SimpleAccountFactory factory = new SimpleAccountFactory(entryPoint);

        (address signer, uint256 signerKey) = makeAddrAndKey("signer");
        (address accountOwner, uint256 accountOwnerKey) = makeAddrAndKey("accountOwner");
        SimpleAccount account = factory.createAccount(accountOwner, 0);

        address owner = makeAddr("owner");
        paymaster = new TenantPaymaster(IEntryPoint(address(entryPoint)), owner, signer);

        vm.deal(owner, 100 ether);
        vm.prank(owner);
        paymaster.addStake{value: 1 ether}(1 days);

        handler = new PaymasterHandler(entryPoint, paymaster, account, owner, signerKey, accountOwnerKey);
        vm.deal(address(handler), 10_000 ether);

        // Only the handler drives the system, so every call is a valid sequence a real user could
        // produce — a fuzzer calling the paymaster directly would spend most of its runs bouncing
        // off access control instead of exploring the accounting.
        targetContract(address(handler));
    }

    /// @dev The one that matters: the contract can never owe more than it holds.
    function invariant_neverOwesMoreThanItHolds() public view {
        assertLe(
            paymaster.totalTenantBalance(),
            entryPoint.balanceOf(address(paymaster)),
            "tenants are owed more than the EntryPoint deposit can pay"
        );
    }

    /// @dev The running total must equal the sum of the parts, or the invariant above is measuring
    ///      a number that has drifted from the balances it claims to summarise.
    function invariant_totalEqualsTheSumOfBalances() public view {
        uint256 sum = 0;
        bytes32[] memory tenants = handler.tenants();
        for (uint256 i = 0; i < tenants.length; i++) {
            sum += paymaster.balanceOf(tenants[i]);
        }
        assertEq(paymaster.totalTenantBalance(), sum, "the running total drifted from the balances");
    }

    /// @dev Proof that the run above was worth anything.
    ///
    ///      The handler swallows failed sponsorships on purpose — an underfunded tenant SHOULD be
    ///      refused, and the invariant has to hold across those attempts too. But that means a
    ///      handler where every single attempt failed would satisfy all three invariants while
    ///      exercising none of the spending path, which is what the first version of this file
    ///      actually did: every one of the 16384 calls was refused, and all three invariants passed.
    ///
    ///      Foundry reverts state between runs, so these counters are per-run and this bar has to be
    ///      one a single run can clear. `fundAndSponsor` is what clears it: it tops the tenant up
    ///      first, so it lands whenever it is called at all.
    function afterInvariant() public view {
        assertGt(handler.sponsorshipsLanded(), 0, "no sponsorship ever landed: the invariants proved nothing");
    }

    /// @dev No tenant may end up owed money that came out of another tenant's pocket. Ghost
    ///      accounting: what the handler put in, minus what it took out, bounds what can remain.
    function invariant_noTenantHoldsMoreThanWasPutIn() public view {
        bytes32[] memory tenants = handler.tenants();
        for (uint256 i = 0; i < tenants.length; i++) {
            bytes32 tenant = tenants[i];
            assertLe(
                paymaster.balanceOf(tenant),
                handler.deposited(tenant) - handler.withdrawn(tenant),
                "a tenant's balance exceeds what was ever deposited for it"
            );
        }
    }
}

/// @notice Drives the paymaster the way real users would, and records what it did.
contract PaymasterHandler is Test {
    EntryPoint internal immutable ENTRY_POINT;
    TenantPaymaster internal immutable PAYMASTER;
    SimpleAccount internal immutable ACCOUNT;
    address internal immutable OWNER;
    uint256 internal immutable SIGNER_KEY;
    uint256 internal immutable ACCOUNT_OWNER_KEY;

    bytes32[] private _tenants;
    mapping(bytes32 => uint256) public deposited;
    mapping(bytes32 => uint256) public withdrawn;

    /// @dev Counted because the sponsor paths swallow reverts, and a handler whose every attempt
    ///      failed would satisfy every invariant here trivially. See `afterInvariant`.
    uint256 public sponsorshipsLanded;
    uint256 public sponsorshipsRejected;

    uint128 internal constant VERIFICATION_GAS = 300_000;
    uint128 internal constant CALL_GAS = 100_000;
    uint128 internal constant PM_VERIFICATION_GAS = 200_000;
    uint128 internal constant POSTOP_GAS = 40_000;
    uint256 internal constant PRE_VERIFICATION_GAS = 50_000;

    constructor(
        EntryPoint entryPoint_,
        TenantPaymaster paymaster_,
        SimpleAccount account_,
        address owner_,
        uint256 signerKey_,
        uint256 accountOwnerKey_
    ) {
        ENTRY_POINT = entryPoint_;
        PAYMASTER = paymaster_;
        ACCOUNT = account_;
        OWNER = owner_;
        SIGNER_KEY = signerKey_;
        ACCOUNT_OWNER_KEY = accountOwnerKey_;

        // Three tenants: enough for one to spend another's money if the accounting is wrong, few
        // enough that the fuzzer revisits each often.
        _tenants.push(keccak256("t_one"));
        _tenants.push(keccak256("t_two"));
        _tenants.push(keccak256("t_three"));
    }

    function tenants() external view returns (bytes32[] memory) {
        return _tenants;
    }

    function fund(
        uint256 tenantSeed,
        uint256 amount
    ) external {
        bytes32 tenant = _tenant(tenantSeed);
        amount = bound(amount, 0.001 ether, 5 ether);
        if (address(this).balance < amount) return;

        PAYMASTER.depositFor{value: amount}(tenant);
        deposited[tenant] += amount;
    }

    /// @dev Sponsors a real operation through the real EntryPoint. Reverts are swallowed because an
    ///      underfunded tenant SHOULD fail, and the invariant must hold across those attempts too —
    ///      a failed sponsorship that left a reservation behind is exactly the kind of leak this is
    ///      looking for.
    function sponsor(
        uint256 tenantSeed,
        uint128 maxFee
    ) external {
        _sponsor(_tenant(tenantSeed), uint128(bound(uint256(maxFee), 1 gwei, 50 gwei)));
    }

    /// @dev The path a paying customer is actually on: top up, then spend. Distinct from `sponsor`
    ///      because that one is at the mercy of whatever the fuzzer funded, and a run in which it
    ///      never once succeeded is a run that proved nothing.
    function fundAndSponsor(
        uint256 tenantSeed,
        uint128 maxFee
    ) external {
        bytes32 tenant = _tenant(tenantSeed);
        uint128 fee = uint128(bound(uint256(maxFee), 1 gwei, 50 gwei));

        // What the EntryPoint will demand up front, from its own `_getRequiredPrefund`. Funded at
        // twice that so the reservation is comfortably covered.
        uint256 required =
            uint256(VERIFICATION_GAS + CALL_GAS + PM_VERIFICATION_GAS + POSTOP_GAS + PRE_VERIFICATION_GAS) * fee;
        if (PAYMASTER.balanceOf(tenant) < required && address(this).balance >= required * 2) {
            PAYMASTER.depositFor{value: required * 2}(tenant);
            deposited[tenant] += required * 2;
        }

        _sponsor(tenant, fee);
    }

    function _sponsor(
        bytes32 tenant,
        uint128 fee
    ) private {
        PackedUserOperation memory op = _sponsored(tenant, ACCOUNT.getNonce(), fee);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;

        try ENTRY_POINT.handleOps(ops, payable(address(0xbeef))) {
            sponsorshipsLanded += 1;
        } catch {
            sponsorshipsRejected += 1;
        }
    }

    function withdraw(
        uint256 tenantSeed,
        uint256 amount
    ) external {
        bytes32 tenant = _tenant(tenantSeed);
        uint256 balance = PAYMASTER.balanceOf(tenant);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);

        vm.prank(OWNER);
        PAYMASTER.withdrawFor(tenant, payable(address(0xdead)), amount);
        withdrawn[tenant] += amount;
    }

    /// @dev A deposit that credits NO tenant. It is allowed (BasePaymaster.deposit is ungated) and
    ///      only ever makes the invariant more comfortably true — but if the invariant were written
    ///      backwards, this is what would expose it.
    function depositWithoutTenant(
        uint256 amount
    ) external {
        amount = bound(amount, 0.001 ether, 1 ether);
        if (address(this).balance < amount) return;
        PAYMASTER.deposit{value: amount}();
    }

    function _tenant(
        uint256 seed
    ) private view returns (bytes32) {
        return _tenants[seed % _tenants.length];
    }

    function _sponsored(
        bytes32 tenant,
        uint256 nonce,
        uint128 maxFee
    ) private view returns (PackedUserOperation memory op) {
        op = PackedUserOperation({
            sender: address(ACCOUNT),
            nonce: nonce,
            initCode: "",
            callData: abi.encodeCall(SimpleAccount.execute, (address(0xdead), 0, "")),
            accountGasLimits: bytes32((uint256(VERIFICATION_GAS) << 128) | CALL_GAS),
            preVerificationGas: PRE_VERIFICATION_GAS,
            gasFees: bytes32((uint256(1 gwei) << 128) | maxFee),
            paymasterAndData: "",
            signature: ""
        });

        op.paymasterAndData =
            abi.encodePacked(address(PAYMASTER), PM_VERIFICATION_GAS, POSTOP_GAS, uint48(0), uint48(0), tenant);

        bytes32 digest = PAYMASTER.getHash(op, tenant, 0, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, r, s, v);

        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(ENTRY_POINT.getUserOpHash(op));
        (v, r, s) = vm.sign(ACCOUNT_OWNER_KEY, hash);
        op.signature = abi.encodePacked(r, s, v);
    }

    receive() external payable {}
}
