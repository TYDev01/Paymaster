import {hashTypedData, hexToBigInt, keccak256, size, slice, type Address, type Hex, type TypedDataDomain} from "viem";

import {packUint128Pair, type PackedUserOperation} from "../domain/userOperation.js";
import {
  InvalidPaymasterDataError,
  PAYMASTER_DATA_OFFSET,
  PAYMASTER_POSTOP_GAS_OFFSET,
  PAYMASTER_VALIDATION_GAS_OFFSET,
} from "./paymasterAndData.js";
import {layoutFor, TENANT_LAYOUT, VERIFYING_LAYOUT, type PaymasterKind} from "./paymasterLayout.js";

/**
 * EIP-712 domain. The name must match `EIP712(name, "1")` in the contract's constructor, and it
 * DIFFERS between the two paymasters — signing for one with the other's name produces a digest that
 * recovers to a stranger. `chainId` and `verifyingContract` are what bind an attestation to one
 * chain and one deployment, so a signature minted for Base cannot be replayed on Arbitrum or
 * against a sibling paymaster.
 */
export const SPONSORSHIP_DOMAIN_VERSION = "1";

/** @deprecated Prefer `layoutFor(kind).domainName`; kept for the single-tenant contract's callers. */
export const SPONSORSHIP_DOMAIN_NAME = VERIFYING_LAYOUT.domainName;

/** Must match `SPONSORSHIP_TYPEHASH` in VerifyingPaymaster.sol. */
export const SPONSORSHIP_TYPES = VERIFYING_LAYOUT.types;

/** Must match `SPONSORSHIP_TYPEHASH` in TenantPaymaster.sol. */
export const TENANT_SPONSORSHIP_TYPES = TENANT_LAYOUT.types;

interface CommonDigestParams {
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

/** Discriminated for the same reason the codec is: see `PaymasterAndDataFields`. */
export type SponsorshipDigestParams =
  | (CommonDigestParams & {readonly kind: "verifying"})
  | (CommonDigestParams & {readonly kind: "tenant"; readonly tenant: Hex});

/**
 * Returned with a precise literal type rather than viem's `TypedDataDomain`, whose fields are all
 * optional. Every field here is always present, and callers should not have to narrow.
 */
export function sponsorshipDomain(chainId: number, paymaster: Address, kind: PaymasterKind = "verifying") {
  return {
    name: layoutFor(kind).domainName,
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
 * the deployed contract; `differential.test.ts` asserts that equivalence against real bytecode for
 * both kinds.
 */
export function sponsorshipDigest(params: SponsorshipDigestParams): Hex {
  const {userOp, chainId, paymaster, validUntil, validAfter, kind} = params;

  const common = {
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
  };

  return hashTypedData({
    domain: sponsorshipDomain(chainId, paymaster, kind),
    types: layoutFor(kind).types,
    primaryType: "Sponsorship",
    message: kind === "verifying" ? common : {...common, tenant: params.tenant},
  });
}
