import {keccak256, toHex, type Hex} from "viem";

import type {TenantId} from "../db/scope.js";

/**
 * Which paymaster contract a chain is configured with.
 *
 * There are two, deliberately. `VerifyingPaymaster` is the single-tenant contract: one operator,
 * one shared deposit, no `postOp`. `TenantPaymaster` holds a balance per tenant and settles against
 * it after every operation. They are not interchangeable at the byte level — the tenant one carries
 * 32 extra bytes in `paymasterAndData` and a different EIP-712 type — so the backend has to know
 * which one it is signing for. Guessing from the presence of a tenant would mean a forgotten field
 * silently produces a well-formed signature for the wrong contract.
 */
export type PaymasterKind = "verifying" | "tenant";

/**
 * The byte-level and EIP-712 differences between the two contracts, as data rather than as branches
 * scattered through the codec.
 *
 * The contracts remain the source of truth for all of it. `differential.test.ts` asserts every field
 * here against real deployed bytecode for both kinds, so a drift fails the build rather than every
 * sponsorship at runtime.
 */
export interface PaymasterLayout {
  readonly kind: PaymasterKind;
  /** Must match `EIP712(name, "1")` in the contract's constructor. */
  readonly domainName: string;
  /** Where the signature tail begins, and therefore the minimum length of a valid buffer. */
  readonly signatureOffset: number;
  /** EIP-712 struct fields, in the order the contract's typehash declares them. */
  readonly types: {readonly Sponsorship: readonly {readonly name: string; readonly type: string}[]};
}

/**
 * Shared by both contracts. Field ORDER is part of the type hash: reordering these silently changes
 * the digest and invalidates every signature.
 */
const COMMON_FIELDS = [
  {name: "sender", type: "address"},
  {name: "nonce", type: "uint256"},
  {name: "initCodeHash", type: "bytes32"},
  {name: "callDataHash", type: "bytes32"},
  {name: "accountGasLimits", type: "bytes32"},
  {name: "paymasterGasLimits", type: "uint256"},
  {name: "preVerificationGas", type: "uint256"},
  {name: "gasFees", type: "bytes32"},
] as const;

const WINDOW_FIELDS = [
  {name: "validUntil", type: "uint48"},
  {name: "validAfter", type: "uint48"},
] as const;

export const VERIFYING_LAYOUT: PaymasterLayout = {
  kind: "verifying",
  domainName: "VerifyingPaymaster",
  signatureOffset: 64,
  types: {Sponsorship: [...COMMON_FIELDS, ...WINDOW_FIELDS]},
};

export const TENANT_LAYOUT: PaymasterLayout = {
  kind: "tenant",
  domainName: "TenantPaymaster",
  signatureOffset: 96,
  // The tenant sits between `gasFees` and the validity window, matching SPONSORSHIP_TYPEHASH in
  // TenantPaymaster.sol. It is INSIDE the digest, which is what stops a caller holding one valid
  // attestation from editing the tenant bytes and spending a different customer's balance.
  types: {Sponsorship: [...COMMON_FIELDS, {name: "tenant", type: "bytes32"}, ...WINDOW_FIELDS]},
};

const LAYOUTS: Readonly<Record<PaymasterKind, PaymasterLayout>> = {
  verifying: VERIFYING_LAYOUT,
  tenant: TENANT_LAYOUT,
};

export function layoutFor(kind: PaymasterKind): PaymasterLayout {
  return LAYOUTS[kind];
}

/**
 * The `bytes32` a tenant is known by on chain.
 *
 * Hashed rather than padded because tenant ids are up to 64 characters and a `bytes32` holds 32.
 * The consequence worth knowing: this is one-way, so the chain records WHICH tenant paid without
 * recording who they are, and reading a balance requires knowing the id already. That is the right
 * trade — the alternative is a 32-character limit on ids that exist in the database today.
 *
 * It is also why funding is a call to `depositFor(bytes32)` rather than a plain transfer: a
 * transfer carries no tenant, and there is no way to recover one from the sender.
 */
export function onChainTenantKey(tenant: TenantId): Hex {
  return keccak256(toHex(tenant));
}
