import {privateKeyToAccount} from "viem/accounts";
import {isHex, size, type Address, type Hex} from "viem";

/**
 * Port for whatever holds the sponsorship signing key.
 *
 * Deliberately narrow: it signs a 32-byte digest and nothing else. The EIP-712 structure is built
 * and hashed by the signature engine, so a signer implementation never needs to understand
 * sponsorship semantics — which is what lets an HSM or AWS KMS back this interface without the
 * key material ever entering this process.
 *
 * Implementations MUST return a 65-byte `r ++ s ++ v` signature with a low-`s` value, matching
 * what `ECDSA.recover` accepts on-chain.
 */
export interface SponsorshipSigner {
  /** The address the paymaster will recover. Must be authorised via `addSigner` on-chain. */
  readonly address: Address;
  signDigest(digest: Hex): Promise<Hex>;
}

export class InvalidSigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSigningKeyError";
  }
}

/**
 * Signer backed by a raw private key held in this process's memory.
 *
 * Appropriate for local development and CI. For production, prefer a KMS-backed implementation of
 * `SponsorshipSigner`: this class necessarily keeps the key in heap memory, where it is reachable
 * from a core dump or a heap snapshot.
 *
 * The key is never read from source or from a default. The caller supplies it, and the composition
 * root is responsible for sourcing it from the secret manager.
 */
export class LocalSponsorshipSigner implements SponsorshipSigner {
  readonly address: Address;
  readonly #account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: Hex) {
    if (!isHex(privateKey) || size(privateKey) !== 32) {
      // Deliberately does not echo the value: this error will be logged.
      throw new InvalidSigningKeyError("signing key must be a 32-byte hex string");
    }
    this.#account = privateKeyToAccount(privateKey);
    this.address = this.#account.address;
  }

  async signDigest(digest: Hex): Promise<Hex> {
    // `sign` with a raw hash: no EIP-191 prefixing. The paymaster recovers against the EIP-712
    // digest directly, so prefixing here would produce a signature that never validates.
    return this.#account.sign({hash: digest});
  }
}
