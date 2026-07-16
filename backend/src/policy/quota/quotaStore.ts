/**
 * Port for the counter store behind quotas and spend caps.
 *
 * The critical property is that `tryConsume` is ATOMIC: check-then-increment must happen as one
 * indivisible step. A read-then-write implementation has a time-of-check/time-of-use race, and at
 * the throughput this system targets — thousands of UserOperations per minute across horizontally
 * scaled replicas — that race is not theoretical. Two concurrent requests would each observe
 * quota remaining and each be granted it, letting a caller exceed their cap by however many
 * replicas are running.
 *
 * This is why the port exposes `tryConsume` rather than the more natural-looking `get`/`set` pair:
 * an interface that permits a racy implementation invites one. The Redis adapter implements this
 * with a Lua script so the check and increment execute atomically server-side.
 */
export interface QuotaStore {
  /**
   * Atomically consumes `amount` against `key` if doing so would not exceed `limit`.
   *
   * Consumption is all-or-nothing: on refusal nothing is consumed, so a caller may retry against
   * a different key without having burned budget here.
   */
  tryConsume(params: QuotaConsumeParams): Promise<QuotaOutcome>;

  /**
   * Returns previously consumed budget.
   *
   * Needed because quota is reserved before the sponsorship is issued: if a later step fails
   * (signing errors, the request is abandoned), the reservation must be undone or the caller is
   * charged for a sponsorship they never received. See `PolicyEngine` for the compensation path.
   */
  release(params: QuotaReleaseParams): Promise<void>;

  /** Current usage, for the admin API and for surfacing remaining budget. Never for deciding. */
  usage(key: string, windowSeconds: number, now: number): Promise<bigint>;
}

export interface QuotaConsumeParams {
  readonly key: string;
  readonly amount: bigint;
  readonly limit: bigint;
  /** Window length. Windows are fixed and aligned to the epoch, not sliding. */
  readonly windowSeconds: number;
  readonly now: number;
}

export interface QuotaReleaseParams {
  readonly key: string;
  readonly amount: bigint;
  readonly windowSeconds: number;
  readonly now: number;
}

export interface QuotaOutcome {
  readonly consumed: boolean;
  /** Usage after this call: the new total on success, the unchanged total on refusal. */
  readonly usage: bigint;
  readonly limit: bigint;
  /** Unix seconds at which the current window rolls over and usage resets to zero. */
  readonly resetsAt: number;
}

/**
 * The fixed window containing `now`, aligned to the Unix epoch.
 *
 * Fixed windows are chosen over sliding ones deliberately. A sliding window is fairer but requires
 * retaining per-request timestamps, which at this throughput is a large multiple of the memory and
 * makes the atomic path materially more complex. The tradeoff is a burst at a window boundary: a
 * caller can spend a full window's budget just before the roll and again just after. For gas
 * sponsorship that is acceptable — the cap's job is bounding sustained cost, not smoothing rate,
 * and rate is separately limited upstream.
 */
export function windowStart(now: number, windowSeconds: number): number {
  return Math.floor(now / windowSeconds) * windowSeconds;
}

export function windowEnd(now: number, windowSeconds: number): number {
  return windowStart(now, windowSeconds) + windowSeconds;
}

/** Namespaces a counter to its window so a new window starts from zero without an eviction pass. */
export function windowedKey(key: string, windowSeconds: number, now: number): string {
  return `${key}:${windowSeconds}:${windowStart(now, windowSeconds)}`;
}
