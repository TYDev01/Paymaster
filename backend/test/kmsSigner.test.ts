import {describe, expect, it} from "vitest";
import {hexToBytes, keccak256, recoverAddress, type Hex} from "viem";
import {privateKeyToAccount, sign} from "viem/accounts";

import {KmsSponsorshipSigner, decodeDerSignature, type KmsClient} from "../src/signature/kmsSigner.js";

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const account = privateKeyToAccount(PRIVATE_KEY);

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

// The fixed SPKI DER prefix for an ECC_SECG_P256K1 public key, before the 65-byte uncompressed point.
const SPKI_SECP256K1_PREFIX = hexToBytes("0x3056301006072a8648ce3d020106052b8104000a034200");

function derInteger(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let bytes = hexToBytes(`0x${hex}`);
  // Prepend 0x00 when the high bit is set, so the INTEGER reads as positive — as DER requires.
  if ((bytes[0]! & 0x80) !== 0) bytes = Uint8Array.of(0, ...bytes);
  return Uint8Array.of(0x02, bytes.length, ...bytes);
}

function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = Uint8Array.of(...derInteger(r), ...derInteger(s));
  return Uint8Array.of(0x30, body.length, ...body);
}

/** A KmsClient that signs locally with a known key — the stand-in for real KMS in these tests. */
function fakeKms(options: {forceHighS?: boolean} = {}): KmsClient {
  const point = hexToBytes(account.publicKey); // 0x04 ‖ X ‖ Y
  return {
    getPublicKeyDer: async () => Uint8Array.of(...SPKI_SECP256K1_PREFIX, ...point),
    sign: async (digest) => {
      const signature = await sign({hash: `0x${Buffer.from(digest).toString("hex")}` as Hex, privateKey: PRIVATE_KEY});
      const r = BigInt(signature.r);
      let s = BigInt(signature.s);
      if (options.forceHighS && s <= SECP256K1_HALF_N) s = SECP256K1_N - s; // reflect to non-canonical high-s
      return derSignature(r, s);
    },
  };
}

const DIGEST = keccak256("0xdeadbeef");

describe("KmsSponsorshipSigner", () => {
  it("derives the same address as the private key it wraps", async () => {
    const signer = await KmsSponsorshipSigner.create(fakeKms());
    expect(signer.address).toBe(account.address);
  });

  it("produces a 65-byte signature that recovers to its address", async () => {
    const signer = await KmsSponsorshipSigner.create(fakeKms());
    const sig = await signer.signDigest(DIGEST);
    expect(hexToBytes(sig)).toHaveLength(65);
    expect(await recoverAddress({hash: DIGEST, signature: sig})).toBe(account.address);
  });

  it("normalises a high-s KMS signature to canonical low-s", async () => {
    const signer = await KmsSponsorshipSigner.create(fakeKms({forceHighS: true}));
    const sig = await signer.signDigest(DIGEST);
    const {s} = decodeDerSignature(derFromRsv(sig));
    expect(s).toBeLessThanOrEqual(SECP256K1_HALF_N);
    // Still valid after normalisation.
    expect(await recoverAddress({hash: DIGEST, signature: sig})).toBe(account.address);
  });

  it("matches the local signer bit-for-bit for the same key and digest", async () => {
    const kms = await KmsSponsorshipSigner.create(fakeKms());
    const local = await account.sign({hash: DIGEST});
    expect(await kms.signDigest(DIGEST)).toBe(local);
  });

  it("rejects a non-32-byte digest", async () => {
    const signer = await KmsSponsorshipSigner.create(fakeKms());
    await expect(signer.signDigest("0x1234" as Hex)).rejects.toThrow(/32 bytes/);
  });

  it("fails when the signature does not come from its key", async () => {
    const otherPoint = hexToBytes(
      privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a").publicKey,
    );
    const mismatched: KmsClient = {
      // Public key of key A ...
      getPublicKeyDer: async () => Uint8Array.of(...SPKI_SECP256K1_PREFIX, ...otherPoint),
      // ... but signatures from key B.
      sign: fakeKms().sign,
    };
    const signer = await KmsSponsorshipSigner.create(mismatched);
    await expect(signer.signDigest(DIGEST)).rejects.toThrow(/could not recover/);
  });
});

/** Re-encodes an r‖s‖v signature's r,s as DER, to reuse decodeDerSignature for assertions. */
function derFromRsv(sig: Hex): Uint8Array {
  const bytes = hexToBytes(sig);
  const r = BigInt(`0x${Buffer.from(bytes.subarray(0, 32)).toString("hex")}`);
  const s = BigInt(`0x${Buffer.from(bytes.subarray(32, 64)).toString("hex")}`);
  return derSignature(r, s);
}
