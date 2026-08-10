import type {Alert, Alerter} from "./alerting.js";

/**
 * Turns a per-tick snapshot of "what is currently wrong" into edge-triggered alerts.
 *
 * A monitor recomputes, every tick, the full set of conditions that are active right now and hands
 * it to `reconcile`. The gate does the bookkeeping:
 *
 *   * a condition that was not active last tick FIRES,
 *   * a condition still active after `reAlertMs` RE-FIRES (so an unresolved page is not forgotten),
 *   * a condition no longer present RESOLVES.
 *
 * Keeping this out of the monitors means each monitor only has to answer "what is wrong now", never
 * "did I already alert on this" — the second question is where duplicate-alert and missed-resolve
 * bugs live, so it is written once, here, and tested once.
 */
export class AlertGate {
  readonly #alerter: Alerter;
  readonly #reAlertMs: number;
  readonly #now: () => number;
  /** key -> epoch ms of the last fire. Presence means "currently firing". */
  readonly #firing = new Map<string, number>();

  constructor(alerter: Alerter, options: {reAlertMs: number}, now: () => number = () => Date.now()) {
    this.#alerter = alerter;
    this.#reAlertMs = options.reAlertMs;
    this.#now = now;
  }

  async reconcile(active: readonly Alert[]): Promise<void> {
    const now = this.#now();
    const activeKeys = new Set<string>();

    for (const alert of active) {
      activeKeys.add(alert.key);
      const lastFired = this.#firing.get(alert.key);
      if (lastFired === undefined || now - lastFired >= this.#reAlertMs) {
        this.#firing.set(alert.key, now);
        await this.#alerter.fire(alert);
      }
    }

    for (const key of [...this.#firing.keys()]) {
      if (!activeKeys.has(key)) {
        this.#firing.delete(key);
        await this.#alerter.resolve(key);
      }
    }
  }

  /** Keys currently in the firing state. Exposed for tests and for a metrics gauge. */
  get firingKeys(): readonly string[] {
    return [...this.#firing.keys()];
  }
}
