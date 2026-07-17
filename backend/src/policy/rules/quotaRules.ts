import {ALLOW, deny, type PolicyContext, type PolicyDecision} from "../context.js";
import type {ReservingRule} from "../rule.js";
import type {QuotaStore} from "../quota/quotaStore.js";

/** What the quota is counted against. */
export type QuotaSubject = "wallet" | "ip" | "apiKey" | "chain" | "target" | "global";

/** What is being counted: operations, or wei of gas. */
export type QuotaUnit = "operations" | "wei";

/**
 * Spend quotas are COUNTED in gwei, even though they are configured and reported in wei.
 *
 * This is forced by the counter stores, not chosen for convenience. Redis `INCRBY` takes a signed
 * 64-bit integer and errors with "increment or decrement would overflow" past 9.22e18 — which is
 * 9.22 ETH, so a 10 ETH daily cap cannot be counted in wei at all. Worse, Redis Lua numbers are
 * doubles: `tonumber("1000000000000000001")` yields 1e18 and `1e18 + 1` yields 1e18, so wei
 * arithmetic in a Lua script does not overflow loudly — it silently returns the wrong number.
 *
 * In gwei the same int64 holds ~9.2e9 ETH and Lua's 53-bit mantissa stays exact to ~9e6 ETH, both
 * far beyond any real paymaster. The cost is 1-gwei granularity on spend accounting, against a
 * single operation costing on the order of a million gwei.
 */
const WEI_PER_GWEI = 1_000_000_000n;

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
  /** The limit in COUNTING units: operations, or gwei. See WEI_PER_GWEI. */
  readonly #countedLimit: bigint;

  constructor(store: QuotaStore, options: QuotaRuleOptions) {
    if (options.limit < 0n) throw new RangeError(`quota limit must be >= 0, got ${options.limit}`);
    if (options.windowSeconds <= 0) throw new RangeError(`windowSeconds must be > 0, got ${options.windowSeconds}`);

    this.#store = store;
    this.name = options.name;
    this.#options = {...options, onMissingSubject: options.onMissingSubject ?? "deny"};
    // Limits round DOWN and charges round UP: both errors land on the side of spending less than
    // configured, never more.
    this.#countedLimit = options.unit === "wei" ? options.limit / WEI_PER_GWEI : options.limit;
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
      limit: this.#countedLimit,
      windowSeconds: this.#options.windowSeconds,
      now: context.now,
    });

    if (outcome.consumed) return ALLOW;

    const code = this.#options.unit === "wei" ? "SPEND_CAP_EXCEEDED" : "QUOTA_EXCEEDED";
    return deny(
      this.name,
      code,
      `${this.#options.subject} ${this.#options.unit} quota exhausted: ` +
        `${this.#report(outcome.usage)}/${this.#report(outcome.limit)}, resets at ${outcome.resetsAt}`,
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

  /**
   * Remaining budget in the CONFIGURED unit (wei for spend caps), for surfacing to callers.
   * Never used to decide — that would reintroduce the race tryConsume exists to close.
   */
  async remaining(context: PolicyContext): Promise<bigint | undefined> {
    const key = this.#keyFor(context);
    if (key === undefined) return undefined;
    const used = await this.#store.usage(key, this.#options.windowSeconds, context.now);
    const left = this.#countedLimit - used;
    return this.#report(left > 0n ? left : 0n);
  }

  /**
   * The amount to charge, in counting units.
   *
   * Spend rounds UP to the next gwei. Rounding down would let an operation cheap enough to floor
   * to zero consume no budget at all — a cap that can be bypassed by making requests small enough
   * is not a cap. In practice a real operation costs on the order of 1e6 gwei, so this rounding is
   * noise; it is the direction that matters.
   */
  #amountFor(context: PolicyContext): bigint {
    if (this.#options.unit !== "wei") return 1n;
    return (context.maxCost + WEI_PER_GWEI - 1n) / WEI_PER_GWEI;
  }

  /** Converts a counted value back to the configured unit, for messages and `remaining`. */
  #report(counted: bigint): bigint {
    return this.#options.unit === "wei" ? counted * WEI_PER_GWEI : counted;
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
