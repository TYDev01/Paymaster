import {
  windowedKey,
  windowEnd,
  type QuotaConsumeParams,
  type QuotaOutcome,
  type QuotaReleaseParams,
  type QuotaStore,
} from "./quotaStore.js";

/**
 * Quota store held in this process's memory.
 *
 * This is a real implementation, not a stand-in: it is correct and race-free for a single-process
 * deployment, and it is what the unit tests exercise. Node's single-threaded execution gives the
 * atomicity `tryConsume` requires for free — there is no await between the read and the write
 * below, so no other task can interleave.
 *
 * It is NOT correct for the deployment this system targets. Counters live per-process, so with N
 * replicas behind a load balancer each caller effectively gets N times their quota. Use the Redis
 * adapter for anything horizontally scaled; this one is for local development, tests, and
 * single-node deployments.
 */
export class InMemoryQuotaStore implements QuotaStore {
  readonly #counters = new Map<string, bigint>();

  async tryConsume(params: QuotaConsumeParams): Promise<QuotaOutcome> {
    const {key, amount, limit, windowSeconds, now} = params;
    const slot = windowedKey(key, windowSeconds, now);
    const current = this.#counters.get(slot) ?? 0n;
    const resetsAt = windowEnd(now, windowSeconds);

    // No `await` between this read and the write: the check and increment are indivisible with
    // respect to other tasks on this event loop.
    if (current + amount > limit) {
      return {consumed: false, usage: current, limit, resetsAt};
    }

    const updated = current + amount;
    this.#counters.set(slot, updated);
    return {consumed: true, usage: updated, limit, resetsAt};
  }

  async release(params: QuotaReleaseParams): Promise<void> {
    const {key, amount, windowSeconds, now} = params;
    const slot = windowedKey(key, windowSeconds, now);
    const current = this.#counters.get(slot);
    if (current === undefined) return;

    // Clamp at zero: a release for a window that has already rolled over must not push the new
    // window's counter negative and hand out free budget.
    const updated = current - amount;
    if (updated <= 0n) this.#counters.delete(slot);
    else this.#counters.set(slot, updated);
  }

  async usage(key: string, windowSeconds: number, now: number): Promise<bigint> {
    return this.#counters.get(windowedKey(key, windowSeconds, now)) ?? 0n;
  }

  /**
   * Drops counters for windows that have already ended.
   *
   * Redis expires keys by TTL; a Map does not, so without this, memory grows with the number of
   * distinct keys times the number of windows elapsed. Callers should run this periodically.
   */
  evictExpired(now: number): number {
    let evicted = 0;
    for (const slot of this.#counters.keys()) {
      const parts = slot.split(":");
      const start = Number(parts.at(-1));
      const windowSeconds = Number(parts.at(-2));
      if (Number.isFinite(start) && Number.isFinite(windowSeconds) && start + windowSeconds <= now) {
        this.#counters.delete(slot);
        evicted++;
      }
    }
    return evicted;
  }

  get size(): number {
    return this.#counters.size;
  }
}
