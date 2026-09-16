import {createHmac} from "node:crypto";

import {Logger} from "@nestjs/common";

import type {TenantId} from "../db/scope.js";
import type {SubscriptionRepository} from "../db/subscriptionRepository.js";
import type {BackgroundService} from "../monitoring/backgroundService.js";
import {IntervalLoop} from "../monitoring/intervalLoop.js";

/** One notice, as a notifier receives it. */
export interface SubscriptionNotice {
  readonly kind: "renewal-due" | "grace";
  readonly tenantId: TenantId;
  readonly tenantName: string;
  readonly plan: string;
  /** Unix seconds. */
  readonly paidThrough: number;
  /** Unix seconds after which sponsorship stops. */
  readonly graceEndsAt: number;
}

/** Where notices go. A port, so email, a CRM or a queue is a composition-root change. */
export interface SubscriptionNotifier {
  notify(notice: SubscriptionNotice): Promise<void>;
}

/** Writes notices to the log. The default, and always composed so a failed webhook is still recorded. */
export class LoggingSubscriptionNotifier implements SubscriptionNotifier {
  readonly #logger = new Logger("subscription-notice");

  async notify(notice: SubscriptionNotice): Promise<void> {
    const when = new Date((notice.kind === "grace" ? notice.graceEndsAt : notice.paidThrough) * 1000).toISOString();
    this.#logger.log(
      notice.kind === "grace"
        ? `tenant ${notice.tenantId} (${notice.tenantName}) is in grace; sponsorship stops at ${when}`
        : `tenant ${notice.tenantId} (${notice.tenantName}) ${notice.plan} subscription ends at ${when}`,
    );
  }
}

export interface WebhookSubscriptionNotifierOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly signingSecret?: string | undefined;
}

/**
 * POSTs each notice as JSON to an endpoint the operator runs — typically the thing that emails the
 * account owner. Signed with the same `timestamp\nMETHOD\npath\nbody` HMAC the generic alert webhook
 * uses, so one verifier serves both.
 */
export class WebhookSubscriptionNotifier implements SubscriptionNotifier {
  readonly #options: WebhookSubscriptionNotifierOptions;
  readonly #fetch: typeof fetch;

  constructor(options: WebhookSubscriptionNotifierOptions, fetchImpl: typeof fetch = fetch) {
    this.#options = options;
    this.#fetch = fetchImpl;
  }

  async notify(notice: SubscriptionNotice): Promise<void> {
    const body = JSON.stringify({event: `subscription.${notice.kind}`, ...notice});
    const headers: Record<string, string> = {"content-type": "application/json"};
    if (this.#options.signingSecret !== undefined) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const path = new URL(this.#options.url).pathname;
      headers["x-timestamp"] = timestamp;
      headers["x-signature"] = createHmac("sha256", this.#options.signingSecret)
        .update(`${timestamp}\nPOST\n${path}\n${body}`, "utf8")
        .digest("hex");
    }

    const response = await this.#fetch(this.#options.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.#options.timeoutMs),
    });
    if (!response.ok) throw new Error(`subscription notice webhook answered HTTP ${response.status}`);
  }
}

/** Fans a notice out, isolating each sink: a failed webhook must not stop the log line. */
export class CompositeSubscriptionNotifier implements SubscriptionNotifier {
  readonly #sinks: readonly SubscriptionNotifier[];
  readonly #logger = new Logger("subscription-notice");

  constructor(sinks: readonly SubscriptionNotifier[]) {
    this.#sinks = sinks;
  }

  async notify(notice: SubscriptionNotice): Promise<void> {
    await Promise.all(
      this.#sinks.map(async (sink) => {
        try {
          await sink.notify(notice);
        } catch (error) {
          this.#logger.error(
            `notice for ${notice.tenantId} not delivered: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }
}

export interface SubscriptionNoticeOptions {
  readonly intervalMs: number;
  /** How long before paid-through the renewal notice goes out. */
  readonly noticeSeconds: number;
  readonly now?: () => number;
}

/**
 * Warns customers before their subscription lapses, and again when it enters grace.
 *
 * CLAIM, THEN SEND. Each notice is inserted into `subscription_notices` before it is delivered, and
 * delivered only by the replica whose insert succeeded. That makes it at-most-once across replicas
 * and restarts without a leader lock: two replicas sweeping at the same moment both find the tenant,
 * one wins the insert, the other skips it. The cost is that a delivery failure is not retried, which
 * is the right side to fail on for a message that goes to a customer's inbox — and the dashboard
 * banner carries the same information whether or not the notice arrived.
 */
export class SubscriptionNoticeService implements BackgroundService {
  readonly name = "subscription-notices";
  readonly #repository: SubscriptionRepository;
  readonly #notifier: SubscriptionNotifier;
  readonly #options: SubscriptionNoticeOptions;
  readonly #loop: IntervalLoop;

  constructor(repository: SubscriptionRepository, notifier: SubscriptionNotifier, options: SubscriptionNoticeOptions) {
    this.#repository = repository;
    this.#notifier = notifier;
    this.#options = options;
    this.#loop = new IntervalLoop(this.name, options.intervalMs, () => this.sweep().then(() => undefined));
  }

  start(): Promise<void> {
    return this.#loop.start();
  }

  stop(): void {
    this.#loop.stop();
  }

  /** One pass. Returns the notices this replica sent. */
  async sweep(): Promise<readonly SubscriptionNotice[]> {
    const now = this.#options.now?.() ?? Math.floor(Date.now() / 1000);
    const due = await this.#repository.dueForNotice(now, this.#options.noticeSeconds);
    const sent: SubscriptionNotice[] = [];

    for (const subscription of due) {
      if (!(await this.#repository.claimNotice(subscription.tenantId, subscription.paidThrough, subscription.kind))) {
        continue;
      }
      const notice: SubscriptionNotice = {
        kind: subscription.kind,
        tenantId: subscription.tenantId,
        tenantName: subscription.tenantName,
        plan: subscription.plan,
        paidThrough: subscription.paidThrough,
        graceEndsAt: subscription.paidThrough + subscription.graceSeconds,
      };
      await this.#notifier.notify(notice);
      sent.push(notice);
    }
    return sent;
  }
}
