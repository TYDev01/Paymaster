import type {Plan, PlanCatalogue} from "../billing/plans.js";
import type {TenantId} from "../db/scope.js";
import type {Policy} from "./engine.js";
import type {PolicyRepository} from "./policySource.js";
import {RESERVED_QUOTA_PREFIX} from "./policyFactory.js";
import type {QuotaStore} from "./quota/quotaStore.js";
import type {PolicyRule} from "./rule.js";
import {ChainEnabledRule} from "./rules/accessLists.js";
import {QuotaRule} from "./rules/quotaRules.js";

/** Which plan each tenant is on. `SubscriptionRepository.planIdsByTenant` satisfies it. */
export interface TenantPlanLookup {
  planIdsByTenant(): Promise<ReadonlyMap<string, string>>;
}

const DAY_SECONDS = 86_400;

/**
 * Tenants edit their own policies; the plan decides how far those policies can reach.
 *
 * NESTED LIMITS, NOT A FLAT SET. A tenant's policy is whatever they wrote — they may tighten anything
 * — and every one of their policies gets the plan's ceilings APPENDED when the set loads. The policy
 * engine ANDs rules together, so a tenant quota of 1,000,000 operations under a plan ceiling of
 * 10,000 allows 10,000: the lower of the two always binds, and there is no field a tenant can edit to
 * raise it. Nothing needs to validate tenant limits against the plan at write time, because a
 * higher limit is not an error — it is simply not the one that binds.
 *
 * Ceilings are per tenant and per day across ALL of that tenant's policies and keys (a `global`
 * counter in the tenant's own namespace), so splitting traffic across ten keys or ten policies buys
 * nothing. Their names carry the reserved `platform:` prefix, which tenant rules cannot use.
 *
 * Applied on every reload, so a plan change or a new PLANS configuration takes effect within one
 * reload interval without anyone rewriting a policy.
 */
export class PlanCeilingPolicyRepository implements PolicyRepository {
  readonly #inner: PolicyRepository;
  readonly #plans: PlanCatalogue;
  readonly #lookup: TenantPlanLookup;
  readonly #quotas: QuotaStore;

  constructor(inner: PolicyRepository, plans: PlanCatalogue, lookup: TenantPlanLookup, quotas: QuotaStore) {
    this.#inner = inner;
    this.#plans = plans;
    this.#lookup = lookup;
    this.#quotas = quotas;
  }

  async load(scope: Parameters<PolicyRepository["load"]>[0]): Promise<readonly Policy[]> {
    const policies = await this.#inner.load(scope);
    if (this.#plans.size === 0) return policies;

    const planIds = await this.#lookup.planIdsByTenant();
    return policies.map((policy) => {
      const plan = this.planFor(policy.tenantId, planIds);
      return plan === undefined
        ? policy
        : {...policy, rules: [...policy.rules, ...ceilingRules(plan, policy.tenantId, this.#quotas)]};
    });
  }

  /**
   * The plan whose ceilings apply. A tenant naming a plan that no longer exists in PLANS falls back
   * to the default plan rather than to no ceiling at all — removing a plan from configuration must not
   * quietly lift the limits on everyone who was on it.
   */
  planFor(tenant: TenantId, planIds: ReadonlyMap<string, string>): Plan | undefined {
    return this.#plans.find(planIds.get(tenant)) ?? this.#plans.find(this.#plans.defaultPlanId);
  }
}

export function ceilingRules(plan: Plan, tenant: TenantId, quotas: QuotaStore): readonly PolicyRule[] {
  const rules: PolicyRule[] = [];

  if (plan.chainIds !== undefined) rules.push(new ChainEnabledRule(plan.chainIds));

  if (plan.limits.operationsPerDay !== undefined) {
    rules.push(
      new QuotaRule(quotas, {
        name: `${RESERVED_QUOTA_PREFIX}operations-per-day`,
        subject: "global",
        unit: "operations",
        limit: plan.limits.operationsPerDay,
        windowSeconds: DAY_SECONDS,
        namespace: tenant,
      }),
    );
  }

  if (plan.limits.weiPerDay !== undefined) {
    rules.push(
      new QuotaRule(quotas, {
        name: `${RESERVED_QUOTA_PREFIX}wei-per-day`,
        subject: "global",
        unit: "wei",
        limit: plan.limits.weiPerDay,
        windowSeconds: DAY_SECONDS,
        namespace: tenant,
      }),
    );
  }

  return rules;
}
