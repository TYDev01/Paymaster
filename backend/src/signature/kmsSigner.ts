import {
  bytesToHex,
  concatHex,
  getAddress,
  hexToBytes,
  keccak256,
  recoverAddress,
  size,
  type Address,
  type Hex,
} from "viem";

import type {SponsorshipSigner} from "./signer.js";

/**
 * The two KMS operations the signer needs, as a port.
 *
 * Narrow on purpose: it exposes exactly "give me the public key" and "sign this 32-byte digest",
 * and nothing about AWS. That is what lets the address derivation and the DER→`r‖s‖v` conversion —
 * the parts worth testing — run against a fake, and lets a different HSM back the same signer by
 * satisfying this interface. Crucially, neither method ever returns key material: the private key
 * stays inside KMS, which is the whole point of this signer over `LocalSponsorshipSigner`.
 */
export interface KmsClient {
  /** The public key as SPKI DER (what AWS KMS `GetPublicKey` returns for an ECC_SECG_P256K1 key). */
  getPublicKeyDer(): Promise<Uint8Array>;
  /** An ECDSA signature over `digest` as ASN.1 DER (what KMS `Sign` returns). */
  sign(digest: Uint8Array): Promise<Uint8Array>;
}

/** secp256k1 group order, and half of it: signatures with `s` above half are non-canonical. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

export class KmsSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KmsSigningError";
  }
}

/**
 * Sponsorship signer whose key lives in AWS KMS (or any HSM behind `KmsClient`).
 *
 * The key never enters this process: signing is a KMS API call, and only the resulting signature
 * comes back. That closes the exposure `LocalSponsorshipSigner` documents — a raw key reachable from
 * a heap snapshot or core dump — which is why td.md wants this for production.
 *
 * Two conversions stand between what KMS returns and what the paymaster's `ECDSA.recover` accepts,
 * and both are done here:
 *
 *   1. KMS returns the signature as ASN.1 DER; Ethereum wants 65 raw bytes `r ‖ s ‖ v`.
 *   2. KMS may return a high-`s` signature; Ethereum's ECDSA library rejects non-canonical `s`, so
 *      it is normalised to the low half of the curve order (which flips the recovery bit).
 *
 * The recovery bit `v` is not returned by KMS at all, so it is recovered by trying both candidates
 * and keeping the one that recovers this signer's own address.
 */
export class KmsSponsorshipSigner implements SponsorshipSigner {
  readonly address: Address;
  readonly #kms: KmsClient;

  private constructor(kms: KmsClient, address: Address) {
    this.#kms = kms;
    this.address = address;
  }

  /**
   * Fetches the public key once and derives the address, so `address` is available synchronously
   * afterwards and every later signature can be checked against it. Construction is the only place
   * that reads the public key — the signing path never needs it again.
   */
  static async create(kms: KmsClient): Promise<KmsSponsorshipSigner> {
    const der = await kms.getPublicKeyDer();
    return new KmsSponsorshipSigner(kms, addressFromSpkiDer(der));
  }

  async signDigest(digest: Hex): Promise<Hex> {
    if (size(digest) !== 32) {
      throw new KmsSigningError(`digest must be 32 bytes, got ${size(digest)}`);
    }

    const der = await this.#kms.sign(hexToBytes(digest));
    const {r, s: rawS} = decodeDerSignature(der);

    // Normalise to low-s. A high-s signature is the same signature reflected, so flipping s also
    // flips which of the two candidate public keys recovery yields — hence the v search below rather
    // than tracking the flip explicitly.
    const s = rawS > SECP256K1_HALF_N ? SECP256K1_N - rawS : rawS;

    const rHex = toBytes32(r);
    const sHex = toBytes32(s);

    for (const v of [27, 28] as const) {
      const signature = concatHex([rHex, sHex, bytesToHex(Uint8Array.of(v))]);
      const recovered = await recoverAddress({hash: digest, signature});
      if (recovered === this.address) return signature;
    }

    // Neither recovery bit reproduces our address: the DER did not come from our key, or is corrupt.
    // Returning a wrong-`v` signature would fail on-chain with an opaque AA24; failing here is clearer.
    throw new KmsSigningError("could not recover signer address from KMS signature (wrong key or corrupt DER?)");
  }
}

/**
 * Extracts the Ethereum address from an SPKI DER-encoded secp256k1 public key.
 *
 * KMS returns SubjectPublicKeyInfo DER; the uncompressed EC point is its trailing 65 bytes, marked
 * by the `0x04` prefix. Rather than walk the full ASN.1 structure, we take those trailing bytes and
 * assert the prefix — the encoding is fixed for this key type, and a mismatch means we were handed
 * something that is not a secp256k1 SPKI key, which we want to fail on rather than misread.
 */
export function addressFromSpkiDer(der: Uint8Array): Address {
  if (der.length < 65) throw new KmsSigningError("public key DER too short to contain a secp256k1 point");
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) throw new KmsSigningError("public key is not an uncompressed secp256k1 point");

  // keccak256 of the 64-byte X‖Y (drop the 0x04 prefix); the address is its last 20 bytes.
  const hash = keccak256(point.subarray(1));
  return getAddress(`0x${hash.slice(-40)}`);
}

/**
 * Decodes an ASN.1 DER ECDSA signature into its `r` and `s` integers.
 *
 * Structure: `SEQUENCE { INTEGER r, INTEGER s }`. Each INTEGER is big-endian and may carry a leading
 * `0x00` to keep it positive; `BigInt` over the raw bytes absorbs that without special-casing.
 */
export function decodeDerSignature(der: Uint8Array): {r: bigint; s: bigint} {
  let offset = 0;
  const readByte = (): number => {
    if (offset >= der.length) throw new KmsSigningError("truncated DER signature");
    return der[offset++]!;
  };

  if (readByte() !== 0x30) throw new KmsSigningError("DER signature is not a SEQUENCE");
  readByte(); // sequence length; we read each INTEGER's own length instead of trusting this.

  const readInteger = (): bigint => {
    if (readByte() !== 0x02) throw new KmsSigningError("expected DER INTEGER");
    const len = readByte();
    if (len === 0 || offset + len > der.length) throw new KmsSigningError("invalid DER INTEGER length");
    let value = 0n;
    for (let i = 0; i < len; i++) value = (value << 8n) | BigInt(readByte());
    return value;
  };

  const r = readInteger();
  const s = readInteger();
  return {r, s};
}

function toBytes32(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
