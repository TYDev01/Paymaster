import {Logger} from "@nestjs/common";

import type {BackgroundService} from "../monitoring/backgroundService.js";
import {IntervalLoop} from "../monitoring/intervalLoop.js";
import type {PolicyBroadcast} from "./policyBroadcast.js";
import type {PolicySource} from "./policySource.js";

/**
 * Keeps this replica's policy set current.
 *
 * Two mechanisms, and the pairing is the design:
 *
 *   * The TIMER is the correctness guarantee. Every replica reloads on an interval regardless of
 *     what any other replica did, so policy converges even if the broadcast never arrives — a
 *     replica that was reconnecting, a Redis restart, a deployment with no Redis at all. The bound
 *     on staleness is the interval, and it holds unconditionally.
 *   * The BROADCAST is a latency optimisation on top. When it works, a policy change lands on every
 *     replica in milliseconds instead of within the interval.
 *
 * Building only the broadcast would make correctness depend on a fire-and-forget message; building
 * only the timer would leave an operator waiting out the interval after every urgent change. Note
 * that the interval is the reason this is safe to poll: `PostgresPolicyRepository.load()` reads the
 * whole (small) policy set, and it is the same query the admin path already runs.
 *
 * Bursts are coalesced. Upserting ten policies in a script publishes ten messages; without
 * coalescing that is ten full reloads, nine of them redundant, all hitting Postgres at once from
 * every replica simultaneously.
 */
export class PolicyReloader implements BackgroundService {
  readonly name = "policy-reloader";

  readonly #policies: PolicySource;
  readonly #broadcast: PolicyBroadcast;
  readonly #loop: IntervalLoop;
  readonly #coalesceMs: number;
  readonly #logger = new Logger("policy");

  #coalesceTimer: NodeJS.Timeout | undefined;
  #reloading = false;
  #reloadAgain = false;

  constructor(policies: PolicySource, broadcast: PolicyBroadcast, options: {intervalMs: number; coalesceMs?: number}) {
    this.#policies = policies;
    this.#broadcast = broadcast;
    this.#coalesceMs = options.coalesceMs ?? 250;
    this.#loop = new IntervalLoop("policy", options.intervalMs, () => this.reloadNow());
  }

  async start(): Promise<void> {
    await this.#broadcast.subscribe(() => this.#onBroadcast());
    await this.#loop.start();
  }

  async stop(): Promise<void> {
    this.#loop.stop();
    if (this.#coalesceTimer !== undefined) clearTimeout(this.#coalesceTimer);
    this.#coalesceTimer = undefined;
    await this.#broadcast.close();
  }

  /**
   * Reloads immediately, serialising concurrent callers.
   *
   * A reload triggered by a broadcast while the timer's reload is in flight must not run
   * simultaneously — two loads racing to assign `#policies` could leave the OLDER snapshot
   * installed. Instead the second request sets a flag and the in-flight reload repeats once it
   * finishes, so the last state of the database always wins.
   */
  async reloadNow(): Promise<void> {
    if (this.#reloading) {
      this.#reloadAgain = true;
      return;
    }
    this.#reloading = true;
    try {
      do {
        this.#reloadAgain = false;
        await this.#policies.reload();
      } while (this.#reloadAgain);
    } finally {
      this.#reloading = false;
    }
  }

  #onBroadcast(): void {
    if (this.#coalesceTimer !== undefined) return;
    this.#coalesceTimer = setTimeout(() => {
      this.#coalesceTimer = undefined;
      void this.reloadNow().catch((error: unknown) => {
        // Logged, not thrown: the previous policy set stays in place and the timer will retry.
        // A failed reload must never take down a replica that is still serving correctly.
        this.#logger.error(`policy reload after broadcast failed: ${message(error)}`);
      });
    }, this.#coalesceMs);
    this.#coalesceTimer.unref?.();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
