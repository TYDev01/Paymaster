import {concatHex, isAddress, numberToHex, size, slice, hexToBigInt, type Address, type Hex} from "viem";

/**
 * Byte offsets within `paymasterAndData`. These MUST match VerifyingPaymaster.sol exactly:
 *
 *   [0:20]   paymaster address
 *   [20:36]  paymasterVerificationGasLimit  (uint128)
 *   [36:52]  postOpGasLimit                 (uint128)
 *   [52:58]  validUntil                     (uint48)
 *   [58:64]  validAfter                     (uint48)
 *   [64:]    signature
 *
 * The contract's layout is the source of truth. `differential.test.ts` asserts these agree with
 * the deployed bytecode, so a drift here fails the build rather than every sponsorship at runtime.
 */
export const PAYMASTER_VALIDATION_GAS_OFFSET = 20;
export const PAYMASTER_POSTOP_GAS_OFFSET = 36;
export const PAYMASTER_DATA_OFFSET = 52;
export const VALID_UNTIL_OFFSET = 52;
export const VALID_AFTER_OFFSET = 58;
export const SIGNATURE_OFFSET = 64;

export interface PaymasterAndDataFields {
  readonly paymaster: Address;
  readonly paymasterVerificationGasLimit: bigint;
  readonly postOpGasLimit: bigint;
  readonly validUntil: number;
  readonly validAfter: number;
}

export class InvalidPaymasterDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaymasterDataError";
  }
}

/**
 * Encodes everything the sponsorship signature covers: the paymaster, its gas limits, and the
 * validity window. This is `paymasterAndData` minus the signature tail, and is exactly what must
 * be present on the UserOperation when the digest is computed.
 */
export function encodePaymasterAndDataPrefix(fields: PaymasterAndDataFields): Hex {
  if (!isAddress(fields.paymaster)) {
    throw new InvalidPaymasterDataError(`invalid paymaster address: ${fields.paymaster}`);
  }
  return concatHex([
    fields.paymaster,
    numberToHex(fields.paymasterVerificationGasLimit, {size: 16}),
    numberToHex(fields.postOpGasLimit, {size: 16}),
    numberToHex(fields.validUntil, {size: 6}),
    numberToHex(fields.validAfter, {size: 6}),
  ]);
}

/** Encodes the full `paymasterAndData`, signature included, ready to put on the UserOperation. */
export function encodePaymasterAndData(fields: PaymasterAndDataFields, signature: Hex): Hex {
  const sigLength = size(signature);
  if (sigLength !== 64 && sigLength !== 65) {
    throw new InvalidPaymasterDataError(`signature must be 64 or 65 bytes, got ${sigLength}`);
  }
  return concatHex([encodePaymasterAndDataPrefix(fields), signature]);
}

/**
 * Decodes `paymasterAndData` produced by this or any conforming paymaster.
 *
 * Used by the admin API and by tests to read back what was issued. Mirrors the contract's
 * `parsePaymasterAndData`, including rejecting buffers too short to hold the fixed fields.
 */
export function decodePaymasterAndData(data: Hex): PaymasterAndDataFields & {signature: Hex} {
  const length = size(data);
  if (length < SIGNATURE_OFFSET) {
    throw new InvalidPaymasterDataError(`paymasterAndData must be >= ${SIGNATURE_OFFSET} bytes, got ${length}`);
  }
  return {
    paymaster: slice(data, 0, PAYMASTER_VALIDATION_GAS_OFFSET) as Address,
    paymasterVerificationGasLimit: hexToBigInt(slice(data, PAYMASTER_VALIDATION_GAS_OFFSET, PAYMASTER_POSTOP_GAS_OFFSET)),
    postOpGasLimit: hexToBigInt(slice(data, PAYMASTER_POSTOP_GAS_OFFSET, PAYMASTER_DATA_OFFSET)),
    validUntil: Number(hexToBigInt(slice(data, VALID_UNTIL_OFFSET, VALID_AFTER_OFFSET))),
    validAfter: Number(hexToBigInt(slice(data, VALID_AFTER_OFFSET, SIGNATURE_OFFSET))),
    signature: slice(data, SIGNATURE_OFFSET),
  };
}
