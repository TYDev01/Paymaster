import {Logger} from "@nestjs/common";

/**
 * Operational alerting, as a port.
 *
 * The backend does not know or care whether an alert becomes a PagerDuty incident, a Slack message,
 * or a line in a log — that is a deployment decision. Everything that can degrade sponsorship (a
 * drained deposit, an RPC outage, a reconciliation stall) speaks to this interface, so wiring a real
 * pager in is a composition-root change, not a change to the thing that detected the problem.
 *
 * Alerts are keyed and edge-triggered by their producers: a monitor fires when a condition BECOMES
 * true and resolves when it clears, rather than screaming every tick. `key` is the identity used to
 * correlate a `fire` with its later `resolve`, so it must be stable for a given condition (e.g.
 * `deposit-low:8453`) and distinct across conditions.
 */
export type AlertSeverity = "warning" | "critical";

export interface Alert {
  /** Stable identity for this condition instance, e.g. `deposit-low:8453`. */
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly detail: string;
  /** Machine-readable context (chainId, amounts). Safe to use as metric/alert labels. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

export interface Alerter {
  fire(alert: Alert): Promise<void> | void;
  /** Signals that the condition behind `key` has cleared. Best-effort; may be a no-op. */
  resolve(key: string): Promise<void> | void;
}

/**
 * Default alerter: writes to the application log.
 *
 * Always appropriate — logs are scraped and alerted on downstream — and it is the safe fallback when
 * no pager is configured, because a paymaster with no alerting at all is worse than one whose alerts
 * only reach the log. A real deployment composes this with a pager via `CompositeAlerter`.
 */
export class LoggingAlerter implements Alerter {
  readonly #logger: Logger;

  constructor(logger: Logger = new Logger("alert")) {
    this.#logger = logger;
  }

  fire(alert: Alert): void {
    const labels = alert.labels === undefined ? "" : ` ${JSON.stringify(alert.labels)}`;
    const line = `[${alert.key}] ${alert.title}: ${alert.detail}${labels}`;
    if (alert.severity === "critical") this.#logger.error(line);
    else this.#logger.warn(line);
  }

  resolve(key: string): void {
    this.#logger.log(`[${key}] resolved`);
  }
}

/**
 * Fans an alert out to several sinks.
 *
 * A failing sink must not swallow the others: if the pager API is down, the alert must still reach
 * the log. So each delivery is isolated and a throw is logged, never propagated — a failure to
 * DELIVER an alert cannot be allowed to crash the thing that RAISED it.
 */
export class CompositeAlerter implements Alerter {
  readonly #sinks: readonly Alerter[];
  readonly #logger = new Logger("alert");

  constructor(sinks: readonly Alerter[]) {
    this.#sinks = sinks;
  }

  async fire(alert: Alert): Promise<void> {
    await this.#each((s) => s.fire(alert), "fire");
  }

  async resolve(key: string): Promise<void> {
    await this.#each((s) => s.resolve(key), "resolve");
  }

  async #each(op: (sink: Alerter) => Promise<void> | void, what: string): Promise<void> {
    await Promise.all(
      this.#sinks.map(async (sink) => {
        try {
          await op(sink);
        } catch (error) {
          this.#logger.error(`alert sink failed on ${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }
}
