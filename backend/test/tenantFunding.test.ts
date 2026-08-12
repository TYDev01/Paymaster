import {beforeEach, describe, expect, it} from "vitest";
import {encodeFunctionData, keccak256, parseAbi, parseEther, toHex, type Address, type Hex} from "viem";

import type {SponsorRequest} from "../src/api/dto/sponsorRequest.js";
import {SponsorService} from "../src/api/sponsor/sponsor.service.js";
import {CANONICAL_ENTRYPOINT_V07} from "../src/chain/chainConfig.js";
import {ChainRegistry} from "../src/chain/chainRegistry.js";
import {TenantBalanceReader} from "../src/chain/tenantBalance.js";
import {tenantId} from "../src/db/scope.js";
import {PolicyEngine} from "../src/policy/engine.js";
import {PolicySource} from "../src/policy/policySource.js";
import {decodePaymasterAndData} from "../src/signature/paymasterAndData.js";
import {onChainTenantKey} from "../src/signature/paymasterLayout.js";
import {SignatureEngine} from "../src/signature/signatureEngine.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import {ACME as ACME_TENANT} from "./support/tenants.js";

const ACME = tenantId("t_acme");
const RIVAL = tenantId("t_rival");

/**
 * A registry stub. The real one needs RPC endpoints; what is under test here is the caching and
 * the scoping around the read, not viem's ability to make a call — that is asserted against real
 * bytecode in `tenantDifferential.test.ts`.
 */
function registryOf(balances: Record<string, bigint>, onRead?: () => void) {
  const reads = {count: 0};
  const registry = {
    get: (chainId: number) => ({
      config: {chainId, paymasterKind: "tenant" as const},
      getTenantBalance: async (key: string) => {
        reads.count += 1;
        onRead?.();
        return balances[key] ?? 0n;
      },
    }),
  } as unknown as ChainRegistry;
  return {registry, reads};
}

describe("TenantBalanceReader", () => {
  let clock = 1_000;
  const nowMs = () => clock;

  beforeEach(() => {
    clock = 1_000;
  });

  it("derives the on-chain key from the tenant id, and it is the one the contract is asked about", async () => {
    const key = onChainTenantKey(ACME);
    expect(key).toBe(keccak256(toHex("t_acme")));

    const {registry} = registryOf({[key]: parseEther("2")});
    const reader = new TenantBalanceReader(registry, {nowMs});

    expect(await reader.balanceOf(8453, ACME)).toBe(parseEther("2"));
    expect(reader.keyFor(ACME)).toBe(key);
  });

  it("never reports one tenant's balance for another", async () => {
    const {registry} = registryOf({[onChainTenantKey(ACME)]: parseEther("5")});
    const reader = new TenantBalanceReader(registry, {nowMs});

    expect(await reader.balanceOf(8453, ACME)).toBe(parseEther("5"));
    expect(await reader.balanceOf(8453, RIVAL)).toBe(0n);
  });

  it("caches within the TTL and re-reads after it", async () => {
    const {registry, reads} = registryOf({[onChainTenantKey(ACME)]: parseEther("1")});
    const reader = new TenantBalanceReader(registry, {nowMs, ttlMs: 3_000});

    await reader.balanceOf(8453, ACME);
    await reader.balanceOf(8453, ACME);
    expect(reads.count, "second read inside the TTL should be served from cache").toBe(1);

    clock += 3_001;
    await reader.balanceOf(8453, ACME);
    expect(reads.count).toBe(2);
  });

  it("caches per chain, since the same tenant funds each chain separately", async () => {
    // Balances are per chain on purpose: a customer funds Base and Optimism independently. A cache
    // keyed only by tenant would report the Base balance while spending on Optimism.
    const {registry, reads} = registryOf({[onChainTenantKey(ACME)]: parseEther("1")});
    const reader = new TenantBalanceReader(registry, {nowMs});

    await reader.balanceOf(8453, ACME);
    await reader.balanceOf(10, ACME);
    expect(reads.count).toBe(2);
  });

  it("drops the cached balance when told the tenant has just spent", async () => {
    const {registry, reads} = registryOf({[onChainTenantKey(ACME)]: parseEther("1")});
    const reader = new TenantBalanceReader(registry, {nowMs});

    await reader.balanceOf(8453, ACME);
    reader.invalidate(8453, ACME);
    await reader.balanceOf(8453, ACME);

    // The tenant about to run out is exactly the one who asks again immediately, so a reading taken
    // before their last spend is the most misleading number the cache could hold.
    expect(reads.count).toBe(2);
  });

  it("only invalidates the chain it was told about", async () => {
    const {registry, reads} = registryOf({[onChainTenantKey(ACME)]: parseEther("1")});
    const reader = new TenantBalanceReader(registry, {nowMs});

    await reader.balanceOf(8453, ACME);
    await reader.balanceOf(10, ACME);
    reader.invalidate(8453, ACME);

    await reader.balanceOf(10, ACME);
    expect(reads.count, "chain 10 was untouched and should still be cached").toBe(2);
  });

  it("propagates a read failure rather than reporting zero", async () => {
    // Zero would be a lie with consequences: the caller's next move on a zero balance is to refuse
    // a paying customer. An unreadable balance is not an empty one, and the caller decides.
    const registry = {
      get: () => ({
        config: {chainId: 8453, paymasterKind: "tenant" as const},
        getTenantBalance: async () => {
          throw new Error("rpc down");
        },
      }),
    } as unknown as ChainRegistry;

    await expect(new TenantBalanceReader(registry).balanceOf(8453, ACME)).rejects.toThrow("rpc down");
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const registry = {
      get: () => ({
        config: {chainId: 8453, paymasterKind: "tenant" as const},
        getTenantBalance: async () => {
          if (fail) throw new Error("rpc down");
          return parseEther("3");
        },
      }),
    } as unknown as ChainRegistry;
    const reader = new TenantBalanceReader(registry, {nowMs});

    await expect(reader.balanceOf(8453, ACME)).rejects.toThrow();
    fail = false;
    // A cached failure would keep refusing a funded tenant for the whole TTL after the RPC recovered.
    expect(await reader.balanceOf(8453, ACME)).toBe(parseEther("3"));
  });
});

describe("ChainAdapter.getTenantBalance", () => {
  it("refuses to read per-tenant balances from a single-tenant paymaster", async () => {
    // Not a runtime condition to handle: `VerifyingPaymaster` has one shared deposit and no such
    // mapping, so asking is a bug in the caller. Returning zero would make it look like a funding
    // problem instead.
    const {ChainAdapter} = await import("../src/chain/chainAdapter.js");
    const adapter = ChainAdapter.create({
      chainId: 8453,
      name: "Base",
      rpcUrls: ["http://127.0.0.1:1"],
      entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      paymaster: "0x1111111111111111111111111111111111111111" as Address,
      paymasterKind: "verifying",
      explorerUrl: "https://basescan.org",
      nativeCurrency: {symbol: "ETH", decimals: 18},
      minDepositWei: 0n,
      minStakeWei: 0n,
      enabled: true,
    });

    await expect(adapter.getTenantBalance(onChainTenantKey(ACME))).rejects.toThrow(/no per-tenant balances/);
  });
});

describe("what the balance check is and is not", () => {
  it("reads the last mined state, so in-flight attestations are invisible to it", async () => {
    // Written down as a test because the comment alone invites the wrong conclusion. Two requests
    // that each fit inside the balance but do not fit TOGETHER both pass here — the contract's
    // reservation is what stops the second, and this check never could.
    const balance = parseEther("1");
    const {registry} = registryOf({[onChainTenantKey(ACME)]: balance});
    const reader = new TenantBalanceReader(registry, {nowMs: () => 0});

    const maxCost = parseEther("0.6");
    expect(await reader.balanceOf(8453, ACME)).toBeGreaterThan(maxCost);
    expect(await reader.balanceOf(8453, ACME)).toBeGreaterThan(maxCost);
    expect(maxCost * 2n).toBeGreaterThan(balance);
  });
});

describe("SponsorService on a multi-tenant chain", () => {
  const SENDER = "0x1234567890123456789012345678901234567890" as Address;
  const PAYMASTER = "0x1111111111111111111111111111111111111111" as Address;
  const SIGNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const CHAIN_ID = 8453;

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

  /** maxCost for the request above: (500k + 200k + 300k + 50k + 100k) * 20 gwei. */
  const MAX_COST = 1_150_000n * 20_000_000_000n;

  async function buildService(tenantBalances?: TenantBalanceReader) {
    const source = new PolicySource({load: async () => [{tenantId: ACME_TENANT, id: "default", rules: []}]});
    await source.reload();

    return new SponsorService({
      chains: ChainRegistry.fromConfigs([
        {
          chainId: CHAIN_ID,
          name: "Base",
          rpcUrls: ["https://base.example.com"],
          entryPoint: CANONICAL_ENTRYPOINT_V07,
          paymaster: PAYMASTER,
          paymasterKind: "tenant",
          explorerUrl: "https://basescan.org",
          nativeCurrency: {symbol: "ETH", decimals: 18},
          minDepositWei: 0n,
          minStakeWei: 0n,
          enabled: true,
        },
      ]),
      policies: source,
      policyEngine: new PolicyEngine(),
      signatureEngine: new SignatureEngine(new LocalSponsorshipSigner(SIGNER_KEY)),
      ...(tenantBalances === undefined ? {} : {tenantBalances}),
      options: {
        validitySeconds: 300,
        paymasterVerificationGasLimit: 300_000n,
        postOpGasLimit: 50_000n,
        defaultPolicyId: "default",
      },
      now: () => 1_700_000_000,
    });
  }

  function readerReturning(balance: bigint | Error): TenantBalanceReader {
    const registry = {
      get: () => ({
        config: {chainId: CHAIN_ID, paymasterKind: "tenant" as const},
        getTenantBalance: async () => {
          if (balance instanceof Error) throw balance;
          return balance;
        },
      }),
    } as unknown as ChainRegistry;
    return new TenantBalanceReader(registry, {ttlMs: 0});
  }

  it("refuses with TENANT_BALANCE_INSUFFICIENT when the balance cannot cover the operation", async () => {
    const service = await buildService(readerReturning(MAX_COST - 1n));

    await expect(service.sponsor(request(), {tenantId: ACME_TENANT})).rejects.toMatchObject({
      denial: {code: "TENANT_BALANCE_INSUFFICIENT"},
    });
  });

  it("sponsors when the balance exactly covers the worst case", async () => {
    // Exactly equal must pass: the contract reserves `maxCost` and succeeds at equality, so
    // refusing here would decline an operation the chain would have accepted.
    const service = await buildService(readerReturning(MAX_COST));
    await expect(service.sponsor(request(), {tenantId: ACME_TENANT})).resolves.toMatchObject({paymaster: PAYMASTER});
  });

  it("signs anyway when the balance cannot be read", async () => {
    // Fails OPEN, deliberately. This check is a friendlier version of a rejection the CONTRACT
    // still makes; failing closed would turn an RPC blip into a total sponsorship outage on every
    // multi-tenant chain, to protect money that is already protected on chain.
    const service = await buildService(readerReturning(new Error("rpc down")));
    await expect(service.sponsor(request(), {tenantId: ACME_TENANT})).resolves.toMatchObject({paymaster: PAYMASTER});
  });

  it("signs anyway when no balance reader is configured", async () => {
    const service = await buildService(undefined);
    await expect(service.sponsor(request(), {tenantId: ACME_TENANT})).resolves.toMatchObject({paymaster: PAYMASTER});
  });

  it("puts the caller's own tenant in the attestation, not one they could name", async () => {
    const service = await buildService(readerReturning(MAX_COST));
    const response = await service.sponsor(request(), {tenantId: ACME_TENANT});

    // The tenant sits at [64:96] of paymasterAndData, and is inside the signed digest.
    const decoded = decodePaymasterAndData(response.paymasterAndData, "tenant");
    expect(decoded.kind === "tenant" && decoded.tenant).toBe(onChainTenantKey(ACME_TENANT));
  });
});
