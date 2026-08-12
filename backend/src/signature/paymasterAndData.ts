import {concatHex, isAddress, isHex, numberToHex, size, slice, hexToBigInt, type Address, type Hex} from "viem";

import {layoutFor, type PaymasterKind} from "./paymasterLayout.js";

/**
 * Byte offsets within `paymasterAndData`. These MUST match the contracts exactly.
 *
 * Common to both:
 *   [0:20]   paymaster address
 *   [20:36]  paymasterVerificationGasLimit  (uint128)
 *   [36:52]  postOpGasLimit                 (uint128)
 *   [52:58]  validUntil                     (uint48)
 *   [58:64]  validAfter                     (uint48)
 *
 * VerifyingPaymaster then has  [64:]  signature.
 * TenantPaymaster inserts      [64:96] tenant (bytes32),  then [96:] signature.
 *
 * The contracts' layouts are the source of truth. `differential.test.ts` asserts these agree with
 * the deployed bytecode of both, so a drift here fails the build rather than every sponsorship at
 * runtime.
 */
export const PAYMASTER_VALIDATION_GAS_OFFSET = 20;
export const PAYMASTER_POSTOP_GAS_OFFSET = 36;
export const PAYMASTER_DATA_OFFSET = 52;
export const VALID_UNTIL_OFFSET = 52;
export const VALID_AFTER_OFFSET = 58;
export const TENANT_OFFSET = 64;

/** Where the signature starts under the single-tenant layout. See `layoutFor` for the general case. */
export const SIGNATURE_OFFSET = 64;
/** Where the signature starts under the multi-tenant layout. */
export const TENANT_SIGNATURE_OFFSET = 96;

interface CommonFields {
  readonly paymaster: Address;
  readonly paymasterVerificationGasLimit: bigint;
  readonly postOpGasLimit: bigint;
  readonly validUntil: number;
  readonly validAfter: number;
}

/**
 * Discriminated on `kind` so the tenant is a COMPILE-TIME requirement of the multi-tenant layout
 * rather than a field someone remembers to pass. Omitting it would otherwise produce a perfectly
 * well-formed attestation for the wrong contract, which fails on chain as an opaque revert rather
 * than here as a type error.
 */
export type PaymasterAndDataFields =
  (CommonFields & {readonly kind: "verifying"}) | (CommonFields & {readonly kind: "tenant"; readonly tenant: Hex});

export class InvalidPaymasterDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaymasterDataError";
  }
}

/**
 * Encodes everything the sponsorship signature covers: the paymaster, its gas limits, the validity
 * window, and — for the multi-tenant contract — whose balance pays. This is `paymasterAndData` minus
 * the signature tail, and is exactly what must be present on the UserOperation when the digest is
 * computed.
 */
export function encodePaymasterAndDataPrefix(fields: PaymasterAndDataFields): Hex {
  if (!isAddress(fields.paymaster)) {
    throw new InvalidPaymasterDataError(`invalid paymaster address: ${fields.paymaster}`);
  }
  const head = concatHex([
    fields.paymaster,
    numberToHex(fields.paymasterVerificationGasLimit, {size: 16}),
    numberToHex(fields.postOpGasLimit, {size: 16}),
    numberToHex(fields.validUntil, {size: 6}),
    numberToHex(fields.validAfter, {size: 6}),
  ]);
  if (fields.kind === "verifying") return head;

  if (!isHex(fields.tenant) || size(fields.tenant) !== 32) {
    throw new InvalidPaymasterDataError(`tenant must be a 32-byte hex value, got ${fields.tenant}`);
  }
  return concatHex([head, fields.tenant]);
}

/** Encodes the full `paymasterAndData`, signature included, ready to put on the UserOperation. */
export function encodePaymasterAndData(fields: PaymasterAndDataFields, signature: Hex): Hex {
  const sigLength = size(signature);
  if (sigLength !== 64 && sigLength !== 65) {
    throw new InvalidPaymasterDataError(`signature must be 64 or 65 bytes, got ${sigLength}`);
  }
  return concatHex([encodePaymasterAndDataPrefix(fields), signature]);
}

export type DecodedPaymasterAndData = PaymasterAndDataFields & {readonly signature: Hex};

/**
 * Decodes `paymasterAndData` produced by this or any conforming paymaster.
 *
 * The kind must be supplied rather than inferred from the length: both layouts accept 64- and
 * 65-byte signatures, so a 160-byte buffer is a valid tenant attestation with a 64-byte signature
 * AND a valid verifying attestation with a 96-byte tail. Inferring would pick one and be silently
 * wrong for the other. The caller knows which contract it configured; this function does not.
 *
 * Used by the admin API and by tests to read back what was issued. Mirrors each contract's
 * `parsePaymasterAndData`, including rejecting buffers too short to hold the fixed fields.
 */
export function decodePaymasterAndData(data: Hex, kind: PaymasterKind): DecodedPaymasterAndData {
  const {signatureOffset} = layoutFor(kind);
  const length = size(data);
  if (length < signatureOffset) {
    throw new InvalidPaymasterDataError(
      `paymasterAndData for a ${kind} paymaster must be >= ${signatureOffset} bytes, got ${length}`,
    );
  }

  const common = {
    paymaster: slice(data, 0, PAYMASTER_VALIDATION_GAS_OFFSET) as Address,
    paymasterVerificationGasLimit: hexToBigInt(
      slice(data, PAYMASTER_VALIDATION_GAS_OFFSET, PAYMASTER_POSTOP_GAS_OFFSET),
    ),
    postOpGasLimit: hexToBigInt(slice(data, PAYMASTER_POSTOP_GAS_OFFSET, PAYMASTER_DATA_OFFSET)),
    validUntil: Number(hexToBigInt(slice(data, VALID_UNTIL_OFFSET, VALID_AFTER_OFFSET))),
    validAfter: Number(hexToBigInt(slice(data, VALID_AFTER_OFFSET, TENANT_OFFSET))),
    // Empty rather than a slice error when the buffer stops exactly at the signature offset. That
    // buffer is a COMPLETE prefix carrying no signature, which is what the contracts' own parsers
    // return before rejecting it as `InvalidSignatureLength(0)` — and this decoder exists to mirror
    // them. Throwing viem's internal out-of-bounds error here would report a layout fault for what
    // is really an unsigned attestation.
    signature: length === signatureOffset ? "0x" : slice(data, signatureOffset),
  } as const;

  return kind === "verifying"
    ? {kind, ...common}
    : {kind, ...common, tenant: slice(data, TENANT_OFFSET, TENANT_SIGNATURE_OFFSET)};
}
