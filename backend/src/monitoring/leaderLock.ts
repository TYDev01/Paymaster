import {Logger} from "@nestjs/common";

/**
 * Distributed lock / leader election — td.md's "distributed lock management".
 *
 * The concrete problem it solves is duplicate paging. `FundingMonitor` runs on every replica, and
 * `AlertGate`'s edge-triggering is PER PROCESS, so three replicas seeing one drained deposit raise
 * three separate alerts, and a resolve from one of them can close an incident the other two still
 * consider active. PagerDuty's dedup key collapses the duplicates; a Slack webhook or a generic
 * endpoint does not.
 *
 * What is deliberately NOT gated by this:
 *
 *   * The MONITORING itself. Every replica keeps polling and keeps updating its own gauges — a
 *     chain that is unreachable from one pod and fine from another is a real condition, and
 *     electing a leader to observe on everyone's behalf would hide it.
 *   * The SPEND RECONCILER. It already claims each `sponsorships` row atomically, so concurrent
 *     replicas are safe by construction. Adding a lock would make it single-threaded for no gain
 *     and introduce a failure mode (a stalled leader) that the current design does not have.
 *
 * Correctness note: this is a lease, not a fence. A leader that stalls past its TTL can believe it
 * still leads while another replica has taken over, so two replicas may briefly both alert. That is
 * acceptable HERE — the cost is a duplicate page, which is exactly what the mechanism already
 * degrades to without it. Do not reuse this lock for anything where double execution is unsafe;
 * that needs a fencing token, and money movement needs the atomic claim the reconciler uses.
 */
export interface LeaderLock {
  /** True if this process currently holds leadership. Cheap: reads cached state, never blocks. */
  readonly isLeader: boolean;
  /** Attempts to take or renew leadership. Called on a timer by the owner. */
  tryAcquire(): Promise<boolean>;
  /** Gives up leadership, so a rolling deploy hands over in milliseconds rather than a full TTL. */
  release(): Promise<void>;
}

/**
 * The single-replica implementation: with no one to contend with, this process always leads.
 *
 * Used when Redis is absent — the same condition under which quotas are process-local, i.e. a
 * deployment already documented as single-instance.
 */
export class AlwaysLeader implements LeaderLock {
  readonly isLeader = true;
  async tryAcquire(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {}
}

/** The slice of a Redis client this needs. Structural, so the port does not depend on ioredis. */
export interface RedisLockClient {
  set(key: string, value: string, mode: "PX", ttl: number, condition: "NX"): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * Renews only if we still hold it, in one atomic step.
 *
 * A plain `SET key holder PX ttl` would let a replica that lost leadership (paused long enough for
 * its lease to expire and another replica to take over) silently steal it back mid-term. Comparing
 * the holder and extending in one script makes renewal conditional on still being the holder.
 */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** Releases only our own lease — never someone else's, which a bare DEL would happily do. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RedisLeaderLock implements LeaderLock {
  readonly #redis: RedisLockClient;
  readonly #key: string;
  readonly #holder: string;
  readonly #ttlMs: number;
  readonly #logger = new Logger("leader");
  #held = false;

  /**
   * @param holder a value unique to this process. Two processes sharing it would each believe the
   *               other's lease was their own, which defeats the whole mechanism.
   */
  constructor(redis: RedisLockClient, options: {key: string; holder: string; ttlMs: number}) {
    this.#redis = redis;
    this.#key = options.key;
    this.#holder = options.holder;
    this.#ttlMs = options.ttlMs;
  }

  get isLeader(): boolean {
    return this.#held;
  }

  async tryAcquire(): Promise<boolean> {
    try {
      if (this.#held) {
        const renewed = await this.#redis.eval(RENEW_SCRIPT, 1, this.#key, this.#holder, String(this.#ttlMs));
        // Losing a renewal means our lease expired and someone else may hold it. Step down rather
        // than re-take it immediately: the new leader's alerting state is the current one.
        this.#held = renewed === 1 || renewed === "1";
        if (!this.#held) this.#logger.warn("lost leadership: lease expired before renewal");
        return this.#held;
      }

      const acquired = await this.#redis.set(this.#key, this.#holder, "PX", this.#ttlMs, "NX");
      this.#held = acquired !== null;
      if (this.#held) this.#logger.log("acquired leadership");
      return this.#held;
    } catch (error) {
      // Redis is unreachable. Step down: the safe failure for a lock whose purpose is to keep ONE
      // replica acting is nobody acting, not everybody acting. Alerts still reach the log on every
      // replica, so this degrades observability rather than losing it.
      this.#held = false;
      this.#logger.warn(`leadership check failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    try {
      await this.#redis.eval(RELEASE_SCRIPT, 1, this.#key, this.#holder);
    } catch {
      // Nothing to do: the lease expires on its own within the TTL. Logging the failure of a
      // best-effort cleanup during shutdown would be noise on every rolling deploy.
    }
  }
}
