import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi, toHex, type Address, type Hex} from "viem";

import {packUint128Pair, type PackedUserOperation} from "../src/domain/userOperation.js";
import {decodeCallTargets} from "../src/policy/callData.js";
import type {PolicyContext, PolicyDecision} from "../src/policy/context.js";
import {ALLOW, deny} from "../src/policy/context.js";
import {orderRules, PolicyEngine, type Policy} from "../src/policy/engine.js";
import {PolicySource, UnknownPolicyError, type PolicyRepository} from "../src/policy/policySource.js";
import type {PolicyRule} from "../src/policy/rule.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {QuotaRule} from "../src/policy/rules/quotaRules.js";
import {
  ChainEnabledRule,
  MethodAllowlistRule,
  NoValueTransferRule,
  SenderAllowlistRule,
  SenderBlocklistRule,
  TargetAllowlistRule,
} from "../src/policy/rules/accessLists.js";

const SENDER = "0x1234567890123456789012345678901234567890" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const OTHER = "0x9999999999999999999999999999999999999999" as Address;

const ACCOUNT_ABI = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
]);

const APPROVE_SELECTOR = "0x095ea7b3" as Hex;

function executeCall(target: Address, value = 0n, data: Hex = "0x"): Hex {
  return encodeFunctionData({abi: ACCOUNT_ABI, functionName: "execute", args: [target, value, data]});
}

function approveData(): Hex {
  return encodeFunctionData({abi: ERC20_ABI, functionName: "approve", args: [OTHER, 1000n]});
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  const callData = overrides.userOp?.callData ?? executeCall(USDC, 0n, approveData());
  const userOp: PackedUserOperation = {
    sender: SENDER,
    nonce: 0n,
    initCode: "0x",
    callData,
    accountGasLimits: toHex(packUint128Pair(500_000n, 200_000n), {size: 32}),
    preVerificationGas: 100_000n,
    gasFees: toHex(packUint128Pair(1_000_000_000n, 20_000_000_000n), {size: 32}),
    paymasterAndData: "0x",
    signature: "0x",
    ...overrides.userOp,
  };
  return {
    chainId: 8453,
    sender: SENDER,
    userOp,
    calls: decodeCallTargets(userOp.callData),
    clientIp: "203.0.113.7",
    apiKeyId: "key-1",
    maxCost: 10n ** 15n,
    now: 1_700_000_000,
    ...overrides,
  };
}

function policy(...rules: PolicyRule[]): Policy {
  return {id: "test", rules};
}

describe("decodeCallTargets", () => {
  it("decodes a single execute", () => {
    const calls = decodeCallTargets(executeCall(USDC, 0n, approveData()));
    expect(calls).toHaveLength(1);
    expect(calls![0]!.target.toLowerCase()).toBe(USDC.toLowerCase());
    expect(calls![0]!.selector).toBe(APPROVE_SELECTOR);
  });

  it("decodes a batch", () => {
    const data = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "executeBatch",
      args: [
        [USDC, OTHER],
        [0n, 5n],
        [approveData(), "0x"],
      ],
    });
    const calls = decodeCallTargets(data);
    expect(calls).toHaveLength(2);
    expect(calls![1]!.value).toBe(5n);
    expect(calls![1]!.selector).toBeUndefined();
  });

  it("reports a bare value transfer as having no selector", () => {
    const calls = decodeCallTargets(executeCall(OTHER, 1n, "0x"));
    expect(calls![0]!.selector).toBeUndefined();
  });

  /**
   * The distinction that keeps an unrecognised account from bypassing target rules: unknown
   * calldata must decode to undefined, never to an empty list.
   */
  it("returns undefined for calldata it does not understand", () => {
    expect(decodeCallTargets("0x")).toBeUndefined();
    expect(decodeCallTargets("0xdeadbeef")).toBeUndefined();
    expect(decodeCallTargets("0xdeadbeef0000000000000000000000000000000000000000")).toBeUndefined();
  });
});

describe("access list rules", () => {
  it("allowlist admits listed senders and refuses others", () => {
    const rule = new SenderAllowlistRule([SENDER]);
    expect(rule.evaluate(context()).allowed).toBe(true);
    expect(rule.evaluate(context({sender: OTHER}))).toMatchObject({allowed: false, code: "SENDER_NOT_ALLOWED"});
  });

  it("matches addresses regardless of checksum casing", () => {
    const rule = new SenderAllowlistRule([SENDER.toUpperCase().replace("0X", "0x") as Address]);
    expect(rule.evaluate(context()).allowed).toBe(true);
  });

  it("rejects malformed addresses at construction, not at evaluation", () => {
    expect(() => new SenderAllowlistRule(["0xnot-an-address" as Address])).toThrow();
  });

  it("blocklist refuses listed senders", () => {
    const rule = new SenderBlocklistRule([SENDER]);
    expect(rule.evaluate(context())).toMatchObject({allowed: false, code: "SENDER_BLOCKED"});
    expect(rule.evaluate(context({sender: OTHER})).allowed).toBe(true);
  });

  it("target allowlist admits allowed targets and refuses others", () => {
    const rule = new TargetAllowlistRule([USDC]);
    expect(rule.evaluate(context()).allowed).toBe(true);
    expect(rule.evaluate(context({userOp: {callData: executeCall(OTHER)} as never}))).toMatchObject({
      allowed: false,
      code: "TARGET_NOT_ALLOWED",
    });
  });

  it("target allowlist denies every call in a batch, not just the first", () => {
    const data = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "executeBatch",
      args: [
        [USDC, OTHER],
        [0n, 0n],
        [approveData(), approveData()],
      ],
    });
    const ctx = context({userOp: {callData: data} as never});
    expect(new TargetAllowlistRule([USDC]).evaluate(ctx)).toMatchObject({code: "TARGET_NOT_ALLOWED"});
  });

  /** An account we cannot decode must not thereby escape the allowlist. */
  it("target allowlist fails closed on undecodable calldata", () => {
    const ctx = context({calls: undefined});
    expect(new TargetAllowlistRule([USDC]).evaluate(ctx)).toMatchObject({
      allowed: false,
      code: "CALLDATA_UNDECODABLE",
    });
  });

  it("method allowlist admits allowed selectors", () => {
    const rule = new MethodAllowlistRule([APPROVE_SELECTOR]);
    expect(rule.evaluate(context()).allowed).toBe(true);
  });

  it("method allowlist refuses other selectors", () => {
    const transfer = encodeFunctionData({abi: ERC20_ABI, functionName: "transfer", args: [OTHER, 1n]});
    const ctx = context({userOp: {callData: executeCall(USDC, 0n, transfer)} as never});
    expect(new MethodAllowlistRule([APPROVE_SELECTOR]).evaluate(ctx)).toMatchObject({
      allowed: false,
      code: "METHOD_NOT_ALLOWED",
    });
  });

  it("method allowlist refuses bare value transfers by default", () => {
    const ctx = context({userOp: {callData: executeCall(USDC, 1n, "0x")} as never});
    expect(new MethodAllowlistRule([APPROVE_SELECTOR]).evaluate(ctx)).toMatchObject({
      code: "METHOD_NOT_ALLOWED",
    });
    expect(new MethodAllowlistRule([APPROVE_SELECTOR], {allowBareValueTransfer: true}).evaluate(ctx).allowed).toBe(
      true,
    );
  });

  it("chain rule admits enabled chains only", () => {
    expect(new ChainEnabledRule([8453]).evaluate(context()).allowed).toBe(true);
    expect(new ChainEnabledRule([1]).evaluate(context())).toMatchObject({allowed: false, code: "CHAIN_DISABLED"});
  });

  it("value rule refuses calls that move ETH", () => {
    const ctx = context({userOp: {callData: executeCall(USDC, 1n, approveData())} as never});
    expect(new NoValueTransferRule().evaluate(ctx)).toMatchObject({allowed: false, code: "VALUE_NOT_ALLOWED"});
    expect(new NoValueTransferRule().evaluate(context()).allowed).toBe(true);
  });
});

describe("QuotaRule", () => {
  const options = {name: "wallet-daily", subject: "wallet", unit: "operations", limit: 2n, windowSeconds: 86_400} as const;

  it("admits up to the limit then refuses", async () => {
    const rule = new QuotaRule(new InMemoryQuotaStore(), options);
    expect((await rule.evaluate(context())).allowed).toBe(true);
    expect((await rule.evaluate(context())).allowed).toBe(true);
    expect(await rule.evaluate(context())).toMatchObject({allowed: false, code: "QUOTA_EXCEEDED"});
  });

  it("counts each wallet separately", async () => {
    const rule = new QuotaRule(new InMemoryQuotaStore(), options);
    await rule.evaluate(context());
    await rule.evaluate(context());
    expect((await rule.evaluate(context({sender: OTHER}))).allowed).toBe(true);
  });

  it("resets when the window rolls over", async () => {
    const rule = new QuotaRule(new InMemoryQuotaStore(), options);
    await rule.evaluate(context());
    await rule.evaluate(context());
    expect((await rule.evaluate(context())).allowed).toBe(false);
    expect((await rule.evaluate(context({now: 1_700_000_000 + 86_400}))).allowed).toBe(true);
  });

  it("charges wei against a spend cap", async () => {
    const rule = new QuotaRule(new InMemoryQuotaStore(), {
      name: "wallet-spend",
      subject: "wallet",
      unit: "wei",
      limit: 25n * 10n ** 14n, // 2.5x maxCost
      windowSeconds: 86_400,
    });
    expect((await rule.evaluate(context())).allowed).toBe(true);
    expect((await rule.evaluate(context())).allowed).toBe(true);
    expect(await rule.evaluate(context())).toMatchObject({allowed: false, code: "SPEND_CAP_EXCEEDED"});
  });

  it("refuses when the subject is absent, rather than silently not applying", async () => {
    const rule = new QuotaRule(new InMemoryQuotaStore(), {...options, subject: "ip"});
    expect(await rule.evaluate(context({clientIp: undefined}))).toMatchObject({allowed: false});
  });

  it("can be configured to skip when the subject is absent", async () => {
    const rule = new QuotaRule(new InMemoryQuotaStore(), {...options, subject: "ip", onMissingSubject: "skip"});
    expect((await rule.evaluate(context({clientIp: undefined}))).allowed).toBe(true);
  });

  it("does not apply a per-target quota to multi-call batches", async () => {
    const data = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "executeBatch",
      args: [
        [USDC, OTHER],
        [0n, 0n],
        [approveData(), approveData()],
      ],
    });
    const rule = new QuotaRule(new InMemoryQuotaStore(), {...options, subject: "target", onMissingSubject: "skip"});
    expect((await rule.evaluate(context({userOp: {callData: data} as never}))).allowed).toBe(true);
  });

  it("rejects nonsensical configuration at construction", () => {
    expect(() => new QuotaRule(new InMemoryQuotaStore(), {...options, limit: -1n})).toThrow(RangeError);
    expect(() => new QuotaRule(new InMemoryQuotaStore(), {...options, windowSeconds: 0})).toThrow(RangeError);
  });

  /**
   * The race the QuotaStore port exists to prevent: concurrent requests must not both be granted
   * the last unit of budget.
   */
  it("does not over-grant under concurrent evaluation", async () => {
    const rule = new QuotaRule(new InMemoryQuotaStore(), {...options, limit: 5n});
    const results = await Promise.all(Array.from({length: 50}, () => rule.evaluate(context())));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("reports remaining budget", async () => {
    const rule = new QuotaRule(new InMemoryQuotaStore(), options);
    expect(await rule.remaining(context())).toBe(2n);
    await rule.evaluate(context());
    expect(await rule.remaining(context())).toBe(1n);
  });
});

describe("InMemoryQuotaStore", () => {
  it("evicts only windows that have ended", async () => {
    const store = new InMemoryQuotaStore();
    await store.tryConsume({key: "k", amount: 1n, limit: 10n, windowSeconds: 60, now: 1_000});
    expect(store.size).toBe(1);

    store.evictExpired(1_000);
    expect(store.size, "current window must survive eviction").toBe(1);

    store.evictExpired(1_100);
    expect(store.size, "ended window must be evicted").toBe(0);
  });

  it("release does not push a counter negative", async () => {
    const store = new InMemoryQuotaStore();
    await store.tryConsume({key: "k", amount: 1n, limit: 10n, windowSeconds: 60, now: 1_000});
    await store.release({key: "k", amount: 5n, windowSeconds: 60, now: 1_000});
    expect(await store.usage("k", 60, 1_000)).toBe(0n);
  });
});

describe("PolicyEngine", () => {
  const engine = new PolicyEngine();

  it("approves when every rule approves", async () => {
    const result = await engine.evaluate(policy(new ChainEnabledRule([8453]), new SenderAllowlistRule([SENDER])), context());
    expect(result.decision.allowed).toBe(true);
  });

  it("denies on the first failing rule and reports which", async () => {
    const result = await engine.evaluate(policy(new SenderBlocklistRule([SENDER])), context());
    expect(result.decision).toMatchObject({allowed: false, rule: "sender-blocklist", code: "SENDER_BLOCKED"});
  });

  it("short-circuits: rules after a denial do not run", async () => {
    let ran = false;
    const spy: PolicyRule = {
      name: "spy",
      cost: "pure",
      evaluate: () => {
        ran = true;
        return ALLOW;
      },
    };
    await engine.evaluate(policy(new ChainEnabledRule([1]), spy), context());
    expect(ran).toBe(false);
  });

  /** A rule that throws must deny. Never approve on error: that turns an outage into free gas. */
  it("fails closed when a rule throws", async () => {
    const exploding: PolicyRule = {
      name: "exploding",
      cost: "pure",
      evaluate: () => {
        throw new Error("quota store unreachable");
      },
    };
    const result = await engine.evaluate(policy(exploding), context());
    expect(result.decision).toMatchObject({allowed: false, code: "RULE_ERROR"});
    expect((result.decision as {reason: string}).reason).toContain("quota store unreachable");
  });

  it("fails closed when a rule rejects asynchronously", async () => {
    const exploding: PolicyRule = {
      name: "async-exploding",
      cost: "store",
      evaluate: async () => {
        throw new Error("timeout");
      },
    };
    expect((await engine.evaluate(policy(exploding), context())).decision.allowed).toBe(false);
  });

  it("orders cheap rules before expensive ones", () => {
    const store: PolicyRule = {name: "s", cost: "store", evaluate: () => ALLOW};
    const pure: PolicyRule = {name: "p", cost: "pure", evaluate: () => ALLOW};
    const network: PolicyRule = {name: "n", cost: "network", evaluate: () => ALLOW};
    expect(orderRules([network, store, pure]).map((r) => r.name)).toEqual(["p", "s", "n"]);
  });

  it("keeps declaration order within a cost tier", () => {
    const a: PolicyRule = {name: "a", cost: "pure", evaluate: () => ALLOW};
    const b: PolicyRule = {name: "b", cost: "pure", evaluate: () => ALLOW};
    expect(orderRules([a, b]).map((r) => r.name)).toEqual(["a", "b"]);
  });

  /** Cost ordering means a denial from a free rule never touches the quota store. */
  it("does not consume quota when a pure rule denies", async () => {
    const store = new InMemoryQuotaStore();
    const quota = new QuotaRule(store, {
      name: "wallet-daily",
      subject: "wallet",
      unit: "operations",
      limit: 10n,
      windowSeconds: 86_400,
    });
    await engine.evaluate(policy(quota, new SenderBlocklistRule([SENDER])), context());
    expect(await quota.remaining(context())).toBe(10n);
  });

  /**
   * The compensation path: a request refused by the second quota must not leave the first quota
   * charged.
   */
  it("releases reservations made before a later rule denies", async () => {
    const store = new InMemoryQuotaStore();
    const walletQuota = new QuotaRule(store, {
      name: "wallet-daily",
      subject: "wallet",
      unit: "operations",
      limit: 10n,
      windowSeconds: 86_400,
    });
    const ipQuota = new QuotaRule(store, {
      name: "ip-daily",
      subject: "ip",
      unit: "operations",
      limit: 0n, // always denies
      windowSeconds: 86_400,
    });

    const result = await engine.evaluate(policy(walletQuota, ipQuota), context());

    expect(result.decision.allowed).toBe(false);
    expect(await walletQuota.remaining(context()), "wallet quota must be refunded").toBe(10n);
  });

  it("releases reservations for an approval the caller could not act on", async () => {
    const store = new InMemoryQuotaStore();
    const quota = new QuotaRule(store, {
      name: "wallet-daily",
      subject: "wallet",
      unit: "operations",
      limit: 10n,
      windowSeconds: 86_400,
    });
    const p = policy(quota);

    expect((await engine.evaluate(p, context())).decision.allowed).toBe(true);
    expect(await quota.remaining(context())).toBe(9n);

    await engine.releaseReservations(p, context());
    expect(await quota.remaining(context())).toBe(10n);
  });

  it("reports evaluation to the observer", async () => {
    const seen: string[] = [];
    const observed = new PolicyEngine({
      observer: {onDecision: (evaluation) => seen.push(evaluation.decision.allowed ? "allow" : "deny")},
    });
    await observed.evaluate(policy(new SenderBlocklistRule([SENDER])), context());
    expect(seen).toEqual(["deny"]);
  });

  it("composes a realistic USDC-approval-sponsorship policy", async () => {
    const p = policy(
      new ChainEnabledRule([8453]),
      new SenderBlocklistRule([OTHER]),
      new TargetAllowlistRule([USDC]),
      new MethodAllowlistRule([APPROVE_SELECTOR]),
      new NoValueTransferRule(),
      new QuotaRule(new InMemoryQuotaStore(), {
        name: "wallet-daily",
        subject: "wallet",
        unit: "operations",
        limit: 5n,
        windowSeconds: 86_400,
      }),
    );

    expect((await engine.evaluate(p, context())).decision.allowed).toBe(true);

    // Same policy, a transfer instead of an approve.
    const transfer = encodeFunctionData({abi: ERC20_ABI, functionName: "transfer", args: [OTHER, 1n]});
    const denied = await engine.evaluate(p, context({userOp: {callData: executeCall(USDC, 0n, transfer)} as never}));
    expect(denied.decision).toMatchObject({code: "METHOD_NOT_ALLOWED"});
  });
});

describe("PolicySource", () => {
  class FakeRepository implements PolicyRepository {
    constructor(public policies: readonly Policy[]) {}
    async load(): Promise<readonly Policy[]> {
      return this.policies;
    }
  }

  it("serves policies after a reload", async () => {
    const source = new PolicySource(new FakeRepository([{id: "a", rules: []}]));
    await source.reload();
    expect(source.get("a").id).toBe("a");
    expect(source.has("b")).toBe(false);
  });

  it("throws for an unknown policy rather than defaulting to permissive", () => {
    const source = new PolicySource(new FakeRepository([]));
    expect(() => source.get("nope")).toThrow(UnknownPolicyError);
  });

  it("swaps the whole set on reload", async () => {
    const repo = new FakeRepository([{id: "a", rules: []}]);
    const source = new PolicySource(repo);
    await source.reload();

    repo.policies = [{id: "b", rules: []}];
    await source.reload();

    expect(source.has("a")).toBe(false);
    expect(source.has("b")).toBe(true);
    expect(source.generation).toBe(2);
  });

  /** An in-flight evaluation must not observe a set that changed underneath it. */
  it("leaves a snapshot taken before a reload unchanged", async () => {
    const repo = new FakeRepository([{id: "a", rules: []}]);
    const source = new PolicySource(repo);
    await source.reload();

    const snapshot = source.snapshot();
    repo.policies = [{id: "b", rules: []}];
    await source.reload();

    expect(snapshot.has("a"), "snapshot must be immutable across reloads").toBe(true);
    expect(snapshot.has("b")).toBe(false);
  });

  it("rejects a set with duplicate ids rather than picking a winner", async () => {
    const source = new PolicySource(
      new FakeRepository([
        {id: "dup", rules: []},
        {id: "dup", rules: []},
      ]),
    );
    await expect(source.reload()).rejects.toThrow(/duplicate policy id/);
  });

  /** A policy database blip must not silently empty the policy set. */
  it("keeps the previous set when a reload fails", async () => {
    let fail = false;
    const source = new PolicySource({
      load: async () => {
        if (fail) throw new Error("database unreachable");
        return [{id: "a", rules: []}];
      },
    });

    await source.reload();
    fail = true;
    await expect(source.reload()).rejects.toThrow("database unreachable");

    expect(source.has("a"), "previous policy set must survive a failed reload").toBe(true);
    expect(source.generation).toBe(1);
  });
});
