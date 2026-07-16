import {describe, expect, it} from "vitest";
import {size, toHex, type Address, type Hex} from "viem";

import {packUint128Pair, ValueOutOfRangeError, type PackedUserOperation} from "../src/domain/userOperation.js";
import {
  decodePaymasterAndData,
  encodePaymasterAndData,
  encodePaymasterAndDataPrefix,
  InvalidPaymasterDataError,
  SIGNATURE_OFFSET,
} from "../src/signature/paymasterAndData.js";
import {InvalidSponsorshipRequestError, SignatureEngine} from "../src/signature/signatureEngine.js";
import {InvalidSigningKeyError, LocalSponsorshipSigner} from "../src/signature/signer.js";

const SIGNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PAYMASTER = "0x1111111111111111111111111111111111111111" as Address;

const FIELDS = {
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: 300_000n,
  postOpGasLimit: 50_000n,
  validUntil: 1_800_000_000,
  validAfter: 1_700_000_000,
} as const;

function userOp(overrides: Partial<PackedUserOperation> = {}): PackedUserOperation {
  return {
    sender: "0x1234567890123456789012345678901234567890",
    nonce: 0n,
    initCode: "0x",
    callData: "0xdeadbeef",
    accountGasLimits: toHex(packUint128Pair(500_000n, 200_000n), {size: 32}),
    preVerificationGas: 100_000n,
    gasFees: toHex(packUint128Pair(1_000_000_000n, 20_000_000_000n), {size: 32}),
    paymasterAndData: "0x",
    signature: "0x",
    ...overrides,
  };
}

describe("packUint128Pair", () => {
  it("packs high and low halves", () => {
    expect(packUint128Pair(1n, 2n)).toBe((1n << 128n) | 2n);
  });

  it("rejects values that would silently truncate", () => {
    expect(() => packUint128Pair(1n << 128n, 0n)).toThrow(ValueOutOfRangeError);
    expect(() => packUint128Pair(0n, 1n << 128n)).toThrow(ValueOutOfRangeError);
    expect(() => packUint128Pair(-1n, 0n)).toThrow(ValueOutOfRangeError);
  });
});

describe("paymasterAndData encoding", () => {
  it("encodes the signed prefix as exactly 64 bytes", () => {
    expect(size(encodePaymasterAndDataPrefix(FIELDS))).toBe(SIGNATURE_OFFSET);
  });

  it("round-trips through decode", () => {
    const signature = `0x${"11".repeat(65)}` as Hex;
    const decoded = decodePaymasterAndData(encodePaymasterAndData(FIELDS, signature));

    expect(decoded.paymaster.toLowerCase()).toBe(PAYMASTER.toLowerCase());
    expect(decoded.paymasterVerificationGasLimit).toBe(FIELDS.paymasterVerificationGasLimit);
    expect(decoded.postOpGasLimit).toBe(FIELDS.postOpGasLimit);
    expect(decoded.validUntil).toBe(FIELDS.validUntil);
    expect(decoded.validAfter).toBe(FIELDS.validAfter);
    expect(decoded.signature).toBe(signature);
  });

  it("accepts 64-byte compact signatures as well as 65-byte", () => {
    expect(() => encodePaymasterAndData(FIELDS, `0x${"11".repeat(64)}`)).not.toThrow();
    expect(() => encodePaymasterAndData(FIELDS, `0x${"11".repeat(65)}`)).not.toThrow();
  });

  it("rejects signatures the contract would reject", () => {
    expect(() => encodePaymasterAndData(FIELDS, "0xdeadbeef")).toThrow(InvalidPaymasterDataError);
    expect(() => encodePaymasterAndData(FIELDS, `0x${"11".repeat(66)}`)).toThrow(InvalidPaymasterDataError);
  });

  it("rejects a buffer too short to hold the fixed fields", () => {
    expect(() => decodePaymasterAndData(`0x${"11".repeat(52)}`)).toThrow(InvalidPaymasterDataError);
  });

  it("rejects a malformed paymaster address", () => {
    expect(() => encodePaymasterAndDataPrefix({...FIELDS, paymaster: "0xnope" as Address})).toThrow(
      InvalidPaymasterDataError,
    );
  });
});

describe("LocalSponsorshipSigner", () => {
  it("exposes the address the paymaster will recover", () => {
    const signer = new LocalSponsorshipSigner(SIGNER_KEY);
    expect(signer.address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  it("rejects malformed keys", () => {
    expect(() => new LocalSponsorshipSigner("0x1234" as Hex)).toThrow(InvalidSigningKeyError);
    expect(() => new LocalSponsorshipSigner("not-hex" as Hex)).toThrow(InvalidSigningKeyError);
  });

  it("never echoes key material into the error message", () => {
    const secret = `0x${"ab".repeat(31)}` as Hex; // wrong length, still sensitive
    expect(() => new LocalSponsorshipSigner(secret)).toThrow(
      expect.objectContaining({message: expect.not.stringContaining("abab")}),
    );
  });

  it("produces a 65-byte signature", async () => {
    const signer = new LocalSponsorshipSigner(SIGNER_KEY);
    const sig = await signer.signDigest(`0x${"22".repeat(32)}`);
    expect(size(sig)).toBe(65);
  });
});

describe("SignatureEngine", () => {
  const engine = new SignatureEngine(new LocalSponsorshipSigner(SIGNER_KEY));

  const request = {
    userOp: userOp(),
    chainId: 8453,
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: 300_000n,
    postOpGasLimit: 50_000n,
    validUntil: 1_800_000_000,
    validAfter: 0,
  } as const;

  it("produces paymasterAndData the contract's layout can parse", async () => {
    const attestation = await engine.attest(request);
    const decoded = decodePaymasterAndData(attestation.paymasterAndData);

    expect(decoded.paymaster.toLowerCase()).toBe(PAYMASTER.toLowerCase());
    expect(decoded.validUntil).toBe(request.validUntil);
    expect(decoded.validAfter).toBe(request.validAfter);
    expect(size(decoded.signature)).toBe(65);
  });

  it("reports which signer attested, for tracing revoked keys", async () => {
    const attestation = await engine.attest(request);
    expect(attestation.signer).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  /**
   * The engine must sign the bytes it emits, not the bytes it was handed. A caller passing a
   * hostile paymasterAndData must not be able to steer what gets signed.
   */
  it("ignores caller-supplied paymasterAndData and rebuilds it", async () => {
    const hostile = await engine.attest({
      ...request,
      userOp: userOp({paymasterAndData: `0x${"ff".repeat(200)}`}),
    });
    const honest = await engine.attest(request);

    expect(hostile.paymasterAndData).toBe(honest.paymasterAndData);
  });

  it("binds the attestation to the chain", async () => {
    const onBase = await engine.attest({...request, chainId: 8453});
    const onArbitrum = await engine.attest({...request, chainId: 42_161});

    expect(onBase.paymasterAndData).not.toBe(onArbitrum.paymasterAndData);
  });

  it("binds the attestation to the paymaster deployment", async () => {
    const a = await engine.attest(request);
    const b = await engine.attest({...request, paymaster: "0x2222222222222222222222222222222222222222"});

    expect(decodePaymasterAndData(a.paymasterAndData).signature).not.toBe(
      decodePaymasterAndData(b.paymasterAndData).signature,
    );
  });

  it("rejects an inverted validity window", async () => {
    await expect(engine.attest({...request, validUntil: 1_000, validAfter: 2_000})).rejects.toThrow(
      InvalidSponsorshipRequestError,
    );
  });

  it("rejects timestamps that do not fit uint48", async () => {
    await expect(engine.attest({...request, validUntil: 2 ** 48})).rejects.toThrow(InvalidSponsorshipRequestError);
    await expect(engine.attest({...request, validAfter: -1})).rejects.toThrow(InvalidSponsorshipRequestError);
    await expect(engine.attest({...request, validUntil: 1.5})).rejects.toThrow(InvalidSponsorshipRequestError);
  });

  it("permits validUntil = 0, which the EntryPoint reads as no expiry", async () => {
    await expect(engine.attest({...request, validUntil: 0, validAfter: 0})).resolves.toBeDefined();
  });
});
