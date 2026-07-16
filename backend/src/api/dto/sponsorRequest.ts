import {z} from "zod";
import {toHex, type Address, type Hex} from "viem";

import {packUint128Pair, type PackedUserOperation} from "../../domain/userOperation.js";

/**
 * The wire format is the UNPACKED v0.7 UserOperation, not the packed struct.
 *
 * td.md lists the request fields as `callGasLimit`, `verificationGasLimit`, `paymasterAndData` —
 * that is the v0.6 shape, inherited from an older reference. For EntryPoint v0.7 the JSON-RPC
 * representation is unpacked and splits the paymaster fields out; this is what viem,
 * permissionless, and every v0.7 bundler actually send. Accepting the packed struct over HTTP
 * would force every client to do the EntryPoint's bit-packing themselves, and get it right.
 *
 * So: unpacked on the wire, packed in the domain. The packing happens here, once, in code that is
 * differentially tested against the contract.
 */

const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const hexString = z
  .string()
  .regex(HEX, "must be a 0x-prefixed hex string")
  .transform((value) => value as Hex);

const address = z
  .string()
  .regex(ADDRESS, "must be a 20-byte 0x-prefixed address")
  .transform((value) => value as Address);

/**
 * Quantities arrive as hex strings (the JSON-RPC convention) or as decimal strings. Never as JSON
 * numbers: `maxFeePerGas` routinely exceeds Number.MAX_SAFE_INTEGER, and silently losing precision
 * on a fee field would produce a signature over a value the client did not send.
 */
const quantity = z
  .string()
  .min(1)
  .refine((value) => (value.startsWith("0x") ? HEX.test(value) : /^[0-9]+$/.test(value)), {
    message: "must be a hex or decimal string",
  })
  .transform((value) => BigInt(value))
  .refine((value) => value >= 0n, {message: "must not be negative"})
  .refine((value) => value <= (1n << 256n) - 1n, {message: "must fit in uint256"});

const uint128 = quantity.refine((value) => value <= (1n << 128n) - 1n, {
  message: "must fit in uint128",
});

export const sponsorRequestSchema = z.object({
  chainId: z.number().int().positive(),
  userOperation: z.object({
    sender: address,
    nonce: quantity,
    /** Account-deployment fields. Both present or both absent. */
    factory: address.optional(),
    factoryData: hexString.optional(),
    callData: hexString,
    callGasLimit: uint128,
    verificationGasLimit: uint128,
    preVerificationGas: quantity,
    maxFeePerGas: uint128,
    maxPriorityFeePerGas: uint128,
    /**
     * The account's signature. Optional: a client estimating gas has not signed yet, and the
     * paymaster's attestation does not cover it anyway — the account signature is over a hash
     * that includes our paymasterAndData, so it cannot exist until after we respond.
     */
    signature: hexString.optional(),
  }),
  /** Which policy to evaluate against. Resolved from the API key in production. */
  policyId: z.string().min(1).max(128).optional(),
})
  .refine((value) => (value.userOperation.factory === undefined) === (value.userOperation.factoryData === undefined), {
    message: "factory and factoryData must be provided together",
    path: ["userOperation", "factory"],
  })
  .refine((value) => value.userOperation.maxPriorityFeePerGas <= value.userOperation.maxFeePerGas, {
    message: "maxPriorityFeePerGas must not exceed maxFeePerGas",
    path: ["userOperation", "maxPriorityFeePerGas"],
  });

export type SponsorRequest = z.infer<typeof sponsorRequestSchema>;
export type UnpackedUserOperation = SponsorRequest["userOperation"];

/**
 * Packs the wire format into the struct the EntryPoint hashes.
 *
 * `paymasterAndData` is left empty: the caller does not get to influence it. The signature engine
 * builds it from the values we choose.
 */
export function toPackedUserOperation(op: UnpackedUserOperation): PackedUserOperation {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: op.factory === undefined ? "0x" : (`${op.factory}${op.factoryData!.slice(2)}` as Hex),
    callData: op.callData,
    // High half is verificationGasLimit, low half is callGasLimit.
    accountGasLimits: toHex(packUint128Pair(op.verificationGasLimit, op.callGasLimit, "accountGasLimits"), {size: 32}),
    preVerificationGas: op.preVerificationGas,
    // High half is maxPriorityFeePerGas, low half is maxFeePerGas — the reverse of the order the
    // names are usually read in.
    gasFees: toHex(packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas, "gasFees"), {size: 32}),
    paymasterAndData: "0x",
    signature: op.signature ?? "0x",
  };
}
