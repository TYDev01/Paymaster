import {describe, expect, it} from "vitest";
import {toHex, type Address} from "viem";

import {packUint128Pair, type PackedUserOperation} from "../src/domain/userOperation.js";
import type {PolicyContext} from "../src/policy/context.js";
import {InvalidRuleConfigError, PolicyFactory, RULE_TYPES, isRuleType} from "../src/policy/policyFactory.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";

const SENDER = "0x1234567890123456789012345678901234567890" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

function factory(): PolicyFactory {
  return new PolicyFactory(new InMemoryQuotaStore());
}

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
    maxCost: 10n ** 15n,
    now: 1_700_000_000,
    ...over,
  };
}

describe("PolicyFactory", () => {
  it("builds every declared rule type", () => {
    const configs: Record<string, unknown> = {
      "chain-enabled": {chainIds: [8453]},
      "sender-allowlist": {addresses: [SENDER]},
      "sender-blocklist": {addresses: [SENDER]},
      "target-allowlist": {addresses: [USDC]},
      "method-allowlist": {selectors: ["0x095ea7b3"]},
      "no-value-transfer": {},
      quota: {name: "q", subject: "wallet", unit: "operations", limit: "10", windowSeconds: 86_400},
    };

    // Every type in RULE_TYPES must be constructible: a schema without a constructor would be a
    // rule an operator can configure and that then fails at load.
    for (const ruleType of RULE_TYPES) {
      const rule = factory().build("p", {ruleType, config: configs[ruleType]});
      expect(rule.name, `${ruleType} must build`).toBeTruthy();
    }
  });

  /**
   * The property this whole class exists for. Skipping a rule it does not understand would mean an
   * unrecognised sender-blocklist yields a policy that sponsors blocked senders.
   */
  it("throws on an unknown rule type rather than skipping it", () => {
    expect(() => factory().build("p", {ruleType: "sender-blocklist-v2", config: {}})).toThrow(InvalidRuleConfigError);
    expect(() => factory().build("p", {ruleType: "sender-blocklist-v2", config: {}})).toThrow(/unknown rule type/);
  });

  it("throws on config that does not match the rule type", () => {
    expect(() => factory().build("p", {ruleType: "sender-blocklist", config: {addresses: ["nope"]}})).toThrow(
      InvalidRuleConfigError,
    );
    expect(() => factory().build("p", {ruleType: "chain-enabled", config: {chainIds: []}})).toThrow(
      InvalidRuleConfigError,
    );
    expect(() => factory().build("p", {ruleType: "chain-enabled", config: {}})).toThrow(InvalidRuleConfigError);
  });

  it("names the policy and rule in the error, so an operator can find it", () => {
    expect(() => factory().build("acme-prod", {ruleType: "chain-enabled", config: {}})).toThrow(/acme-prod/);
    expect(() => factory().build("acme-prod", {ruleType: "chain-enabled", config: {}})).toThrow(/chain-enabled/);
  });

  /**
   * A mistyped address in an allowlist means allowlisting the wrong contract. Note that getAddress
   * alone would NOT catch this — it recomputes the checksum and returns the corrected form. Only
   * strict isAddress rejects it.
   */
  it("rejects a mistyped address via its checksum, at load rather than at evaluation", () => {
    const badChecksum = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eB48"; // mixed case, wrong checksum
    expect(() => factory().build("p", {ruleType: "target-allowlist", config: {addresses: [badChecksum]}})).toThrow(
      InvalidRuleConfigError,
    );
    expect(() => factory().build("p", {ruleType: "target-allowlist", config: {addresses: [badChecksum]}})).toThrow(
      /checksum/i,
    );
  });

  it("accepts a correctly checksummed address", () => {
    expect(() => factory().build("p", {ruleType: "target-allowlist", config: {addresses: [USDC]}})).not.toThrow();
  });

  it("accepts a lowercase address", () => {
    expect(() =>
      factory().build("p", {ruleType: "target-allowlist", config: {addresses: [USDC.toLowerCase()]}}),
    ).not.toThrow();
  });

  /**
   * A wei limit exceeds Number.MAX_SAFE_INTEGER routinely; a JSON number would be silently rounded
   * into a cap subtly different from the configured one.
   */
  it("takes amounts as strings, not JSON numbers", () => {
    expect(() =>
      factory().build("p", {
        ruleType: "quota",
        config: {name: "q", subject: "wallet", unit: "wei", limit: 1e18, windowSeconds: 86_400},
      }),
    ).toThrow(InvalidRuleConfigError);

    expect(() =>
      factory().build("p", {
        ruleType: "quota",
        config: {name: "q", subject: "wallet", unit: "wei", limit: "1000000000000000000", windowSeconds: 86_400},
      }),
    ).not.toThrow();
  });

  it("preserves a wei limit beyond 2^53 exactly", async () => {
    const store = new InMemoryQuotaStore();
    const rule = new PolicyFactory(store).build("p", {
      ruleType: "quota",
      config: {
        name: "big",
        subject: "global",
        unit: "wei",
        limit: "10000000000000000000", // 10 ETH — beyond both 2^53 and int64
        windowSeconds: 86_400,
      },
    });

    // 10 ops at 1 ETH each fit; the 11th does not.
    const oneEth = context({maxCost: 10n ** 18n});
    for (let i = 0; i < 10; i++) expect((await rule.evaluate(oneEth)).allowed).toBe(true);
    expect((await rule.evaluate(oneEth)).allowed).toBe(false);
  });

  it("rejects an unknown quota subject or unit", () => {
    expect(() =>
      factory().build("p", {
        ruleType: "quota",
        config: {name: "q", subject: "galaxy", unit: "operations", limit: "1", windowSeconds: 60},
      }),
    ).toThrow(InvalidRuleConfigError);

    expect(() =>
      factory().build("p", {
        ruleType: "quota",
        config: {name: "q", subject: "wallet", unit: "dollars", limit: "1", windowSeconds: 60},
      }),
    ).toThrow(InvalidRuleConfigError);
  });

  it("rejects an implausible window", () => {
    expect(() =>
      factory().build("p", {
        ruleType: "quota",
        config: {name: "q", subject: "wallet", unit: "operations", limit: "1", windowSeconds: 0},
      }),
    ).toThrow(InvalidRuleConfigError);
  });

  it("builds a rule that actually enforces what its config says", async () => {
    const rule = factory().build("p", {ruleType: "sender-blocklist", config: {addresses: [SENDER]}});
    expect(await rule.evaluate(context())).toMatchObject({allowed: false, code: "SENDER_BLOCKED"});
    expect((await rule.evaluate(context({sender: USDC}))).allowed).toBe(true);
  });

  it("treats missing config as empty", () => {
    expect(() => factory().build("p", {ruleType: "no-value-transfer", config: undefined})).not.toThrow();
  });

  it("isRuleType recognises exactly the declared types", () => {
    for (const t of RULE_TYPES) expect(isRuleType(t)).toBe(true);
    expect(isRuleType("nonsense")).toBe(false);
  });
});
