import {ALLOW, deny, type PolicyContext, type PolicyDecision, type PolicyDenial} from "./context.js";
import {isReserving, RULE_COST_ORDER, type PolicyRule, type ReservingRule} from "./rule.js";

/**
 * A named, ordered collection of rules. Every rule must pass; the first denial wins.
 *
 * AND-only composition is a deliberate limit. Boolean policy trees (this OR that AND NOT other)
 * are where policy engines become unreviewable, and an unreviewable authorisation rule is a
 * liability in a component that spends money. A policy that needs OR is expressed as two policies
 * on two API keys, which is auditable by reading it.
 */
export interface Policy {
  readonly id: string;
  readonly rules: readonly PolicyRule[];
}

export interface PolicyEvaluation {
  readonly decision: PolicyDecision;
  readonly policyId: string;
  /** Rules evaluated before the decision was reached, in order. For debugging a denial. */
  readonly evaluated: readonly string[];
}

/** Emitted for every evaluation so denials are countable per rule without parsing log text. */
export interface PolicyObserver {
  onDecision(evaluation: PolicyEvaluation, durationMs: number): void;
}

/**
 * Evaluates a policy against a sponsorship request.
 *
 * Two properties matter more than anything else here:
 *
 * 1. FAIL CLOSED. A rule that throws denies. The alternative — treating an error as a pass — means
 *    a quota store outage silently converts into unlimited free gas. Every failure mode of this
 *    component must cost availability, never money.
 *
 * 2. RESERVATIONS ARE COMPENSATED. Reserving rules consume budget as they evaluate. If a later
 *    rule denies, everything already reserved is released. Without this, a request refused by the
 *    last rule would still have burned the caller's wallet and IP quota.
 */
export class PolicyEngine {
  readonly #observer: PolicyObserver | undefined;

  constructor(options: {observer?: PolicyObserver} = {}) {
    this.#observer = options.observer;
  }

  async evaluate(policy: Policy, context: PolicyContext): Promise<PolicyEvaluation> {
    const started = performance.now();
    const ordered = orderRules(policy.rules);
    const evaluated: string[] = [];
    const reserved: ReservingRule[] = [];

    let decision: PolicyDecision = ALLOW;

    for (const rule of ordered) {
      evaluated.push(rule.name);
      const outcome = await this.#evaluateRule(rule, context);

      if (!outcome.allowed) {
        decision = outcome;
        break;
      }
      if (isReserving(rule)) reserved.push(rule);
    }

    if (!decision.allowed && reserved.length > 0) {
      await this.#releaseAll(reserved, context);
    }

    const evaluation: PolicyEvaluation = {decision, policyId: policy.id, evaluated};
    this.#observer?.onDecision(evaluation, performance.now() - started);
    return evaluation;
  }

  /**
   * Releases budget for an approved evaluation that was ultimately not acted on.
   *
   * The engine cannot do this itself: it returns before the caller knows whether signing and
   * persistence succeeded. A caller that approves and then fails MUST call this, or reserved
   * budget leaks until the window rolls over.
   */
  async releaseReservations(policy: Policy, context: PolicyContext): Promise<void> {
    await this.#releaseAll(policy.rules.filter(isReserving), context);
  }

  async #evaluateRule(rule: PolicyRule, context: PolicyContext): Promise<PolicyDecision> {
    try {
      return await rule.evaluate(context);
    } catch (error) {
      return this.#ruleError(rule, error);
    }
  }

  #ruleError(rule: PolicyRule, error: unknown): PolicyDenial {
    const message = error instanceof Error ? error.message : String(error);
    return deny(rule.name, "RULE_ERROR", `rule ${rule.name} failed to evaluate: ${message}`);
  }

  /**
   * Releases every reservation, even if some releases fail.
   *
   * A failed release is a leak of that caller's budget until the window rolls, which is bad but
   * bounded and self-healing. Letting the throw escape would be worse: it would mask the original
   * denial with an unrelated error, and abandon the remaining releases.
   */
  async #releaseAll(rules: readonly ReservingRule[], context: PolicyContext): Promise<void> {
    const results = await Promise.allSettled(rules.map((rule) => rule.release(context)));
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        this.#observer?.onDecision(
          {
            decision: deny(rules[i]!.name, "RULE_ERROR", `failed to release reservation: ${String(result.reason)}`),
            policyId: "<release>",
            evaluated: [rules[i]!.name],
          },
          0,
        );
      }
    }
  }
}

/**
 * Cheap rules first, and stable within a cost tier.
 *
 * This is not only a performance choice. Reserving rules are all `store` or `network` cost, so
 * ordering by cost also guarantees no budget is consumed before every free check has passed —
 * which is what keeps the common case (a request denied by an allowlist) from touching the quota
 * store at all.
 */
export function orderRules(rules: readonly PolicyRule[]): readonly PolicyRule[] {
  return [...rules]
    .map((rule, index) => ({rule, index}))
    .sort((a, b) => {
      const byCost = RULE_COST_ORDER[a.rule.cost] - RULE_COST_ORDER[b.rule.cost];
      return byCost !== 0 ? byCost : a.index - b.index;
    })
    .map(({rule}) => rule);
}
