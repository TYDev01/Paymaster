import {hashTypedData, hexToBigInt, keccak256, size, slice, type Address, type Hex, type TypedDataDomain} from "viem";

import {packUint128Pair, type PackedUserOperation} from "../domain/userOperation.js";
import {
  InvalidPaymasterDataError,
  PAYMASTER_DATA_OFFSET,
  PAYMASTER_POSTOP_GAS_OFFSET,
  PAYMASTER_VALIDATION_GAS_OFFSET,
} from "./paymasterAndData.js";

/**
 * EIP-712 domain. Must match `EIP712("VerifyingPaymaster", "1")` in the contract constructor.
 * `chainId` and `verifyingContract` are what bind an attestation to one chain and one deployment,
 * so a signature minted for Base cannot be replayed on Arbitrum or against a sibling paymaster.
 */
export const SPONSORSHIP_DOMAIN_NAME = "VerifyingPaymaster";
export const SPONSORSHIP_DOMAIN_VERSION = "1";

/**
 * Must match `SPONSORSHIP_TYPEHASH` in VerifyingPaymaster.sol. Field order is part of the type
 * hash: reordering these silently changes the digest and invalidates every signature.
 */
export const SPONSORSHIP_TYPES = {
  Sponsorship: [
    {name: "sender", type: "address"},
    {name: "nonce", type: "uint256"},
    {name: "initCodeHash", type: "bytes32"},
    {name: "callDataHash", type: "bytes32"},
    {name: "accountGasLimits", type: "bytes32"},
    {name: "paymasterGasLimits", type: "uint256"},
    {name: "preVerificationGas", type: "uint256"},
    {name: "gasFees", type: "bytes32"},
    {name: "validUntil", type: "uint48"},
    {name: "validAfter", type: "uint48"},
  ],
} as const;

export interface SponsorshipDigestParams {
  /**
   * The operation being sponsored. `paymasterAndData` is read for its gas-limit bytes [20:52] and
   * must therefore already carry the prefix; the signature tail is not covered by the digest and
   * may be absent.
   */
  readonly userOp: PackedUserOperation;
  readonly chainId: number;
  readonly paymaster: Address;
  readonly validUntil: number;
  readonly validAfter: number;
}

/**
 * Returned with a precise literal type rather than viem's `TypedDataDomain`, whose fields are all
 * optional. Every field here is always present, and callers should not have to narrow.
 */
export function sponsorshipDomain(chainId: number, paymaster: Address) {
  return {
    name: SPONSORSHIP_DOMAIN_NAME,
    version: SPONSORSHIP_DOMAIN_VERSION,
    chainId,
    verifyingContract: paymaster,
  } as const satisfies TypedDataDomain;
}

/**
 * Extracts `paymasterAndData[20:52]` as a single uint256 — the gas limits the paymaster commits
 * to pay for. Read from the encoded bytes rather than from the caller's numbers so the digest is
 * computed over what will actually be submitted on-chain, not over what we intended to submit.
 */
export function paymasterGasLimitsFrom(paymasterAndData: Hex): bigint {
  const length = size(paymasterAndData);
  if (length < PAYMASTER_DATA_OFFSET) {
    throw new InvalidPaymasterDataError(
      `paymasterAndData must be >= ${PAYMASTER_DATA_OFFSET} bytes to read gas limits, got ${length}`,
    );
  }
  const high = hexToBigInt(slice(paymasterAndData, PAYMASTER_VALIDATION_GAS_OFFSET, PAYMASTER_POSTOP_GAS_OFFSET));
  const low = hexToBigInt(slice(paymasterAndData, PAYMASTER_POSTOP_GAS_OFFSET, PAYMASTER_DATA_OFFSET));
  return packUint128Pair(high, low, "paymasterGasLimits");
}

/**
 * The EIP-712 digest the paymaster will recover a signer from. Equivalent to calling `getHash` on
 * the deployed contract; `differential.test.ts` asserts that equivalence against real bytecode.
 */
export function sponsorshipDigest(params: SponsorshipDigestParams): Hex {
  const {userOp, chainId, paymaster, validUntil, validAfter} = params;

  return hashTypedData({
    domain: sponsorshipDomain(chainId, paymaster),
    types: SPONSORSHIP_TYPES,
    primaryType: "Sponsorship",
    message: {
      sender: userOp.sender,
      nonce: userOp.nonce,
      initCodeHash: keccak256(userOp.initCode),
      callDataHash: keccak256(userOp.callData),
      accountGasLimits: userOp.accountGasLimits,
      paymasterGasLimits: paymasterGasLimitsFrom(userOp.paymasterAndData),
      preVerificationGas: userOp.preVerificationGas,
      gasFees: userOp.gasFees,
      validUntil,
      validAfter,
    },
  });
}
