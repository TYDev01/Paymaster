import {describe, expect, it} from "vitest";

import {defaultPolicies, defaultPolicyDefinition} from "../src/config/defaultPolicies.js";
import {PolicyFactory} from "../src/policy/policyFactory.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import type {TokenBalanceReader} from "../src/policy/rules/tokenOwnership.js";
import {testEnv} from "./support/env.js";

/**
 * The bootstrap policy exists twice: as rule objects (served when there is no database) and as a
 * storable definition (seeded into an empty policy table when there is one). These tests exist to
 * stop the two drifting.
 *
 * Drift would be quiet and expensive: the with-database and without-database deployments would
 * sponsor different things while both claiming to serve "the default policy", and the difference
 * would only show up as an integrator hitting a limit on one environment and not the other.
 */
const CHAINS = JSON.stringify([
  {
    chainId: 8453,
    name: "Base",
    rpcUrls: ["https://base.example.com"],
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    paymaster: "0x1234567890123456789012345678901234567890",
    explorerUrl: "https://basescan.org",
    nativeCurrency: {symbol: "ETH", decimals: 18},
    minDepositWei: "1",
    minStakeWei: "1",
    enabled: true,
  },
  {
    chainId: 999,
    name: "Disabled",
    rpcUrls: ["https://disabled.example.com"],
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    paymaster: "0x1234567890123456789012345678901234567890",
    explorerUrl: "https://example.invalid",
    nativeCurrency: {symbol: "ETH", decimals: 18},
    minDepositWei: "1",
    minStakeWei: "1",
    enabled: false,
  },
]);

const tokenReader: TokenBalanceReader = {balanceOf: async () => 0n};

function factory(): PolicyFactory {
  return new PolicyFactory(new InMemoryQuotaStore(), tokenReader);
}

describe("the bootstrap policy definition", () => {
  const env = testEnv({CHAINS});

  it("builds: every rule passes the factory's own schema validation", () => {
    const definition = defaultPolicyDefinition(env);

    // Seeding calls `upsert`, which builds every rule before writing. A definition that cannot
    // build would fail at startup, in the composition root, after migrations have already run.
    expect(() => definition.rules.map((rule) => factory().build(definition.id, rule))).not.toThrow();
  });

  it("produces the same rules as the in-code set, in the same order", () => {
    const built = defaultPolicyDefinition(env).rules.map((rule) => factory().build("default", rule));
    const inCode = defaultPolicies(env, new InMemoryQuotaStore())[0]!.rules;

    expect(built.map((r) => r.name)).toEqual(inCode.map((r) => r.name));
    expect(built.map((r) => r.cost)).toEqual(inCode.map((r) => r.cost));
  });

  it("uses the configured policy id, so DEFAULT_POLICY_ID cannot point at a policy that was never seeded", () => {
    const renamed = testEnv({CHAINS, DEFAULT_POLICY_ID: "house"});

    expect(defaultPolicyDefinition(renamed).id).toBe("house");
    expect(defaultPolicies(renamed)[0]!.id).toBe("house");
  });

  it("enables exactly the chains that are enabled in config", () => {
    const chainRule = defaultPolicyDefinition(env).rules.find((r) => r.ruleType === "chain-enabled");

    // The disabled chain must not appear: a bootstrap policy that sponsors a chain the operator
    // turned off would quietly re-enable it.
    expect(chainRule?.config).toEqual({chainIds: [8453]});
  });

  it("is bounded — an unbounded 'sponsor everyone' policy is a faucet", () => {
    const quotas = defaultPolicyDefinition(env).rules.filter((r) => r.ruleType === "quota");

    expect(quotas.length).toBeGreaterThan(0);
    // Both a spend cap and an operation cap, and at least one that is not per-wallet: per-wallet
    // limits alone bound each caller but not the total, which is what the deposit actually cares about.
    const subjects = quotas.map((r) => (r.config as {subject: string}).subject);
    const units = quotas.map((r) => (r.config as {unit: string}).unit);
    expect(units).toContain("wei");
    expect(units).toContain("operations");
    expect(subjects).toContain("global");
  });
});
