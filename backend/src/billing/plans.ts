import {z} from "zod";

/**
 * What a subscription plan buys, as configuration.
 *
 * `tenant_subscriptions.plan` is free text on purpose (plans change more often than schemas should),
 * which left nothing that said what a plan MEANT. This is that: a price per chain for a period, the
 * ceilings a tenant on the plan cannot configure their way past, and which chains it may sponsor on.
 *
 * Loaded from the `PLANS` environment variable, exactly like `CHAINS`, so a new tier is a config
 * change and a redeploy rather than a migration.
 */
export interface Plan {
  readonly id: string;
  readonly name: string;
  /** Seconds of platform access one payment of `priceWei` buys. */
  readonly periodSeconds: number;
  /** Price for one period, in wei, per chain id the plan can be PAID on. */
  readonly priceWei: ReadonlyMap<number, bigint>;
  /**
   * Platform ceilings, enforced as rules appended to every policy the tenant owns. Absent means no
   * ceiling of that kind. Per rolling day, per tenant, across all of the tenant's policies and keys.
   */
  readonly limits: {
    readonly operationsPerDay: bigint | undefined;
    readonly weiPerDay: bigint | undefined;
  };
  /** Chains the plan may SPONSOR on. Absent means every configured chain. */
  readonly chainIds: readonly number[] | undefined;
}

export class UnknownPlanError extends Error {
  constructor(id: string) {
    super(`no plan with id ${id}`);
    this.name = "UnknownPlanError";
  }
}

export class PlanCatalogue {
  readonly #plans: ReadonlyMap<string, Plan>;
  /** The plan a tenant with no subscription row is held to, if the deployment names one. */
  readonly defaultPlanId: string | undefined;

  constructor(plans: readonly Plan[], defaultPlanId?: string) {
    const byId = new Map<string, Plan>();
    for (const plan of plans) {
      if (byId.has(plan.id)) throw new Error(`duplicate plan id in PLANS: ${plan.id}`);
      byId.set(plan.id, plan);
    }
    if (defaultPlanId !== undefined && !byId.has(defaultPlanId)) {
      throw new Error(`DEFAULT_PLAN_ID names ${defaultPlanId}, which is not in PLANS`);
    }
    this.#plans = byId;
    this.defaultPlanId = defaultPlanId;
  }

  static empty(): PlanCatalogue {
    return new PlanCatalogue([]);
  }

  get(id: string): Plan {
    const plan = this.#plans.get(id);
    if (plan === undefined) throw new UnknownPlanError(id);
    return plan;
  }

  find(id: string | undefined): Plan | undefined {
    return id === undefined ? undefined : this.#plans.get(id);
  }

  list(): readonly Plan[] {
    return [...this.#plans.values()];
  }

  get size(): number {
    return this.#plans.size;
  }
}

/** Amounts as decimal strings, never JSON numbers: a wei price routinely exceeds 2^53. */
const weiString = z
  .string()
  .regex(/^[0-9]+$/, "must be a non-negative integer string (wei)")
  .transform((value) => BigInt(value));

const planJsonSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "must be 1-64 chars of [a-z0-9._-]"),
    name: z.string().min(1).max(100),
    // A day to two years: shorter is a typo for a real product, longer pushes paid_through past any
    // date anyone would notice was wrong.
    periodSeconds: z.number().int().min(86_400).max(63_072_000),
    priceWei: z
      .record(z.string().regex(/^[0-9]+$/, "chain id keys must be numeric"), weiString)
      .refine(
        (prices) => Object.values(prices).every((price) => price > 0n),
        "a price of zero is a free grant, not a plan",
      ),
    limits: z
      .object({
        operationsPerDay: weiString.optional(),
        weiPerDay: weiString.optional(),
      })
      .default({}),
    chainIds: z.array(z.number().int().positive()).min(1).optional(),
  }),
);

export class InvalidPlansError extends Error {
  constructor(issues: readonly string[]) {
    super(`invalid PLANS:\n  ${issues.join("\n  ")}`);
    this.name = "InvalidPlansError";
  }
}

/** Parses the PLANS variable. Empty or unset means the deployment sells no plans. */
export function parsePlansJson(json: string | undefined, defaultPlanId?: string): PlanCatalogue {
  if (json === undefined || json.trim() === "") {
    if (defaultPlanId !== undefined) throw new InvalidPlansError(["DEFAULT_PLAN_ID is set but PLANS is empty"]);
    return PlanCatalogue.empty();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new InvalidPlansError([`not valid JSON: ${(cause as Error).message}`]);
  }

  const result = planJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidPlansError(result.error.issues.map((i) => `PLANS[${i.path.join(".")}]: ${i.message}`));
  }

  return new PlanCatalogue(
    result.data.map((raw) => ({
      id: raw.id,
      name: raw.name,
      periodSeconds: raw.periodSeconds,
      priceWei: new Map(Object.entries(raw.priceWei).map(([chainId, price]) => [Number(chainId), price])),
      limits: {operationsPerDay: raw.limits.operationsPerDay, weiPerDay: raw.limits.weiPerDay},
      chainIds: raw.chainIds,
    })),
    defaultPlanId,
  );
}

/** A plan as the API returns it: amounts as strings, maps as objects. */
export function planView(plan: Plan) {
  return {
    id: plan.id,
    name: plan.name,
    periodSeconds: plan.periodSeconds,
    priceWei: Object.fromEntries([...plan.priceWei].map(([chainId, price]) => [String(chainId), price.toString()])),
    limits: {
      operationsPerDay: plan.limits.operationsPerDay?.toString() ?? null,
      weiPerDay: plan.limits.weiPerDay?.toString() ?? null,
    },
    chainIds: plan.chainIds ?? null,
  };
}
