import {describe, expect, it} from "vitest";
import {parseEther, type Address} from "viem";

import {parsePlansJson} from "../src/billing/plans.js";
import {tenantId} from "../src/db/scope.js";
import {PolicyEngine, type Policy} from "../src/policy/engine.js";
import type {PolicyContext} from "../src/policy/context.js";
import {PlanCeilingPolicyRepository} from "../src/policy/planCeilings.js";
import {InvalidRuleConfigError, PolicyFactory} from "../src/policy/policyFactory.js";
import {PLATFORM_SCOPE} from "../src/db/scope.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {ACME} from "./support/tenants.js";

const T_ONE = tenantId("t_one");
const T_TWO = tenantId("t_two");

const PLANS = parsePlansJson(
  JSON.stringify([
    {
      id: "starter",
      name: "Starter",
      periodSeconds: 2_592_000,
      priceWei: {"1": "1"},
      limits: {operationsPerDay: "2"},
      chainIds: [8453],
    },
    {id: "growth", name: "Growth", periodSeconds: 2_592_000, priceWei: {"1": "2"}, limits: {operationsPerDay: "100"}},
  ]),
  "starter",
);

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    chainId: 8453,
    sender: "0x1234567890123456789012345678901234567890" as Address,
    userOp: {} as PolicyContext["userOp"],
    calls: [],
    clientIp: "203.0.113.7",
    apiKeyId: "key-1",
    maxCost: parseEther("0.001"),
    now: 1_800_000_000,
    ...overrides,
  };
}

describe("plan ceilings", () => {
  it("lets the plan ceiling bind even when the tenant's own quota is far higher", async () => {
    const quotas = new InMemoryQuotaStore();
    const factory = new PolicyFactory(quotas);
    const generous: Policy = {
      tenantId: T_ONE,
      id: "default",
      rules: [
        factory.build(
          "default",
          {
            ruleType: "quota",
            config: {name: "lots", subject: "global", unit: "operations", limit: "1000000", windowSeconds: 86400},
          },
          T_ONE,
        ),
      ],
    };

    const repository = new PlanCeilingPolicyRepository(
      {load: async () => [generous]},
      PLANS,
      {planIdsByTenant: async () => new Map([[T_ONE, "starter"]])},
      quotas,
    );
    const [policy] = await repository.load(PLATFORM_SCOPE);
    const engine = new PolicyEngine();

    expect((await engine.evaluate(policy!, context())).decision.allowed).toBe(true);
    expect((await engine.evaluate(policy!, context())).decision.allowed).toBe(true);
    // Starter allows two a day. The tenant's million does not matter.
    const third = await engine.evaluate(policy!, context());
    expect(third.decision.allowed).toBe(false);
  });

  it("restricts sponsorship to the plan's chains", async () => {
    const repository = new PlanCeilingPolicyRepository(
      {load: async () => [{tenantId: T_ONE, id: "default", rules: []}]},
      PLANS,
      {planIdsByTenant: async () => new Map([[T_ONE, "starter"]])},
      new InMemoryQuotaStore(),
    );
    const [policy] = await repository.load(PLATFORM_SCOPE);
    expect((await new PolicyEngine().evaluate(policy!, context({chainId: 1}))).decision.allowed).toBe(false);
  });

  it("counts each tenant's ceiling separately", async () => {
    const quotas = new InMemoryQuotaStore();
    const repository = new PlanCeilingPolicyRepository(
      {
        load: async () => [
          {tenantId: T_ONE, id: "default", rules: []},
          {tenantId: T_TWO, id: "default", rules: []},
        ],
      },
      PLANS,
      {
        planIdsByTenant: async () =>
          new Map([
            [T_ONE, "starter"],
            [T_TWO, "starter"],
          ]),
      },
      quotas,
    );
    const [one, two] = await repository.load(PLATFORM_SCOPE);
    const engine = new PolicyEngine();

    await engine.evaluate(one!, context());
    await engine.evaluate(one!, context());
    expect((await engine.evaluate(one!, context())).decision.allowed).toBe(false);
    // Tenant one exhausting its day must not touch tenant two's.
    expect((await engine.evaluate(two!, context())).decision.allowed).toBe(true);
  });

  it("holds a tenant on a plan that no longer exists to the default plan, not to nothing", async () => {
    const repository = new PlanCeilingPolicyRepository(
      {load: async () => [{tenantId: T_ONE, id: "default", rules: []}]},
      PLANS,
      {planIdsByTenant: async () => new Map([[T_ONE, "retired-plan"]])},
      new InMemoryQuotaStore(),
    );
    const [policy] = await repository.load(PLATFORM_SCOPE);
    expect(policy!.rules.length).toBeGreaterThan(0);
  });

  it("applies the default plan to a tenant with no subscription", async () => {
    const repository = new PlanCeilingPolicyRepository(
      {load: async () => [{tenantId: T_ONE, id: "default", rules: []}]},
      PLANS,
      {planIdsByTenant: async () => new Map()},
      new InMemoryQuotaStore(),
    );
    const [policy] = await repository.load(PLATFORM_SCOPE);
    expect(policy!.rules.map((rule) => rule.name)).toContain("platform:operations-per-day");
  });

  it("leaves policies untouched when the deployment sells no plans", async () => {
    const original: Policy = {tenantId: T_ONE, id: "default", rules: []};
    const repository = new PlanCeilingPolicyRepository(
      {load: async () => [original]},
      parsePlansJson(undefined),
      {
        planIdsByTenant: async () => {
          throw new Error("must not be asked");
        },
      },
      new InMemoryQuotaStore(),
    );
    expect(await repository.load(PLATFORM_SCOPE)).toEqual([original]);
  });
});

describe("tenant-scoped quota counters", () => {
  const spec = {
    ruleType: "quota",
    config: {name: "daily", subject: "global", unit: "operations", limit: "1", windowSeconds: 86400},
  };

  it("keeps two tenants' same-named quotas on separate counters", async () => {
    // Before namespacing, these shared one counter: one customer's traffic spent the other's quota.
    const quotas = new InMemoryQuotaStore();
    const factory = new PolicyFactory(quotas);
    const engine = new PolicyEngine();
    const one: Policy = {tenantId: T_ONE, id: "default", rules: [factory.build("default", spec, T_ONE)]};
    const two: Policy = {tenantId: T_TWO, id: "default", rules: [factory.build("default", spec, T_TWO)]};

    expect((await engine.evaluate(one, context())).decision.allowed).toBe(true);
    expect((await engine.evaluate(two, context())).decision.allowed).toBe(true);
    expect((await engine.evaluate(one, context())).decision.allowed).toBe(false);
  });

  it("keeps the default tenant on the original key shape, so upgrading does not reset its quotas", async () => {
    const quotas = new InMemoryQuotaStore();
    const factory = new PolicyFactory(quotas);
    const engine = new PolicyEngine();
    const unscoped: Policy = {tenantId: ACME, id: "default", rules: [factory.build("default", spec)]};
    const defaultTenant: Policy = {tenantId: ACME, id: "default", rules: [factory.build("default", spec, ACME)]};

    expect((await engine.evaluate(unscoped, context())).decision.allowed).toBe(true);
    // Same counter: the one unit was already spent through the unscoped build.
    expect((await engine.evaluate(defaultTenant, context())).decision.allowed).toBe(false);
  });

  it("reserves the platform: prefix for plan ceilings", () => {
    const factory = new PolicyFactory(new InMemoryQuotaStore());
    expect(() =>
      factory.build(
        "default",
        {ruleType: "quota", config: {...spec.config, name: "platform:operations-per-day"}},
        T_ONE,
      ),
    ).toThrow(InvalidRuleConfigError);
  });
});
