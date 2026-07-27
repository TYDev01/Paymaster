import {Logger} from "@nestjs/common";

/**
 * Runs an async tick on a fixed interval, without ever overlapping two ticks.
 *
 * A naive `setInterval(async fn)` fires on the clock regardless of whether the previous tick has
 * finished, so a slow chain read stacks ticks until the event loop drowns. This schedules the NEXT
 * tick only after the current one settles, so a tick that takes longer than the interval simply
 * makes ticks less frequent instead of piling up.
 *
 * A throwing tick is logged and the loop continues: a monitor that dies on one bad RPC response
 * stops monitoring, which is exactly when monitoring matters most.
 */
export class IntervalLoop {
  readonly #intervalMs: number;
  readonly #tick: () => Promise<void>;
  readonly #logger: Logger;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;

  constructor(name: string, intervalMs: number, tick: () => Promise<void>) {
    this.#intervalMs = intervalMs;
    this.#tick = tick;
    this.#logger = new Logger(name);
  }

  /**
   * Starts the loop. Runs one tick immediately (so a low deposit is caught at boot, not one interval
   * later) then schedules the rest. The immediate tick is awaited so callers can surface a startup
   * failure, but a rejection does not stop the loop.
   */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.#runOnce();
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.#runOnce().finally(() => this.#schedule());
    }, this.#intervalMs);
    // Do not keep the process alive solely for this timer.
    this.#timer.unref?.();
  }

  async #runOnce(): Promise<void> {
    if (this.#running) return; // A previous tick is still going; skip rather than overlap.
    this.#running = true;
    try {
      await this.#tick();
    } catch (error) {
      this.#logger.error(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#running = false;
    }
  }
}
