import type {Address, Hex} from "viem";

import {UINT48_MAX, type PackedUserOperation} from "../domain/userOperation.js";
import {encodePaymasterAndData, encodePaymasterAndDataPrefix, type PaymasterAndDataFields} from "./paymasterAndData.js";
import {sponsorshipDigest} from "./typedData.js";
import type {SponsorshipSigner} from "./signer.js";

interface CommonSponsorshipRequest {
  /** The operation to sponsor. Its `paymasterAndData` is ignored and rebuilt from these fields. */
  readonly userOp: PackedUserOperation;
  readonly chainId: number;
  readonly paymaster: Address;
  readonly paymasterVerificationGasLimit: bigint;
  readonly postOpGasLimit: bigint;
  /** Unix seconds after which the attestation is void. */
  readonly validUntil: number;
  /** Unix seconds before which the attestation is not yet valid. 0 means immediately. */
  readonly validAfter: number;
}

/**
 * Discriminated on the paymaster kind, so a multi-tenant chain cannot be served an attestation with
 * no tenant in it. That case is worth a type error rather than a runtime check: the resulting bytes
 * would be a valid single-tenant attestation, correctly signed, that the multi-tenant contract
 * either rejects opaquely or — if the layouts ever lined up — charges the wrong balance for.
 */
export type SponsorshipRequest =
  | (CommonSponsorshipRequest & {readonly kind: "verifying"})
  | (CommonSponsorshipRequest & {readonly kind: "tenant"; readonly tenant: Hex});

export interface SponsorshipAttestation {
  readonly paymasterAndData: Hex;
  readonly validUntil: number;
  readonly validAfter: number;
  /** Which signer attested. Recorded so a revoked key's in-flight attestations are traceable. */
  readonly signer: Address;
}

export class InvalidSponsorshipRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSponsorshipRequestError";
  }
}

/**
 * Turns a sponsorship decision into an unforgeable on-chain attestation.
 *
 * This engine does NOT decide whether to sponsor — by the time a request reaches it, the policy
 * engine has already said yes. Keeping the two separate means the component holding the signing
 * key has no policy logic in it, so a policy bug cannot become a signing bug.
 */
export class SignatureEngine {
  constructor(private readonly signer: SponsorshipSigner) {}

  async attest(request: SponsorshipRequest): Promise<SponsorshipAttestation> {
    this.#assertValidWindow(request);

    const common = {
      paymaster: request.paymaster,
      paymasterVerificationGasLimit: request.paymasterVerificationGasLimit,
      postOpGasLimit: request.postOpGasLimit,
      validUntil: request.validUntil,
      validAfter: request.validAfter,
    };
    const fields: PaymasterAndDataFields =
      request.kind === "verifying"
        ? {kind: "verifying", ...common}
        : {kind: "tenant", ...common, tenant: request.tenant};

    // Rebuild paymasterAndData from our own fields and compute the digest over THAT, never over
    // whatever the caller supplied. The digest must describe the bytes that go on-chain.
    const userOp: PackedUserOperation = {
      ...request.userOp,
      paymasterAndData: encodePaymasterAndDataPrefix(fields),
    };

    const digestParams = {
      userOp,
      chainId: request.chainId,
      paymaster: request.paymaster,
      validUntil: request.validUntil,
      validAfter: request.validAfter,
    };
    const digest = sponsorshipDigest(
      request.kind === "verifying"
        ? {kind: "verifying", ...digestParams}
        : {kind: "tenant", ...digestParams, tenant: request.tenant},
    );

    const signature = await this.signer.signDigest(digest);

    return {
      paymasterAndData: encodePaymasterAndData(fields, signature),
      validUntil: request.validUntil,
      validAfter: request.validAfter,
      signer: this.signer.address,
    };
  }

  #assertValidWindow(request: SponsorshipRequest): void {
    const {validUntil, validAfter} = request;

    if (!Number.isInteger(validUntil) || validUntil < 0 || BigInt(validUntil) > UINT48_MAX) {
      throw new InvalidSponsorshipRequestError(`validUntil must be a uint48, got ${validUntil}`);
    }
    if (!Number.isInteger(validAfter) || validAfter < 0 || BigInt(validAfter) > UINT48_MAX) {
      throw new InvalidSponsorshipRequestError(`validAfter must be a uint48, got ${validAfter}`);
    }
    // An inverted window can never validate on-chain (the EntryPoint rejects it as AA32). The
    // contract doesn't spend gas checking this; we catch it here, where it's free, so the bug
    // surfaces as a 4xx at issue time instead of a mystery revert in the bundler.
    if (validUntil !== 0 && validUntil <= validAfter) {
      throw new InvalidSponsorshipRequestError(
        `validUntil (${validUntil}) must be greater than validAfter (${validAfter})`,
      );
    }
  }
}
