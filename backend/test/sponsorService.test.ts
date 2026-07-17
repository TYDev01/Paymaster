import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi, parseEther, toHex, type Address, type Hex} from "viem";

import {CANONICAL_ENTRYPOINT_V07, type ChainConfig} from "../src/chain/chainConfig.js";
import {ChainRegistry} from "../src/chain/chainRegistry.js";
import {PolicyEngine, type Policy} from "../src/policy/engine.js";
import {PolicySource} from "../src/policy/policySource.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {QuotaRule} from "../src/policy/rules/quotaRules.js";
import {SenderBlocklistRule} from "../src/policy/rules/accessLists.js";
import {SignatureEngine} from "../src/signature/signatureEngine.js";
import {LocalSponsorshipSigner, type SponsorshipSigner} from "../src/signature/signer.js";
import {
  SponsorService,
  SponsorshipDeniedError,
  type SponsorshipRecorder,
} from "../src/api/sponsor/sponsor.service.js";
import type {SponsorRequest} from "../src/api/dto/sponsorRequest.js";

const SIGNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SENDER = "0x1234567890123456789012345678901234567890" as Address;
const PAYMASTER = "0x1111111111111111111111111111111111111111" as Address;
const CHAIN_ID = 8453;

/**
 * A signer that fails on demand.
 *
 * This is a test double for a PORT, not a mock of our own logic — it stands in for a KMS being
 * unreachable, which is the failure this test is about and which cannot be produced with a real
 * signer. The rest of the graph (policy engine, signature engine, registry) is the real thing.
 */
class FailingSigner implements SponsorshipSigner {
  readonly address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
  constructor(private readonly error: Error) {}
  async signDigest(): Promise<Hex> {
    throw this.error;
  }
}

function chainConfig(): ChainConfig {
  return {
    chainId: CHAIN_ID,
    name: "Base",
    rpcUrls: ["https://base.example.com"],
    entryPoint: CANONICAL_ENTRYPOINT_V07,
    paymaster: PAYMASTER,
    explorerUrl: "https://basescan.org",
    nativeCurrency: {symbol: "ETH", decimals: 18},
    minDepositWei: parseEther("1"),
    minStakeWei: parseEther("1"),
    enabled: true,
  };
}

function request(): SponsorRequest {
  return {
    chainId: CHAIN_ID,
    userOperation: {
      sender: SENDER,
      nonce: 0n,
      callData: encodeFunctionData({
        abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
        functionName: "execute",
        args: ["0x000000000000000000000000000000000000dEaD", 0n, "0x"],
      }),
      callGasLimit: 200_000n,
      verificationGasLimit: 500_000n,
      preVerificationGas: 100_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    },
  } as SponsorRequest;
}

async function buildService(
  signer: SponsorshipSigner,
  policies: readonly Policy[],
  now = 1_700_000_000,
  sponsorships?: SponsorshipRecorder,
) {
  const source = new PolicySource({load: async () => policies});
  await source.reload();

  return new SponsorService({
    chains: ChainRegistry.fromConfigs([chainConfig()]),
    policies: source,
    policyEngine: new PolicyEngine(),
    signatureEngine: new SignatureEngine(signer),
    sponsorships,
    options: {
      validitySeconds: 300,
      paymasterVerificationGasLimit: 300_000n,
      postOpGasLimit: 50_000n,
      defaultPolicyId: "default",
    },
    now: () => now,
  });
}

describe("SponsorService", () => {
  it("attests when policy approves", async () => {
    const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [{id: "default", rules: []}]);
    const response = await service.sponsor(request());

    expect(response.paymaster).toBe(PAYMASTER);
    expect(response.metadata.policyId).toBe("default");
    expect(response.validUntil).toBe(1_700_000_000 + 300);
    expect(response.validAfter).toBe(0);
  });

  it("prices the operation with our gas limits, not the caller's", async () => {
    const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [{id: "default", rules: []}]);
    const response = await service.sponsor(request());

    // (500_000 + 200_000 + 300_000 + 50_000 + 100_000) * 20 gwei
    expect(response.metadata.maxCost).toBe(String(1_150_000n * 20_000_000_000n));
  });

  it("throws SponsorshipDeniedError carrying the denial", async () => {
    const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [
      {id: "default", rules: [new SenderBlocklistRule([SENDER])]},
    ]);

    await expect(service.sponsor(request())).rejects.toThrow(SponsorshipDeniedError);
    await expect(service.sponsor(request())).rejects.toMatchObject({
      denial: {code: "SENDER_BLOCKED", rule: "sender-blocklist"},
    });
  });

  /**
   * The compensation path the engine cannot perform itself: policy has already reserved budget by
   * the time signing runs, and only the service knows whether an attestation actually made it out.
   * Without this, a KMS outage would silently burn every caller's daily quota.
   */
  it("releases reserved quota when signing fails", async () => {
    const store = new InMemoryQuotaStore();
    const quota = new QuotaRule(store, {
      name: "wallet-daily",
      subject: "wallet",
      unit: "operations",
      limit: 3n,
      windowSeconds: 86_400,
    });
    const service = await buildService(new FailingSigner(new Error("KMS unreachable")), [
      {id: "default", rules: [quota]},
    ]);

    await expect(service.sponsor(request())).rejects.toThrow("KMS unreachable");

    const usage = await store.usage(`quota:wallet-daily:${CHAIN_ID}:${SENDER.toLowerCase()}`, 86_400, 1_700_000_000);
    expect(usage, "a failed sponsorship must not consume quota").toBe(0n);
  });

  it("still surfaces the original error when signing fails", async () => {
    const service = await buildService(new FailingSigner(new Error("KMS unreachable")), [{id: "default", rules: []}]);
    await expect(service.sponsor(request())).rejects.toThrow("KMS unreachable");
  });

  /** A release failure must not mask the error that caused it. */
  it("does not mask the signing error if the release also fails", async () => {
    const brokenStore = new InMemoryQuotaStore();
    const quota = new QuotaRule(brokenStore, {
      name: "wallet-daily",
      subject: "wallet",
      unit: "operations",
      limit: 3n,
      windowSeconds: 86_400,
    });
    // Break release after the reservation has been made.
    quota.release = async () => {
      throw new Error("store unreachable during release");
    };

    const service = await buildService(new FailingSigner(new Error("KMS unreachable")), [
      {id: "default", rules: [quota]},
    ]);

    await expect(service.sponsor(request())).rejects.toThrow("KMS unreachable");
  });

  it("does not consume quota when the request is denied outright", async () => {
    const store = new InMemoryQuotaStore();
    const quota = new QuotaRule(store, {
      name: "wallet-daily",
      subject: "wallet",
      unit: "operations",
      limit: 3n,
      windowSeconds: 86_400,
    });
    const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [
      {id: "default", rules: [quota, new SenderBlocklistRule([SENDER])]},
    ]);

    await expect(service.sponsor(request())).rejects.toThrow(SponsorshipDeniedError);

    const usage = await store.usage(`quota:wallet-daily:${CHAIN_ID}:${SENDER.toLowerCase()}`, 86_400, 1_700_000_000);
    expect(usage).toBe(0n);
  });

  it("consumes quota for a sponsorship that succeeds", async () => {
    const store = new InMemoryQuotaStore();
    const quota = new QuotaRule(store, {
      name: "wallet-daily",
      subject: "wallet",
      unit: "operations",
      limit: 3n,
      windowSeconds: 86_400,
    });
    const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [{id: "default", rules: [quota]}]);

    await service.sponsor(request());

    const usage = await store.usage(`quota:wallet-daily:${CHAIN_ID}:${SENDER.toLowerCase()}`, 86_400, 1_700_000_000);
    expect(usage).toBe(1n);
  });

  describe("recording", () => {
    it("records what it committed to pay", async () => {
      const recorded: Parameters<SponsorshipRecorder["record"]>[0][] = [];
      const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [{id: "default", rules: []}], 1_700_000_000, {
        record: async (s) => void recorded.push(s),
      });

      await service.sponsor(request(), {apiKeyId: "key-1"});

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        chainId: CHAIN_ID,
        sender: SENDER,
        apiKeyId: "key-1",
        policyId: "default",
        maxCostWei: 1_150_000n * 20_000_000_000n,
      });
    });

    /**
     * Auditability over availability: an attestation we cannot account for is worse than a
     * sponsorship we declined. A recorder failure must not produce a silently unrecorded promise.
     */
    it("does not return an attestation it could not record", async () => {
      const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [{id: "default", rules: []}], 1_700_000_000, {
        record: async () => {
          throw new Error("database unreachable");
        },
      });

      await expect(service.sponsor(request())).rejects.toThrow("database unreachable");
    });

    it("refunds quota when recording fails", async () => {
      const store = new InMemoryQuotaStore();
      const quota = new QuotaRule(store, {
        name: "wallet-daily",
        subject: "wallet",
        unit: "operations",
        limit: 3n,
        windowSeconds: 86_400,
      });
      const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [{id: "default", rules: [quota]}], 1_700_000_000, {
        record: async () => {
          throw new Error("database unreachable");
        },
      });

      await expect(service.sponsor(request())).rejects.toThrow("database unreachable");

      const usage = await store.usage(`quota:wallet-daily:${CHAIN_ID}:${SENDER.toLowerCase()}`, 86_400, 1_700_000_000);
      expect(usage, "a sponsorship we could not record must not consume quota").toBe(0n);
    });
  });

  it("passes caller identity through to policy", async () => {
    const store = new InMemoryQuotaStore();
    const quota = new QuotaRule(store, {
      name: "ip-hourly",
      subject: "ip",
      unit: "operations",
      limit: 1n,
      windowSeconds: 3_600,
    });
    const service = await buildService(new LocalSponsorshipSigner(SIGNER_KEY), [{id: "default", rules: [quota]}]);

    await service.sponsor(request(), {clientIp: "203.0.113.7"});
    await expect(service.sponsor(request(), {clientIp: "203.0.113.7"})).rejects.toThrow(SponsorshipDeniedError);

    // A different IP has its own budget.
    await expect(service.sponsor(request(), {clientIp: "203.0.113.8"})).resolves.toBeDefined();
  });
});
