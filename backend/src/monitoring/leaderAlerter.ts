import type {BackgroundService} from "./backgroundService.js";
import {IntervalLoop} from "./intervalLoop.js";
import type {Alert, Alerter} from "./alerting.js";
import type {LeaderLock} from "./leaderLock.js";

/**
 * Delivers an alert only from the replica that currently leads.
 *
 * Wraps the pager, not the monitors: every replica keeps observing and keeps its own metrics, and
 * only the delivery is deduplicated. That is the right seam, because the thing being duplicated is
 * the PAGE, not the observation — three replicas noticing the same drained deposit is correct;
 * three incidents for it is not.
 *
 * It gates only conditions that are globally true (a chain's deposit, a chain's RPC). A follower's
 * suppressed alert is one the leader is raising from its own observation of the same chain. The
 * exception worth naming: if a condition is genuinely local to a follower — its own network path to
 * one RPC — the leader will not see it, and this suppresses the page. The log sink is not gated, so
 * that case is still recorded on the affected replica; log-based alerting is the backstop for it.
 */
export class LeaderOnlyAlerter implements Alerter {
  readonly #inner: Alerter;
  readonly #lock: LeaderLock;

  constructor(inner: Alerter, lock: LeaderLock) {
    this.#inner = inner;
    this.#lock = lock;
  }

  async fire(alert: Alert): Promise<void> {
    if (!this.#lock.isLeader) return;
    await this.#inner.fire(alert);
  }

  async resolve(key: string): Promise<void> {
    // Gated for the same reason as `fire`, and one more: a follower resolving would close an
    // incident the leader still considers open, and the leader would never re-fire it because its
    // own gate still reads as firing.
    if (!this.#lock.isLeader) return;
    await this.#inner.resolve(key);
  }
}

/**
 * Keeps the lease alive.
 *
 * A lease has to be renewed well inside its TTL or a slow tick loses leadership to nothing —
 * no replica holds it until the next tick, and alerts are silently dropped in that gap. Renewing
 * at a third of the TTL leaves room for two failed attempts before expiry.
 */
export class LeadershipService implements BackgroundService {
  readonly name = "leader-lock";

  readonly #lock: LeaderLock;
  readonly #loop: IntervalLoop;

  constructor(lock: LeaderLock, options: {ttlMs: number}) {
    this.#lock = lock;
    this.#loop = new IntervalLoop("leader", Math.max(1_000, Math.floor(options.ttlMs / 3)), async () => {
      await this.#lock.tryAcquire();
    });
  }

  async start(): Promise<void> {
    await this.#loop.start();
  }

  async stop(): Promise<void> {
    this.#loop.stop();
    // Explicit release so a rolling deploy hands leadership over immediately instead of leaving
    // every alert unpaged until the lease expires.
    await this.#lock.release();
  }
}
