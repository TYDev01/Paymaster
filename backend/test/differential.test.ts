import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {toHex, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import type {PackedUserOperation} from "../src/domain/userOperation.js";
import {packUint128Pair} from "../src/domain/userOperation.js";
import {decodePaymasterAndData, encodePaymasterAndDataPrefix} from "../src/signature/paymasterAndData.js";
import {sponsorshipDigest} from "../src/signature/typedData.js";
import {SignatureEngine} from "../src/signature/signatureEngine.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";

/**
 * The contract is the source of truth for the sponsorship digest. These tests compare our
 * TypeScript implementation against the *deployed bytecode*, not against a transcription of it.
 *
 * This is the seam where a production paymaster most plausibly breaks: the backend and the
 * contract each look correct in isolation while disagreeing by one field, and every sponsorship
 * fails with an opaque AA34. Asserting equality against real bytecode is what makes that
 * impossible to ship.
 */
describe("signature engine <-> VerifyingPaymaster differential", () => {
  let anvil: AnvilInstance;
  let paymaster: Address;
  let entryPoint: Address;
  let paymasterAbi: ReturnType<typeof loadArtifact>["abi"];

  const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const signer = privateKeyToAccount(signerKey);
  const owner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

  const PM_VERIFICATION_GAS = 300_000n;
  const POSTOP_GAS = 50_000n;

  beforeAll(async () => {
    anvil = await startAnvil();

    const entryPointArtifact = loadArtifact("EntryPoint.sol", "EntryPoint");
    const paymasterArtifact = loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster");
    paymasterAbi = paymasterArtifact.abi;

    entryPoint = await deploy(anvil, entryPointArtifact);
    paymaster = await deploy(anvil, paymasterArtifact, [entryPoint, owner, signer.address]);
  }, 60_000);

  afterAll(() => anvil?.stop());

  function baseOp(overrides: Partial<PackedUserOperation> = {}): PackedUserOperation {
    return {
      sender: "0x1234567890123456789012345678901234567890",
      nonce: 0n,
      initCode: "0x",
      callData: "0xdeadbeef",
      accountGasLimits: toHex(packUint128Pair(500_000n, 200_000n), {size: 32}),
      preVerificationGas: 100_000n,
      gasFees: toHex(packUint128Pair(1_000_000_000n, 20_000_000_000n), {size: 32}),
      paymasterAndData: encodePaymasterAndDataPrefix({
        paymaster,
        paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
        postOpGasLimit: POSTOP_GAS,
        validUntil: 0,
        validAfter: 0,
      }),
      signature: "0x",
      ...overrides,
    };
  }

  async function onChainHash(op: PackedUserOperation, validUntil: number, validAfter: number): Promise<Hex> {
    return anvil.publicClient.readContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: "getHash",
      args: [op, validUntil, validAfter],
    }) as Promise<Hex>;
  }

  it("domain separator matches the contract", async () => {
    const onChain = await anvil.publicClient.readContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: "domainSeparator",
    });

    // Rebuilt independently from our domain definition.
    const {sponsorshipDomain} = await import("../src/signature/typedData.js");
    const {hashDomain} = await import("viem");
    const domain = sponsorshipDomain(anvil.publicClient.chain!.id, paymaster);
    const offChain = hashDomain({
      // chainId widens to bigint here because EIP712Domain declares it uint256; hashTypedData
      // does this conversion internally, but hashDomain takes the types explicitly.
      domain: {...domain, chainId: BigInt(domain.chainId)},
      types: {
        EIP712Domain: [
          {name: "name", type: "string"},
          {name: "version", type: "string"},
          {name: "chainId", type: "uint256"},
          {name: "verifyingContract", type: "address"},
        ],
      },
    });

    expect(offChain).toBe(onChain);
  });

  it("digest matches the contract for a representative op", async () => {
    const op = baseOp();
    const validUntil = 1_800_000_000;
    const validAfter = 0;

    const expected = await onChainHash(op, validUntil, validAfter);
    const actual = sponsorshipDigest({
      userOp: op,
      chainId: anvil.publicClient.chain!.id,
      paymaster,
      validUntil,
      validAfter,
    });

    expect(actual).toBe(expected);
  });

  it("digest matches the contract across varied field values", async () => {
    const cases: Array<{name: string; op: PackedUserOperation; validUntil: number; validAfter: number}> = [
      {name: "empty callData", op: baseOp({callData: "0x"}), validUntil: 1_800_000_000, validAfter: 0},
      {name: "with initCode", op: baseOp({initCode: "0xabcdef0123456789"}), validUntil: 1_800_000_000, validAfter: 0},
      {name: "large nonce", op: baseOp({nonce: 2n ** 200n}), validUntil: 1_800_000_000, validAfter: 0},
      {name: "zero gas fees", op: baseOp({gasFees: toHex(0n, {size: 32})}), validUntil: 1_800_000_000, validAfter: 0},
      {name: "max preVerificationGas", op: baseOp({preVerificationGas: 2n ** 256n - 1n}), validUntil: 1, validAfter: 0},
      {name: "both timestamps set", op: baseOp(), validUntil: 1_800_000_000, validAfter: 1_700_000_000},
      {name: "max uint48 window", op: baseOp(), validUntil: 281_474_976_710_655, validAfter: 0},
      {name: "long callData", op: baseOp({callData: `0x${"ab".repeat(1000)}`}), validUntil: 1_800_000_000, validAfter: 0},
    ];

    for (const {name, op, validUntil, validAfter} of cases) {
      const expected = await onChainHash(op, validUntil, validAfter);
      const actual = sponsorshipDigest({
        userOp: op,
        chainId: anvil.publicClient.chain!.id,
        paymaster,
        validUntil,
        validAfter,
      });
      expect(actual, `digest mismatch for case: ${name}`).toBe(expected);
    }
  });

  it("digest is sensitive to every signed field", async () => {
    const validUntil = 1_800_000_000;
    const base = sponsorshipDigest({
      userOp: baseOp(),
      chainId: anvil.publicClient.chain!.id,
      paymaster,
      validUntil,
      validAfter: 0,
    });

    const mutations: Array<[string, PackedUserOperation]> = [
      ["sender", baseOp({sender: "0x0000000000000000000000000000000000000001"})],
      ["nonce", baseOp({nonce: 1n})],
      ["initCode", baseOp({initCode: "0x01"})],
      ["callData", baseOp({callData: "0xdeadbeef00"})],
      ["accountGasLimits", baseOp({accountGasLimits: toHex(packUint128Pair(500_001n, 200_000n), {size: 32})})],
      ["preVerificationGas", baseOp({preVerificationGas: 100_001n})],
      ["gasFees", baseOp({gasFees: toHex(packUint128Pair(1n, 20_000_000_000n), {size: 32})})],
      [
        "paymasterGasLimits",
        baseOp({
          paymasterAndData: encodePaymasterAndDataPrefix({
            paymaster,
            paymasterVerificationGasLimit: PM_VERIFICATION_GAS + 1n,
            postOpGasLimit: POSTOP_GAS,
            validUntil: 0,
            validAfter: 0,
          }),
        }),
      ],
    ];

    for (const [field, op] of mutations) {
      const mutated = sponsorshipDigest({
        userOp: op,
        chainId: anvil.publicClient.chain!.id,
        paymaster,
        validUntil,
        validAfter: 0,
      });
      expect(mutated, `digest must change when ${field} changes`).not.toBe(base);
    }

    // The timestamps are signed too.
    const differentWindow = sponsorshipDigest({
      userOp: baseOp(),
      chainId: anvil.publicClient.chain!.id,
      paymaster,
      validUntil: validUntil + 1,
      validAfter: 0,
    });
    expect(differentWindow).not.toBe(base);
  });

  it("a signature the engine produces is accepted by the contract's own recovery", async () => {
    const engine = new SignatureEngine(new LocalSponsorshipSigner(signerKey));
    const validUntil = 1_800_000_000;

    const attestation = await engine.attest({
      userOp: baseOp(),
      chainId: anvil.publicClient.chain!.id,
      paymaster,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
      validUntil,
      validAfter: 0,
    });

    // Rebuild the op exactly as it would be submitted, then ask the contract to hash it and
    // verify our signature recovers the authorised signer.
    const submitted = baseOp({paymasterAndData: attestation.paymasterAndData});
    const digest = await onChainHash(submitted, validUntil, 0);

    const {recoverAddress} = await import("viem");
    const recovered = await recoverAddress({
      hash: digest,
      signature: decodePaymasterAndData(attestation.paymasterAndData).signature,
    });

    expect(recovered).toBe(signer.address);
    expect(attestation.signer).toBe(signer.address);

    const isAuthorised = await anvil.publicClient.readContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: "isSigner",
      args: [recovered],
    });
    expect(isAuthorised).toBe(true);
  });

  it("paymasterAndData offsets match the contract's parser", async () => {
    const engine = new SignatureEngine(new LocalSponsorshipSigner(signerKey));
    const validUntil = 1_800_000_000;
    const validAfter = 1_700_000_000;

    const attestation = await engine.attest({
      userOp: baseOp(),
      chainId: anvil.publicClient.chain!.id,
      paymaster,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
      validUntil,
      validAfter,
    });

    const parsed = (await anvil.publicClient.readContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: "parsePaymasterAndData",
      args: [attestation.paymasterAndData],
    })) as readonly [number, number, Hex];

    expect(parsed[0], "contract must read back our validUntil").toBe(validUntil);
    expect(parsed[1], "contract must read back our validAfter").toBe(validAfter);
    expect(parsed[2].length, "contract must read back a 65-byte signature").toBe(2 + 65 * 2);
  });
});
