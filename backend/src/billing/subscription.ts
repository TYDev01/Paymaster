import type {TenantId} from "../db/scope.js";
import type {Subscription, SubscriptionRepository} from "../db/subscriptionRepository.js";

/**
 * Where a subscription stands right now.
 *
 * Derived from `paidThrough` and the clock rather than stored. A stored state has to be moved by
 * something — a sweep, a cron, a job that failed last night — and a customer whose subscription
 * says "active" because the sweep did not run is being given service they did not buy, while one
 * that says "lapsed" because the sweep ran early is being refused service they did. Neither is
 * recoverable by looking at the row, because the row is the thing that is wrong.
 */
export type SubscriptionState =
  /** Paid up. */
  | "active"
  /** Past `paidThrough`, inside the grace window. Sponsorship continues; the dashboard should nag. */
  | "grace"
  /** Past the grace window. Sponsorship is refused. */
  | "lapsed"
  /** No subscription row at all. See `unsubscribedAllows` for why this is not simply "lapsed". */
  | "none";

export interface SubscriptionStatus {
  readonly state: SubscriptionState;
  readonly plan: string | undefined;
  /** Unix seconds. Absent when there is no subscription. */
  readonly paidThrough: number | undefined;
  /** Unix seconds after which sponsorship stops. Absent when there is no subscription. */
  readonly graceEndsAt: number | undefined;
  /** True when sponsorship is permitted. The single question the sponsorship path asks. */
  readonly allowsSponsorship: boolean;
}

export interface SubscriptionServiceOptions {
  /**
   * What to do for a tenant with no subscription row.
   *
   * Defaults to ALLOWING sponsorship, which is the only safe default for an existing deployment:
   * every tenant that predates this table has no row, and defaulting to "lapsed" would take a
   * working single-tenant paymaster offline the moment it was upgraded. A deployment that sells
   * subscriptions sets this to false and creates rows as customers sign up.
   */
  readonly unsubscribedAllows?: boolean;
  /** Unix seconds. Injected so state transitions are testable without waiting. */
  readonly now?: () => number;
  /** How long a status may be reused, in milliseconds. See the note on caching below. */
  readonly ttlMs?: number;
}

interface CacheEntry {
  readonly subscription: Subscription | undefined;
  readonly readAt: number;
}

const DEFAULT_TTL_MS = 10_000;

/**
 * Answers "may this tenant be sponsored" without asking the database on every request.
 *
 * The cache holds the SUBSCRIPTION, not the state. Caching the state would mean a tenant stays
 * "active" for the whole TTL after their grace window closes — the cache would be deciding when
 * the subscription ends. Caching the row and re-deriving means the clock always decides, and the
 * only thing the TTL delays is noticing a PAYMENT, which errs towards refusing someone who has
 * just paid rather than serving someone who has not.
 *
 * That direction is wrong for a customer who has just paid and wants their traffic back, so
 * `invalidate` is called when a payment is recorded.
 *
 * `invalidate` is PROCESS-LOCAL, which matters on more than one replica: a payment recorded on one
 * replica leaves the others refusing that tenant until their own entry expires. The TTL is the
 * bound on that, and it is short for this reason. The policy set solves the same problem properly
 * with a Redis broadcast (`policyBroadcast.ts`), and this would use it too if the window were
 * longer — at ten seconds the added moving part costs more than it saves.
 */
export class SubscriptionService {
  readonly #repository: SubscriptionRepository;
  readonly #unsubscribedAllows: boolean;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(repository: SubscriptionRepository, options: SubscriptionServiceOptions = {}) {
    this.#repository = repository;
    this.#unsubscribedAllows = options.unsubscribedAllows ?? true;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async statusOf(tenantId: TenantId): Promise<SubscriptionStatus> {
    const subscription = await this.#load(tenantId);
    return this.describe(subscription);
  }

  /** The pure part: a subscription and a clock in, a state out. Separated so it can be tested alone. */
  describe(subscription: Subscription | undefined): SubscriptionStatus {
    if (subscription === undefined) {
      return {
        state: "none",
        plan: undefined,
        paidThrough: undefined,
        graceEndsAt: undefined,
        allowsSponsorship: this.#unsubscribedAllows,
      };
    }

    const now = this.#now();
    const graceEndsAt = subscription.paidThrough + subscription.graceSeconds;
    const state: SubscriptionState =
      now <= subscription.paidThrough ? "active" : now <= graceEndsAt ? "grace" : "lapsed";

    return {
      state,
      plan: subscription.plan,
      paidThrough: subscription.paidThrough,
      graceEndsAt,
      // Grace allows: that is what a grace window IS. A window that stopped traffic would be a
      // lapse with a friendlier name.
      allowsSponsorship: state !== "lapsed",
    };
  }

  invalidate(tenantId: TenantId): void {
    this.#cache.delete(tenantId);
  }

  async #load(tenantId: TenantId): Promise<Subscription | undefined> {
    const cached = this.#cache.get(tenantId);
    const nowMs = Date.now();
    if (cached !== undefined && nowMs - cached.readAt < this.#ttlMs) return cached.subscription;

    const subscription = await this.#repository.get(tenantId);
    this.#cache.set(tenantId, {subscription, readAt: nowMs});
    return subscription;
  }
}
