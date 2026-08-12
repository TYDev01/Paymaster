import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {hashDomain, keccak256, parseEther, recoverAddress, toHex, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {tenantId} from "../src/db/scope.js";
import {packUint128Pair, type PackedUserOperation} from "../src/domain/userOperation.js";
import {decodePaymasterAndData, encodePaymasterAndDataPrefix} from "../src/signature/paymasterAndData.js";
import {onChainTenantKey, TENANT_LAYOUT} from "../src/signature/paymasterLayout.js";
import {SignatureEngine} from "../src/signature/signatureEngine.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import {sponsorshipDigest, sponsorshipDomain} from "../src/signature/typedData.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";

/**
 * The same differential guarantee as `differential.test.ts`, for the multi-tenant contract.
 *
 * It needs its own suite rather than a parameter on that one, because the thing being asserted is
 * that the two are DIFFERENT in exactly the ways `paymasterLayout.ts` claims: a different EIP-712
 * domain name, an extra field in the struct, and 32 extra bytes in `paymasterAndData`. A shared
 * suite that passed for both would most likely mean the layouts had collapsed into one.
 *
 * The stakes are higher here than for the single-tenant contract. There, a layout drift means every
 * sponsorship fails. Here, the tenant is the field that decides WHOSE MONEY PAYS, so a drift in its
 * position or its presence in the digest is the difference between a customer paying for their own
 * operations and a customer paying for someone else's.
 */
describe("signature engine <-> TenantPaymaster differential", () => {
  let anvil: AnvilInstance;
  let paymaster: Address;
  let entryPoint: Address;
  let paymasterAbi: ReturnType<typeof loadArtifact>["abi"];

  const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const signer = privateKeyToAccount(signerKey);
  const owner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

  const PM_VERIFICATION_GAS = 300_000n;
  const POSTOP_GAS = 50_000n;

  const ACME = tenantId("t_acme");
  const RIVAL = tenantId("t_rival");

  beforeAll(async () => {
    anvil = await startAnvil();

    const entryPointArtifact = loadArtifact("EntryPoint.sol", "EntryPoint");
    const paymasterArtifact = loadArtifact("TenantPaymaster.sol", "TenantPaymaster");
    paymasterAbi = paymasterArtifact.abi;

    entryPoint = await deploy(anvil, entryPointArtifact);
    paymaster = await deploy(anvil, paymasterArtifact, [entryPoint, owner, signer.address]);
  }, 60_000);

  afterAll(() => anvil?.stop());

  function baseOp(tenant: Hex, overrides: Partial<PackedUserOperation> = {}): PackedUserOperation {
    return {
      sender: "0x1234567890123456789012345678901234567890",
      nonce: 0n,
      initCode: "0x",
      callData: "0xdeadbeef",
      accountGasLimits: toHex(packUint128Pair(500_000n, 200_000n), {size: 32}),
      preVerificationGas: 100_000n,
      gasFees: toHex(packUint128Pair(1_000_000_000n, 20_000_000_000n), {size: 32}),
      paymasterAndData: encodePaymasterAndDataPrefix({
        kind: "tenant",
        paymaster,
        paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
        postOpGasLimit: POSTOP_GAS,
        validUntil: 0,
        validAfter: 0,
        tenant,
      }),
      signature: "0x",
      ...overrides,
    };
  }

  async function onChainHash(
    op: PackedUserOperation,
    tenant: Hex,
    validUntil: number,
    validAfter: number,
  ): Promise<Hex> {
    return anvil.publicClient.readContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: "getHash",
      args: [op, tenant, validUntil, validAfter],
    }) as Promise<Hex>;
  }

  it("domain separator matches the contract, and differs from the single-tenant one", async () => {
    const onChain = await anvil.publicClient.readContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: "domainSeparator",
    });

    const chainId = anvil.publicClient.chain!.id;
    const domain = sponsorshipDomain(chainId, paymaster, "tenant");
    const types = {
      EIP712Domain: [
        {name: "name", type: "string"},
        {name: "version", type: "string"},
        {name: "chainId", type: "uint256"},
        {name: "verifyingContract", type: "address"},
      ],
    } as const;
    const offChain = hashDomain({domain: {...domain, chainId: BigInt(domain.chainId)}, types});

    expect(offChain).toBe(onChain);

    // And the domain name is genuinely load-bearing: signing with the other contract's name
    // produces a different digest entirely, which would recover to a stranger.
    const verifying = sponsorshipDomain(chainId, paymaster, "verifying");
    expect(hashDomain({domain: {...verifying, chainId: BigInt(chainId)}, types})).not.toBe(onChain);
  });

  it("digest matches the contract for a representative op", async () => {
    const tenant = onChainTenantKey(ACME);
    const op = baseOp(tenant);
    const validUntil = 1_800_000_000;
    const validAfter = 0;

    const expected = await onChainHash(op, tenant, validUntil, validAfter);
    const actual = sponsorshipDigest({
      kind: "tenant",
      userOp: op,
      chainId: anvil.publicClient.chain!.id,
      paymaster,
      validUntil,
      validAfter,
      tenant,
    });

    expect(actual).toBe(expected);
  });

  it("digest matches the contract across varied field values", async () => {
    const chainId = anvil.publicClient.chain!.id;
    const cases: {op: PackedUserOperation; tenant: Hex; validUntil: number; validAfter: number}[] = [
      {op: baseOp(onChainTenantKey(ACME)), tenant: onChainTenantKey(ACME), validUntil: 0, validAfter: 0},
      {
        op: baseOp(onChainTenantKey(RIVAL), {nonce: 2n ** 64n, initCode: "0xabcdef", callData: "0x"}),
        tenant: onChainTenantKey(RIVAL),
        validUntil: 2 ** 48 - 1,
        validAfter: 1,
      },
      {
        // A tenant id at the maximum length the database allows, to prove nothing truncates on the
        // way to a bytes32.
        op: baseOp(onChainTenantKey(tenantId("t_" + "z".repeat(62)))),
        tenant: onChainTenantKey(tenantId("t_" + "z".repeat(62))),
        validUntil: 1_800_000_000,
        validAfter: 1_700_000_000,
      },
    ];

    for (const {op, tenant, validUntil, validAfter} of cases) {
      const expected = await onChainHash(op, tenant, validUntil, validAfter);
      const actual = sponsorshipDigest({
        kind: "tenant",
        userOp: op,
        chainId,
        paymaster,
        validUntil,
        validAfter,
        tenant,
      });
      expect(actual, `digest mismatch for tenant ${tenant}`).toBe(expected);
    }
  });

  it("binds the digest to the tenant, so an attestation cannot be redirected", async () => {
    // THE security property of this contract. If the tenant were outside the digest, a caller
    // holding one valid attestation could edit `paymasterAndData[64:96]` and spend a competitor's
    // balance with our signature still verifying.
    const chainId = anvil.publicClient.chain!.id;
    const acme = onChainTenantKey(ACME);
    const rival = onChainTenantKey(RIVAL);
    const op = baseOp(acme);

    const forAcme = sponsorshipDigest({
      kind: "tenant",
      userOp: op,
      chainId,
      paymaster,
      validUntil: 0,
      validAfter: 0,
      tenant: acme,
    });
    const forRival = sponsorshipDigest({
      kind: "tenant",
      userOp: op,
      chainId,
      paymaster,
      validUntil: 0,
      validAfter: 0,
      tenant: rival,
    });

    expect(forAcme).not.toBe(forRival);
    // Asserted against the contract too, not only against ourselves: both must move together.
    expect(await onChainHash(op, acme, 0, 0)).not.toBe(await onChainHash(op, rival, 0, 0));
  });

  it("a signature the engine produces is accepted by the contract's own recovery", async () => {
    const engine = new SignatureEngine(new LocalSponsorshipSigner(signerKey));
    const tenant = onChainTenantKey(ACME);
    const validUntil = 1_800_000_000;

    const attestation = await engine.attest({
      kind: "tenant",
      userOp: baseOp(tenant),
      chainId: anvil.publicClient.chain!.id,
      paymaster,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
      validUntil,
      validAfter: 0,
      tenant,
    });

    const submitted = baseOp(tenant, {paymasterAndData: attestation.paymasterAndData});
    const digest = await onChainHash(submitted, tenant, validUntil, 0);
    const recovered = await recoverAddress({
      hash: digest,
      signature: decodePaymasterAndData(attestation.paymasterAndData, "tenant").signature,
    });

    expect(recovered).toBe(signer.address);
    expect(
      await anvil.publicClient.readContract({
        address: paymaster,
        abi: paymasterAbi,
        functionName: "isSigner",
        args: [recovered],
      }),
    ).toBe(true);
  });

  it("paymasterAndData offsets match the contract's parser", async () => {
    const engine = new SignatureEngine(new LocalSponsorshipSigner(signerKey));
    const tenant = onChainTenantKey(ACME);
    const validUntil = 1_800_000_000;
    const validAfter = 1_700_000_000;

    const attestation = await engine.attest({
      kind: "tenant",
      userOp: baseOp(tenant),
      chainId: anvil.publicClient.chain!.id,
      paymaster,
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      postOpGasLimit: POSTOP_GAS,
      validUntil,
      validAfter,
      tenant,
    });

    const parsed = (await anvil.publicClient.readContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: "parsePaymasterAndData",
      args: [attestation.paymasterAndData],
    })) as readonly [number, number, Hex, Hex];

    expect(parsed[0], "contract must read back our validUntil").toBe(validUntil);
    expect(parsed[1], "contract must read back our validAfter").toBe(validAfter);
    expect(parsed[2], "contract must read back our tenant").toBe(tenant);
    expect(parsed[3].length, "contract must read back a 65-byte signature").toBe(2 + 65 * 2);

    // The extra 32 bytes are the whole difference between the two layouts, so the length is worth
    // asserting directly rather than inferring it from the parse succeeding.
    expect(attestation.paymasterAndData.length).toBe(2 + (TENANT_LAYOUT.signatureOffset + 65) * 2);
  });

  it("credits the balance our tenant key names, not one the contract derives separately", async () => {
    // `onChainTenantKey` is the only place the id -> bytes32 mapping exists, and nothing on chain
    // can check it. If it drifted, funding would credit one key while sponsorship debited another:
    // the customer's money would be visibly in the contract and permanently unspendable.
    const tenant = onChainTenantKey(ACME);
    expect(tenant).toBe(keccak256(toHex("t_acme")));

    const hash = await anvil.walletClient.writeContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: "depositFor",
      args: [tenant],
      value: parseEther("1"),
      account: anvil.walletClient.account!,
      chain: anvil.walletClient.chain,
    });
    await anvil.publicClient.waitForTransactionReceipt({hash});

    expect(
      await anvil.publicClient.readContract({
        address: paymaster,
        abi: paymasterAbi,
        functionName: "balanceOf",
        args: [tenant],
      }),
    ).toBe(parseEther("1"));

    // And a different tenant sees none of it.
    expect(
      await anvil.publicClient.readContract({
        address: paymaster,
        abi: paymasterAbi,
        functionName: "balanceOf",
        args: [onChainTenantKey(RIVAL)],
      }),
    ).toBe(0n);
  });
});
