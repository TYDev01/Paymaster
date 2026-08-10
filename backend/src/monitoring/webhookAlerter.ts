import {createHmac} from "node:crypto";

import type {Alert, AlertSeverity, Alerter} from "./alerting.js";

/**
 * A real pager sink behind the `Alerter` port.
 *
 * `LoggingAlerter` is the safe default, but a log line does not wake anyone at 3am, and the
 * conditions this system detects — a drained deposit, a tripped RPC circuit — stop sponsorship
 * outright. This delivers the same alerts over HTTP, in whichever shape the operator's incident
 * tooling expects.
 *
 * Three payload formats, because the sink an operator already has is the one they will actually
 * wire up:
 *
 *   * `pagerduty` — Events API v2. `alert.key` becomes the `dedup_key`, so the `resolve()` that
 *     `AlertGate` emits when a condition clears closes the very incident the `fire()` opened. This
 *     is the format that makes the port's edge-triggered contract pay off.
 *   * `slack` — an incoming-webhook message. Slack has no notion of resolution, so a resolve posts
 *     a recovery message rather than editing anything.
 *   * `generic` — our own JSON, optionally HMAC-signed exactly as inbound requests are, for a
 *     receiver the operator writes themselves.
 *
 * Two properties matter more than the formatting, and both are about not making an outage worse:
 *
 *   1. Delivery is BOUNDED. Every attempt carries a timeout and the retry count is small, so a
 *      hanging pager API cannot stall the monitor loop that detected the problem.
 *   2. Delivery failure is REPORTED, not swallowed. This throws on final failure; `CompositeAlerter`
 *      catches it and logs, which keeps the log sink — composed alongside this one — as the
 *      backstop. An alert that cannot be paged must still be recorded somewhere.
 */
export type WebhookFormat = "generic" | "pagerduty" | "slack";

export interface WebhookAlerterOptions {
  readonly url: string;
  readonly format: WebhookFormat;
  /** Per-attempt timeout. */
  readonly timeoutMs: number;
  /** Attempts after the first, for retryable failures only. */
  readonly retries: number;
  /** Alerts below this severity are dropped. `warning` sends everything. */
  readonly minSeverity: AlertSeverity;
  /** PagerDuty Events API v2 routing key (integration key). Required for `pagerduty`. */
  readonly routingKey?: string | undefined;
  /** HMAC-SHA256 secret for the `generic` format; adds X-Signature / X-Timestamp over the body. */
  readonly signingSecret?: string | undefined;
  /** Identifies the sender in the alert payload (PagerDuty `source`, generic `source`). */
  readonly source?: string | undefined;
}

/** The slice of `fetch` used here, so tests drive delivery without a network or a global stub. */
export type FetchLike = (
  url: string,
  init: {method: string; headers: Record<string, string>; body: string; signal: AbortSignal},
) => Promise<{ok: boolean; status: number}>;

const SEVERITY_RANK: Record<AlertSeverity, number> = {warning: 1, critical: 2};

export class WebhookAlerter implements Alerter {
  readonly #options: WebhookAlerterOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  /**
   * Keys this alerter actually paged. A resolve for a key we never fired — because it was below
   * `minSeverity`, or because the process restarted — is dropped rather than sent, so a filtered
   * warning cannot close an unrelated incident and a restart cannot resolve someone else's page.
   */
  readonly #fired = new Set<string>();

  constructor(options: WebhookAlerterOptions, fetchImpl?: FetchLike, now: () => number = () => Date.now()) {
    if (options.format === "pagerduty" && (options.routingKey === undefined || options.routingKey === "")) {
      throw new Error("pagerduty webhook format requires a routing key");
    }
    this.#options = options;
    this.#fetch = fetchImpl ?? ((url, init) => fetch(url, init));
    this.#now = now;
  }

  async fire(alert: Alert): Promise<void> {
    if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[this.#options.minSeverity]) return;
    this.#fired.add(alert.key);
    await this.#post(this.#firePayload(alert));
  }

  async resolve(key: string): Promise<void> {
    if (!this.#fired.delete(key)) return;
    const payload = this.#resolvePayload(key);
    // Slack's generic format has nothing to resolve against; `#resolvePayload` returns undefined
    // for formats where a resolution is not meaningful.
    if (payload !== undefined) await this.#post(payload);
  }

  #firePayload(alert: Alert): unknown {
    const {format, source = "paymaster"} = this.#options;
    if (format === "pagerduty") {
      return {
        routing_key: this.#options.routingKey,
        event_action: "trigger",
        dedup_key: alert.key,
        payload: {
          summary: `${alert.title}: ${alert.detail}`,
          severity: alert.severity,
          source,
          // PagerDuty renders these on the incident, which is where an on-call engineer will look
          // first for the chain id they need.
          custom_details: {key: alert.key, ...alert.labels},
        },
      };
    }
    if (format === "slack") {
      const icon = alert.severity === "critical" ? ":rotating_light:" : ":warning:";
      const labels = alert.labels === undefined ? "" : `\n${JSON.stringify(alert.labels)}`;
      return {text: `${icon} *[${alert.severity}] ${alert.title}*\n${alert.detail}\n\`${alert.key}\`${labels}`};
    }
    return {
      event: "fire",
      key: alert.key,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      labels: alert.labels ?? {},
      source,
      timestamp: Math.floor(this.#now() / 1000),
    };
  }

  #resolvePayload(key: string): unknown {
    const {format, source = "paymaster"} = this.#options;
    if (format === "pagerduty") {
      return {routing_key: this.#options.routingKey, event_action: "resolve", dedup_key: key};
    }
    if (format === "slack") {
      return {text: `:white_check_mark: *resolved*\n\`${key}\``};
    }
    return {event: "resolve", key, source, timestamp: Math.floor(this.#now() / 1000)};
  }

  /**
   * Posts one payload, retrying only what is worth retrying.
   *
   * A 4xx other than 429 means the request itself is wrong — a bad routing key, a revoked webhook —
   * and repeating it just delays the log line that tells the operator their pager is misconfigured.
   * Network errors, timeouts, 429 and 5xx are transient and are retried with exponential backoff.
   */
  async #post(payload: unknown): Promise<void> {
    const body = JSON.stringify(payload);
    const attempts = this.#options.retries + 1;
    let lastError = "";

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await delay(2 ** (attempt - 1) * 250);
      try {
        const response = await this.#fetch(this.#options.url, {
          method: "POST",
          headers: this.#headers(body),
          body,
          signal: AbortSignal.timeout(this.#options.timeoutMs),
        });
        if (response.ok) return;
        if (!isRetryableStatus(response.status)) {
          throw new AlertDeliveryError(`alert webhook rejected the payload with HTTP ${response.status}`);
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        if (error instanceof AlertDeliveryError) throw error;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new AlertDeliveryError(`alert webhook delivery failed after ${attempts} attempt(s): ${lastError}`);
  }

  #headers(body: string): Record<string, string> {
    const headers: Record<string, string> = {"content-type": "application/json"};
    const secret = this.#options.signingSecret;
    if (secret !== undefined && this.#options.format === "generic") {
      // Same construction the inbound verifier uses (`timestamp\nMETHOD\npath\nbody`), so a receiver
      // can verify our alerts with the code it already has for our requests.
      const timestamp = String(Math.floor(this.#now() / 1000));
      const path = new URL(this.#options.url).pathname;
      const canonical = `${timestamp}\nPOST\n${path}\n${body}`;
      headers["x-timestamp"] = timestamp;
      headers["x-signature"] = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
    }
    return headers;
  }

  /** Keys this sink believes are currently paged. Exposed for tests and diagnostics. */
  get firingKeys(): readonly string[] {
    return [...this.#fired];
  }
}

export class AlertDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertDeliveryError";
  }
}

/** 408/429 and 5xx are transient; everything else in 4xx is a configuration error. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
