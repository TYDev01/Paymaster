import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {toHex, type Address} from "viem";

import {packUint128Pair, type PackedUserOperation} from "../src/domain/userOperation.js";
import type {PolicyContext} from "../src/policy/context.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {RedisQuotaStore} from "../src/policy/quota/redisQuotaStore.js";
import {windowEnd, type QuotaStore} from "../src/policy/quota/quotaStore.js";
import {QuotaRule} from "../src/policy/rules/quotaRules.js";
import {startRedis, type TestRedis} from "./support/redis.js";

const NOW = 1_700_000_000;
const SENDER = "0x1234567890123456789012345678901234567890" as Address;

function context(over: Partial<PolicyContext> = {}): PolicyContext {
  const userOp: PackedUserOperation = {
    sender: SENDER,
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    accountGasLimits: toHex(packUint128Pair(500_000n, 200_000n), {size: 32}),
    preVerificationGas: 100_000n,
    gasFees: toHex(packUint128Pair(1_000_000_000n, 20_000_000_000n), {size: 32}),
    paymasterAndData: "0x",
    signature: "0x",
  };
  return {
    chainId: 8453,
    sender: SENDER,
    userOp,
    calls: undefined,
    clientIp: "203.0.113.7",
    apiKeyId: "key-1",
    maxCost: 10n ** 15n, // 0.001 ETH = 1e6 gwei
    now: NOW,
    ...over,
  };
}

describe("RedisQuotaStore", () => {
  let redis: TestRedis;
  let store: RedisQuotaStore;

  beforeAll(async () => {
    redis = await startRedis();
    store = new RedisQuotaStore(redis.redis);
  }, 60_000);

  afterAll(async () => {
    await redis?.stop();
  });

  beforeEach(async () => {
    await redis.redis.flushall();
  });

  it("consumes up to the limit then refuses", async () => {
    const params = {key: "k", amount: 1n, limit: 2n, windowSeconds: 60, now: NOW};
    expect((await store.tryConsume(params)).consumed).toBe(true);
    expect((await store.tryConsume(params)).consumed).toBe(true);

    const refused = await store.tryConsume(params);
    expect(refused.consumed).toBe(false);
    expect(refused.usage, "a refusal must not consume").toBe(2n);
  });

  it("reports the window reset time", async () => {
    const outcome = await store.tryConsume({key: "k", amount: 1n, limit: 5n, windowSeconds: 60, now: NOW});
    // Windows are FIXED and epoch-aligned, not relative to now: the window containing NOW ends at
    // the next 60s boundary, which is generally sooner than NOW + 60.
    expect(outcome.resetsAt).toBe(windowEnd(NOW, 60));
    expect(outcome.resetsAt).toBeGreaterThan(NOW);
    expect(outcome.resetsAt).toBeLessThanOrEqual(NOW + 60);
    expect(outcome.limit).toBe(5n);
  });

  it("counts each key separately", async () => {
    await store.tryConsume({key: "a", amount: 1n, limit: 1n, windowSeconds: 60, now: NOW});
    expect((await store.tryConsume({key: "b", amount: 1n, limit: 1n, windowSeconds: 60, now: NOW})).consumed).toBe(true);
  });

  it("starts a fresh count in the next window", async () => {
    const params = {key: "k", amount: 1n, limit: 1n, windowSeconds: 60, now: NOW};
    expect((await store.tryConsume(params)).consumed).toBe(true);
    expect((await store.tryConsume(params)).consumed).toBe(false);
    expect((await store.tryConsume({...params, now: NOW + 60})).consumed).toBe(true);
  });

  it("releases budget", async () => {
    const params = {key: "k", amount: 1n, limit: 1n, windowSeconds: 60, now: NOW};
    await store.tryConsume(params);
    expect((await store.tryConsume(params)).consumed).toBe(false);

    await store.release({key: "k", amount: 1n, windowSeconds: 60, now: NOW});
    expect((await store.tryConsume(params)).consumed).toBe(true);
  });

  /** A release for a rolled-over window must not push the new counter negative and give free budget. */
  it("clamps release at zero", async () => {
    await store.tryConsume({key: "k", amount: 1n, limit: 10n, windowSeconds: 60, now: NOW});
    await store.release({key: "k", amount: 5n, windowSeconds: 60, now: NOW});
    expect(await store.usage("k", 60, NOW)).toBe(0n);
  });

  it("reports zero usage for an untouched key", async () => {
    expect(await store.usage("never-seen", 60, NOW)).toBe(0n);
  });

  /**
   * The property the whole design turns on. A client-side GET-then-INCRBY grants the last unit to
   * every request that reads before any of them writes; the Lua script cannot be interleaved.
   */
  it("does not over-grant under concurrent consumption", async () => {
    const params = {key: "hot", amount: 1n, limit: 5n, windowSeconds: 60, now: NOW};
    const results = await Promise.all(Array.from({length: 200}, () => store.tryConsume(params)));

    expect(results.filter((r) => r.consumed)).toHaveLength(5);
    expect(await store.usage("hot", 60, NOW)).toBe(5n);
  });

  /** Independent connections are what a multi-replica deployment actually looks like. */
  it("does not over-grant across separate connections", async () => {
    const {default: Redis} = await import("ioredis");
    const clients = Array.from({length: 5}, () => new Redis({host: "127.0.0.1", port: redis.port}));

    try {
      const stores = clients.map((client) => new RedisQuotaStore(client));
      const params = {key: "replicas", amount: 1n, limit: 3n, windowSeconds: 60, now: NOW};
      const results = await Promise.all(stores.flatMap((s) => Array.from({length: 20}, () => s.tryConsume(params))));

      expect(results.filter((r) => r.consumed), "the limit must hold across replicas").toHaveLength(3);
    } finally {
      // Left open, these keep reconnecting after the server stops and surface as unhandled
      // ioredis error events — noise that would hide a real connection leak later.
      await Promise.all(clients.map((client) => client.quit().catch(() => client.disconnect())));
    }
  });

  describe("expiry", () => {
    it("sets a TTL that outlives the window", async () => {
      await store.tryConsume({key: "k", amount: 1n, limit: 5n, windowSeconds: 60, now: NOW});
      const ttl = await redis.redis.ttl(`k:60:${Math.floor(NOW / 60) * 60}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl, "TTL must cover the window plus clock-skew buffer").toBeLessThanOrEqual(60 + 60);
    });

    /**
     * Re-arming the TTL on every increment would slide the window forward for as long as a caller
     * keeps spending, so a busy key would never reset — the cap would become unenforceable exactly
     * for the callers it matters most for.
     */
    it("does not extend the TTL on subsequent consumption", async () => {
      const slot = `k:60:${Math.floor(NOW / 60) * 60}`;
      await store.tryConsume({key: "k", amount: 1n, limit: 100n, windowSeconds: 60, now: NOW});
      const first = await redis.redis.pttl(slot);

      await new Promise((r) => setTimeout(r, 50));
      await store.tryConsume({key: "k", amount: 1n, limit: 100n, windowSeconds: 60, now: NOW});
      const second = await redis.redis.pttl(slot);

      expect(second, "a busy key must still expire").toBeLessThan(first);
    });
  });

  describe("integer limits", () => {
    /**
     * Redis INCRBY is a signed 64-bit integer: it errors past 9.22e18, which is 9.22 ETH in wei.
     * This test documents the constraint that forces spend accounting into gwei.
     */
    it("INCRBY cannot hold a wei amount above ~9.22 ETH", async () => {
      // 5 ETH in wei fits a signed 64-bit integer...
      await expect(redis.redis.incrby("raw", "5000000000000000000")).resolves.toBe(5_000_000_000_000_000_000);
      // ...but 10 ETH does not. This is the constraint that forces spend accounting into gwei.
      await expect(redis.redis.incrby("raw", "5000000000000000000")).rejects.toThrow(/overflow/i);
    });

    it("counts 10 ETH of spend comfortably in gwei", async () => {
      // 10 ETH = 1e10 gwei — the amount that cannot be counted in wei at all.
      const tenEthInGwei = 10_000_000_000n;
      const outcome = await store.tryConsume({
        key: "spend",
        amount: tenEthInGwei,
        limit: tenEthInGwei,
        windowSeconds: 86_400,
        now: NOW,
      });
      expect(outcome.consumed).toBe(true);
      expect(await store.usage("spend", 86_400, NOW)).toBe(tenEthInGwei);
    });
  });
});

/**
 * The same behavioural suite against both stores.
 *
 * They are interchangeable by contract, so the contract should be asserted identically. A
 * divergence here means the in-memory store the unit tests rely on does not behave like the Redis
 * store production runs on — which would make the whole test suite a comfortable fiction.
 */
describe.each([
  ["InMemoryQuotaStore", async () => ({store: new InMemoryQuotaStore() as QuotaStore, stop: async () => undefined})],
  [
    "RedisQuotaStore",
    async () => {
      const r = await startRedis();
      return {store: new RedisQuotaStore(r.redis) as QuotaStore, stop: r.stop};
    },
  ],
])("QuotaStore contract: %s", (_name, make) => {
  let store: QuotaStore;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({store, stop} = await make());
  }, 60_000);

  afterAll(async () => {
    await stop?.();
  });

  it("admits exactly the limit", async () => {
    const key = `contract-${Math.random()}`;
    const params = {key, amount: 1n, limit: 3n, windowSeconds: 60, now: NOW};
    const results = await Promise.all(Array.from({length: 10}, () => store.tryConsume(params)));
    expect(results.filter((r) => r.consumed)).toHaveLength(3);
  });

  it("refuses an amount larger than the whole limit", async () => {
    const key = `contract-big-${Math.random()}`;
    const outcome = await store.tryConsume({key, amount: 10n, limit: 3n, windowSeconds: 60, now: NOW});
    expect(outcome.consumed).toBe(false);
    expect(outcome.usage).toBe(0n);
  });

  it("permits a zero limit to admit nothing", async () => {
    const key = `contract-zero-${Math.random()}`;
    expect((await store.tryConsume({key, amount: 1n, limit: 0n, windowSeconds: 60, now: NOW})).consumed).toBe(false);
  });

  it("reports usage after consumption", async () => {
    const key = `contract-usage-${Math.random()}`;
    await store.tryConsume({key, amount: 2n, limit: 10n, windowSeconds: 60, now: NOW});
    expect(await store.usage(key, 60, NOW)).toBe(2n);
  });

  it("release then consume again", async () => {
    const key = `contract-release-${Math.random()}`;
    await store.tryConsume({key, amount: 1n, limit: 1n, windowSeconds: 60, now: NOW});
    await store.release({key, amount: 1n, windowSeconds: 60, now: NOW});
    expect((await store.tryConsume({key, amount: 1n, limit: 1n, windowSeconds: 60, now: NOW})).consumed).toBe(true);
  });

  it("isolates windows", async () => {
    const key = `contract-window-${Math.random()}`;
    await store.tryConsume({key, amount: 1n, limit: 1n, windowSeconds: 60, now: NOW});
    expect((await store.tryConsume({key, amount: 1n, limit: 1n, windowSeconds: 60, now: NOW + 60})).consumed).toBe(true);
  });

  it("drives a QuotaRule spend cap identically", async () => {
    const rule = new QuotaRule(store, {
      name: `spend-${Math.random()}`,
      subject: "wallet",
      unit: "wei",
      // 2.5x maxCost of 1e15 wei.
      limit: 25n * 10n ** 14n,
      windowSeconds: 86_400,
    });

    expect((await rule.evaluate(context())).allowed).toBe(true);
    expect((await rule.evaluate(context())).allowed).toBe(true);
    expect(await rule.evaluate(context())).toMatchObject({allowed: false, code: "SPEND_CAP_EXCEEDED"});
  });

  /** Spend caps are configured and reported in wei even though they are counted in gwei. */
  it("reports remaining spend in wei", async () => {
    const rule = new QuotaRule(store, {
      name: `remaining-${Math.random()}`,
      subject: "wallet",
      unit: "wei",
      limit: 10n ** 16n, // 0.01 ETH
      windowSeconds: 86_400,
    });

    expect(await rule.remaining(context())).toBe(10n ** 16n);
    await rule.evaluate(context()); // charges 1e15 wei
    expect(await rule.remaining(context())).toBe(9n * 10n ** 15n);
  });

  /** A cap that can be bypassed by making requests small enough is not a cap. */
  it("charges at least one gwei for a sub-gwei operation", async () => {
    const rule = new QuotaRule(store, {
      name: `dust-${Math.random()}`,
      subject: "wallet",
      unit: "wei",
      limit: 10n ** 9n * 3n, // 3 gwei
      windowSeconds: 86_400,
    });

    // 1 wei each: rounding down would make these free and the cap meaningless.
    const dust = context({maxCost: 1n});
    expect((await rule.evaluate(dust)).allowed).toBe(true);
    expect((await rule.evaluate(dust)).allowed).toBe(true);
    expect((await rule.evaluate(dust)).allowed).toBe(true);
    expect(await rule.evaluate(dust), "sub-gwei operations must still exhaust the cap").toMatchObject({
      allowed: false,
    });
  });

  it("counts a 10 ETH daily cap, which wei could not", async () => {
    const rule = new QuotaRule(store, {
      name: `big-${Math.random()}`,
      subject: "global",
      unit: "wei",
      limit: 10n * 10n ** 18n, // 10 ETH — beyond int64 in wei
      windowSeconds: 86_400,
    });

    // Each op costs 1 ETH.
    const oneEth = context({maxCost: 10n ** 18n});
    for (let i = 0; i < 10; i++) {
      expect((await rule.evaluate(oneEth)).allowed, `op ${i} must be allowed`).toBe(true);
    }
    expect(await rule.evaluate(oneEth), "the 11th ETH must exceed a 10 ETH cap").toMatchObject({allowed: false});
  });
});
