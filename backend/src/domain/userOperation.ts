import type {Address, Hex} from "viem";

/**
 * EntryPoint v0.7 `PackedUserOperation`, mirroring the on-chain struct field for field.
 *
 * The packed representation is kept rather than the ergonomic unpacked one because this is the
 * shape the EntryPoint hashes and the bundler transports. Unpacking for presentation is the API
 * layer's job; the domain works in the representation that signatures are actually computed over,
 * so a packing bug cannot silently change what we signed.
 */
export interface PackedUserOperation {
  readonly sender: Address;
  readonly nonce: bigint;
  readonly initCode: Hex;
  readonly callData: Hex;
  /** `verificationGasLimit` (high 128 bits) ++ `callGasLimit` (low 128 bits). */
  readonly accountGasLimits: Hex;
  readonly preVerificationGas: bigint;
  /** `maxPriorityFeePerGas` (high 128 bits) ++ `maxFeePerGas` (low 128 bits). */
  readonly gasFees: Hex;
  readonly paymasterAndData: Hex;
  readonly signature: Hex;
}

/** Largest value representable in the 128-bit halves of a packed pair. */
const UINT128_MAX = (1n << 128n) - 1n;

/** Largest value representable in a `uint48` timestamp field. */
export const UINT48_MAX = (1n << 48n) - 1n;

export class ValueOutOfRangeError extends Error {
  constructor(field: string, value: bigint, max: bigint) {
    super(`${field} must be <= ${max}, got ${value}`);
    this.name = "ValueOutOfRangeError";
  }
}

/**
 * Packs two 128-bit values into one 256-bit word, high-order first.
 *
 * This is the same operation the EntryPoint applies to `accountGasLimits`, `gasFees`, and the
 * paymaster's gas limits. Ranges are checked rather than truncated: a silent overflow here would
 * produce a signature over gas limits nobody agreed to.
 */
export function packUint128Pair(high: bigint, low: bigint, label = "value"): bigint {
  if (high < 0n || high > UINT128_MAX) throw new ValueOutOfRangeError(`${label}.high`, high, UINT128_MAX);
  if (low < 0n || low > UINT128_MAX) throw new ValueOutOfRangeError(`${label}.low`, low, UINT128_MAX);
  return (high << 128n) | low;
}
