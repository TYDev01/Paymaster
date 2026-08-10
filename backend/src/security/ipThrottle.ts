import type {QuotaStore} from "../policy/quota/quotaStore.js";
import {windowEnd} from "../policy/quota/quotaStore.js";
import type {Alerter} from "../monitoring/alerting.js";

/**
 * Pre-authentication IP throttling and abuse detection.
 *
 * The gap this closes: the per-IP quota in the policy engine runs AFTER authentication, so it does
 * nothing to protect the auth path itself — an attacker spraying credentials from one IP is checked
 * for a valid key on every request before any per-IP limit applies. This runs BEFORE auth, so a
 * flood or a credential-stuffing run is cut off at the door.
 *
 * Two mechanisms, both backed by the shared `QuotaStore` (Redis in production), so they hold across
 * replicas — an attacker cannot dodge them by hitting a different pod. This is the "Redis-backed
 * abuse detection distinct from quotas" td.md asks for: it shares the store, not the counters.
 *
 *   1. RATE — every request from an IP consumes a token in a short fixed window; over the limit is a
 *      429.
 *   2. ABUSE — authentication FAILURES from an IP are counted in a longer window; past a threshold
 *      the IP is blocked for the rest of that window. The window doubles as the block duration, so
 *      no separate block store or eviction pass is needed. Brute force reveals itself as a burst of
 *      auth failures, which is exactly what this counts.
 */
export interface IpThrottleOptions {
  /** Max requests per IP per `windowSeconds` before throttling. */
  readonly requestsPerWindow: number;
  readonly windowSeconds: number;
  /** Auth failures per IP within `blockWindowSeconds` that trip a temporary block. */
  readonly authFailureThreshold: number;
  readonly blockWindowSeconds: number;
}

export type IpDecision =
  | {readonly allowed: true}
  | {readonly allowed: false; readonly reason: "throttled" | "blocked"; readonly retryAfterSeconds: number};

/**
 * The abuse counters this emits. A port, so the throttle does not depend on the metrics facade.
 *
 * Attack detection is an alerting question, and an alert rule needs a rate to threshold against —
 * the `Alerter` fires once per blocked IP, which pages but does not describe the shape of a
 * campaign. These counters do.
 */
export interface IpThrottleMetrics {
  recordIpRejection(reason: "throttled" | "blocked"): void;
  /** `blocked` is true only for the failure that crossed the threshold. */
  recordAuthFailure(blocked: boolean): void;
}

const RATE_PREFIX = "sec:iprate";
const FAIL_PREFIX = "sec:ipfail";
// A ceiling far above the block threshold: the failure counter is only ever read against the
// threshold, so its own limit just needs to not refuse the increment that trips the block.
const FAILURE_COUNTER_CEILING = 1_000_000n;

export class IpThrottle {
  readonly #store: QuotaStore;
  readonly #options: IpThrottleOptions;
  readonly #alerter: Alerter | undefined;
  readonly #metrics: IpThrottleMetrics | undefined;

  constructor(store: QuotaStore, options: IpThrottleOptions, alerter?: Alerter, metrics?: IpThrottleMetrics) {
    this.#store = store;
    this.#options = options;
    this.#alerter = alerter;
    this.#metrics = metrics;
  }

  /**
   * Decides whether a request from `ip` may proceed to authentication. Checks the block first (a
   * blocked IP is rejected without even spending a rate token) then the rate limit.
   */
  async check(ip: string, now: number): Promise<IpDecision> {
    if (await this.#isBlocked(ip, now)) {
      this.#metrics?.recordIpRejection("blocked");
      return {allowed: false, reason: "blocked", retryAfterSeconds: retryAfter(now, this.#options.blockWindowSeconds)};
    }

    const outcome = await this.#store.tryConsume({
      key: `${RATE_PREFIX}:${ip}`,
      amount: 1n,
      limit: BigInt(this.#options.requestsPerWindow),
      windowSeconds: this.#options.windowSeconds,
      now,
    });
    if (!outcome.consumed) {
      this.#metrics?.recordIpRejection("throttled");
      return {allowed: false, reason: "throttled", retryAfterSeconds: Math.max(1, outcome.resetsAt - now)};
    }
    return {allowed: true};
  }

  /**
   * Records a failed authentication from `ip`. When the count crosses the threshold the IP becomes
   * blocked for the rest of the window, and an alert fires ONCE on that transition (not on every
   * subsequent failure), so a credential-stuffing run pages the operator exactly once.
   */
  async recordAuthFailure(ip: string, now: number): Promise<void> {
    const outcome = await this.#store.tryConsume({
      key: `${FAIL_PREFIX}:${ip}`,
      amount: 1n,
      limit: FAILURE_COUNTER_CEILING,
      windowSeconds: this.#options.blockWindowSeconds,
      now,
    });

    const threshold = BigInt(this.#options.authFailureThreshold);
    // Fire only on the exact crossing: usage == threshold means this failure is the one that blocked.
    this.#metrics?.recordAuthFailure(outcome.usage === threshold);
    if (outcome.usage === threshold) {
      this.#alerter?.fire({
        key: `ip-blocked:${ip}`,
        severity: "warning",
        title: "IP blocked for repeated auth failures",
        detail: `${ip} reached ${this.#options.authFailureThreshold} auth failures in ${this.#options.blockWindowSeconds}s and is blocked`,
        labels: {ip},
      });
    }
  }

  async #isBlocked(ip: string, now: number): Promise<boolean> {
    const failures = await this.#store.usage(`${FAIL_PREFIX}:${ip}`, this.#options.blockWindowSeconds, now);
    return failures >= BigInt(this.#options.authFailureThreshold);
  }
}

function retryAfter(now: number, windowSeconds: number): number {
  return Math.max(1, windowEnd(now, windowSeconds) - now);
}
