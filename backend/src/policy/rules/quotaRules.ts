import {ALLOW, deny, type PolicyContext, type PolicyDecision} from "../context.js";
import type {ReservingRule} from "../rule.js";
import type {QuotaStore} from "../quota/quotaStore.js";

/** What the quota is counted against. */
export type QuotaSubject = "wallet" | "ip" | "apiKey" | "chain" | "target" | "global";

/** What is being counted: operations, or wei of gas. */
export type QuotaUnit = "operations" | "wei";

export interface QuotaRuleOptions {
  readonly name: string;
  readonly subject: QuotaSubject;
  readonly unit: QuotaUnit;
  readonly limit: bigint;
  readonly windowSeconds: number;
  /**
   * What to do when the subject is not present on the request — e.g. a per-IP quota on a request
   * with no client IP. Defaults to "deny", because an absent subject means the quota cannot be
   * enforced, and a quota that silently does not apply is worse than no quota at all.
   */
  readonly onMissingSubject?: "deny" | "skip";
}

/**
 * Counts operations or spend against a subject within a fixed window.
 *
 * This one class covers td.md's per-wallet, per-IP, per-contract, per-chain quotas and its daily
 * spending caps. They differ only in what they key on and what they count, so they are one rule
 * parameterised rather than six near-identical classes.
 *
 * Reserving, not merely checking: budget is consumed atomically at evaluation. Checking first and
 * consuming later would leave a window in which concurrent requests both pass.
 */
export class QuotaRule implements ReservingRule {
  readonly reserving = true as const;
  readonly cost = "store" as const;
  readonly name: string;

  readonly #store: QuotaStore;
  readonly #options: Required<QuotaRuleOptions>;

  constructor(store: QuotaStore, options: QuotaRuleOptions) {
    if (options.limit < 0n) throw new RangeError(`quota limit must be >= 0, got ${options.limit}`);
    if (options.windowSeconds <= 0) throw new RangeError(`windowSeconds must be > 0, got ${options.windowSeconds}`);

    this.#store = store;
    this.name = options.name;
    this.#options = {...options, onMissingSubject: options.onMissingSubject ?? "deny"};
  }

  async evaluate(context: PolicyContext): Promise<PolicyDecision> {
    const key = this.#keyFor(context);
    if (key === undefined) {
      if (this.#options.onMissingSubject === "skip") return ALLOW;
      return deny(
        this.name,
        "QUOTA_EXCEEDED",
        `cannot enforce ${this.#options.subject} quota: the request carries no ${this.#options.subject}`,
      );
    }

    const amount = this.#amountFor(context);
    const outcome = await this.#store.tryConsume({
      key,
      amount,
      limit: this.#options.limit,
      windowSeconds: this.#options.windowSeconds,
      now: context.now,
    });

    if (outcome.consumed) return ALLOW;

    const code = this.#options.unit === "wei" ? "SPEND_CAP_EXCEEDED" : "QUOTA_EXCEEDED";
    return deny(
      this.name,
      code,
      `${this.#options.subject} ${this.#options.unit} quota exhausted: ` +
        `${outcome.usage}/${outcome.limit}, resets at ${outcome.resetsAt}`,
    );
  }

  async release(context: PolicyContext): Promise<void> {
    const key = this.#keyFor(context);
    if (key === undefined) return;
    await this.#store.release({
      key,
      amount: this.#amountFor(context),
      windowSeconds: this.#options.windowSeconds,
      now: context.now,
    });
  }

  /** Remaining budget, for surfacing to callers. Never used to decide — that would reintroduce the race. */
  async remaining(context: PolicyContext): Promise<bigint | undefined> {
    const key = this.#keyFor(context);
    if (key === undefined) return undefined;
    const used = await this.#store.usage(key, this.#options.windowSeconds, context.now);
    const left = this.#options.limit - used;
    return left > 0n ? left : 0n;
  }

  #amountFor(context: PolicyContext): bigint {
    return this.#options.unit === "wei" ? context.maxCost : 1n;
  }

  /**
   * The counter key. Namespaced by rule name so two quotas on the same subject — say a daily and
   * an hourly wallet cap — do not share a counter.
   */
  #keyFor(context: PolicyContext): string | undefined {
    const prefix = `quota:${this.name}`;
    switch (this.#options.subject) {
      case "wallet":
        return `${prefix}:${context.chainId}:${context.sender.toLowerCase()}`;
      case "chain":
        return `${prefix}:${context.chainId}`;
      case "global":
        return prefix;
      case "ip":
        return context.clientIp === undefined ? undefined : `${prefix}:${context.clientIp}`;
      case "apiKey":
        return context.apiKeyId === undefined ? undefined : `${prefix}:${context.apiKeyId}`;
      case "target": {
        // A batch hitting several contracts has no single target to key on. Counting it against
        // each target would let one operation consume several budgets and make release ambiguous,
        // so a per-target quota only applies to single-call operations.
        if (context.calls === undefined || context.calls.length !== 1) return undefined;
        return `${prefix}:${context.chainId}:${context.calls[0]!.target.toLowerCase()}`;
      }
    }
  }
}
