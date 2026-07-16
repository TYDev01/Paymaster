import type {PolicyContext, PolicyDecision} from "./context.js";

/**
 * One policy check.
 *
 * Rules are the extension point td.md calls "custom policy plugins": anything implementing this
 * interface can join a policy set without the engine knowing what it does.
 *
 * A rule MUST NOT have side effects unless it is a `ReservingRule` (see below). The engine
 * short-circuits on the first denial, so a rule with hidden side effects would apply them
 * inconsistently depending on where it sits in the order.
 */
export interface PolicyRule {
  /** Stable identifier. Appears in denial payloads and metric labels, so treat it as an API. */
  readonly name: string;

  /**
   * Cost hint used to order evaluation. Cheaper rules run first so an expensive check is skipped
   * when a free one already denies.
   *   pure    - in-memory comparison only
   *   store   - reads or writes the quota store
   *   network - performs a chain read or other remote call
   */
  readonly cost: RuleCost;

  evaluate(context: PolicyContext): Promise<PolicyDecision> | PolicyDecision;
}

export type RuleCost = "pure" | "store" | "network";

export const RULE_COST_ORDER: Record<RuleCost, number> = {pure: 0, store: 1, network: 2};

/**
 * A rule that consumes budget when it approves.
 *
 * These are the only rules permitted side effects, and the engine treats them specially: it runs
 * them last, and if a later reserving rule denies, it releases what the earlier ones took. Without
 * that compensation a caller's per-wallet quota would be charged by a request that was ultimately
 * refused by their per-IP quota.
 */
export interface ReservingRule extends PolicyRule {
  readonly reserving: true;
  /** Undo a reservation made by a previous `evaluate` that approved. Must be idempotent-safe. */
  release(context: PolicyContext): Promise<void>;
}

export function isReserving(rule: PolicyRule): rule is ReservingRule {
  return (rule as ReservingRule).reserving === true;
}
