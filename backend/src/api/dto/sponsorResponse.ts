import type {Address, Hex} from "viem";

/**
 * What a client needs to put the sponsorship onto its UserOperation.
 *
 * Returns the v0.7 unpacked paymaster fields — `paymaster`, `paymasterVerificationGasLimit`,
 * `paymasterPostOpGasLimit`, `paymasterData` — because that is what a v0.7 client assigns onto the
 * op before sending it to a bundler. `paymasterAndData` is included too: td.md asks for it, and it
 * is what a client talking to a v0.6-shaped tool expects. Both describe the same bytes.
 *
 * td.md also asks for a `signature` field. It is deliberately absent. The paymaster's signature is
 * not a separate artifact a client uses — it is the tail of paymasterData, and returning it
 * alongside would invite a client to put it in `userOperation.signature`, which is the ACCOUNT's
 * signature field. Those are different signatures with different signers, and conflating them
 * produces an op that fails validation in a way that is miserable to debug.
 */
export interface SponsorResponse {
  readonly paymaster: Address;
  readonly paymasterVerificationGasLimit: Hex;
  readonly paymasterPostOpGasLimit: Hex;
  readonly paymasterData: Hex;

  /** The same bytes as the four fields above, concatenated. For v0.6-shaped clients. */
  readonly paymasterAndData: Hex;

  readonly validUntil: number;
  readonly validAfter: number;
  /** ISO-8601 form of validUntil, for humans reading logs. */
  readonly expiresAt: string;

  readonly metadata: SponsorMetadata;
}

/** td.md's "verification metadata": what was decided, by whom, and against what. */
export interface SponsorMetadata {
  readonly chainId: number;
  readonly policyId: string;
  /** Which signer attested, so a revoked key's in-flight attestations are traceable. */
  readonly signer: Address;
  /** Worst-case cost this sponsorship commits the paymaster to, in wei, as a decimal string. */
  readonly maxCost: string;
  readonly entryPoint: Address;
}
