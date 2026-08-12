import type {DatabasePool} from "./pool.js";
import type {TenantId} from "./scope.js";

/**
 * What a tenant has paid for, and how it got that way.
 *
 * Like `TenantRepository`, this is not `Scope`-parameterised: a subscription is looked up BY tenant
 * id, and the caller has already established which tenant it may ask about. The platform-only
 * write path is guarded at the service, where the permission lives.
 */
export interface Subscription {
  readonly tenantId: TenantId;
  readonly plan: string;
  /** Unix seconds. The subscription is active while `now <= paidThrough`. */
  readonly paidThrough: number;
  /** Seconds of sponsorship allowed after `paidThrough`. */
  readonly graceSeconds: number;
}

export interface SubscriptionPayment {
  readonly id: string;
  readonly tenantId: TenantId;
  /** Wei, as a decimal string. Absent for a granted period — a trial or a credit. */
  readonly amountWei: string | undefined;
  readonly chainId: number | undefined;
  readonly txHash: string | undefined;
  readonly extendedFrom: number;
  readonly extendedTo: number;
  readonly recordedBy: string;
  readonly note: string | undefined;
  readonly recordedAt: number;
}

export interface RecordPaymentRequest {
  readonly tenantId: TenantId;
  readonly plan: string;
  /** How much time this payment buys. Added to whichever is later: now, or the current paid-through. */
  readonly periodSeconds: number;
  readonly amountWei?: string | undefined;
  readonly chainId?: number | undefined;
  readonly txHash?: string | undefined;
  readonly recordedBy: string;
  readonly note?: string | undefined;
  /** Unix seconds. Injected so extension arithmetic is testable without waiting. */
  readonly now: number;
}

/** Raised when the same on-chain transaction is offered as payment twice. */
export class DuplicatePaymentError extends Error {
  constructor(chainId: number, txHash: string) {
    super(`payment ${txHash} on chain ${chainId} has already been recorded`);
    this.name = "DuplicatePaymentError";
  }
}

export class SubscriptionRepository {
  constructor(private readonly pool: DatabasePool) {}

  async get(tenantId: TenantId): Promise<Subscription | undefined> {
    const {rows} = await this.pool.query<SubscriptionRow>(
      `SELECT tenant_id, plan, extract(epoch FROM paid_through)::bigint AS paid_through, grace_seconds
         FROM tenant_subscriptions
        WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = rows[0];
    return row === undefined ? undefined : toSubscription(row);
  }

  /**
   * Records a payment and extends the subscription, in one transaction.
   *
   * The extension is from `max(now, paid_through)`, not from `now`. Paying early must ADD to the
   * period rather than reset it — a customer who renews a week ahead of time would otherwise be
   * donating that week back, and would learn to renew late instead.
   *
   * The payment row and the new `paid_through` commit together. Split apart, a crash between them
   * leaves either a subscription extended with no record of why, or a customer who paid and did not
   * get their time.
   */
  async recordPayment(
    request: RecordPaymentRequest,
  ): Promise<{subscription: Subscription; payment: SubscriptionPayment}> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const {rows: existing} = await client.query<{paid_through: string}>(
        `SELECT extract(epoch FROM paid_through)::bigint AS paid_through
           FROM tenant_subscriptions
          WHERE tenant_id = $1
          FOR UPDATE`,
        [request.tenantId],
      );

      const currentPaidThrough = existing[0] === undefined ? 0 : Number(existing[0].paid_through);
      const extendedFrom = Math.max(request.now, currentPaidThrough);
      const extendedTo = extendedFrom + request.periodSeconds;

      let payment: SubscriptionPaymentRow;
      try {
        const {rows} = await client.query<SubscriptionPaymentRow>(
          `INSERT INTO subscription_payments
             (tenant_id, amount_wei, chain_id, tx_hash, extended_from, extended_to, recorded_by, note)
           VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), $7, $8)
           RETURNING id, tenant_id, amount_wei, chain_id, tx_hash,
                     extract(epoch FROM extended_from)::bigint AS extended_from,
                     extract(epoch FROM extended_to)::bigint AS extended_to,
                     recorded_by, note, extract(epoch FROM recorded_at)::bigint AS recorded_at`,
          [
            request.tenantId,
            request.amountWei ?? null,
            request.chainId ?? null,
            request.txHash ?? null,
            extendedFrom,
            extendedTo,
            request.recordedBy,
            request.note ?? null,
          ],
        );
        payment = rows[0]!;
      } catch (cause) {
        // The unique index on (chain_id, tx_hash) is what actually prevents double-crediting; this
        // turns it into an error the API can report rather than a 500.
        if (isUniqueViolation(cause) && request.chainId !== undefined && request.txHash !== undefined) {
          throw new DuplicatePaymentError(request.chainId, request.txHash);
        }
        throw cause;
      }

      const {rows: updated} = await client.query<SubscriptionRow>(
        `INSERT INTO tenant_subscriptions (tenant_id, plan, paid_through)
              VALUES ($1, $2, to_timestamp($3))
         ON CONFLICT (tenant_id) DO UPDATE
                SET plan = EXCLUDED.plan, paid_through = EXCLUDED.paid_through, updated_at = now()
           RETURNING tenant_id, plan, extract(epoch FROM paid_through)::bigint AS paid_through, grace_seconds`,
        [request.tenantId, request.plan, extendedTo],
      );

      await client.query("COMMIT");
      return {subscription: toSubscription(updated[0]!), payment: toPayment(payment)};
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async payments(tenantId: TenantId, limit = 50): Promise<readonly SubscriptionPayment[]> {
    const {rows} = await this.pool.query<SubscriptionPaymentRow>(
      `SELECT id, tenant_id, amount_wei, chain_id, tx_hash,
              extract(epoch FROM extended_from)::bigint AS extended_from,
              extract(epoch FROM extended_to)::bigint AS extended_to,
              recorded_by, note, extract(epoch FROM recorded_at)::bigint AS recorded_at
         FROM subscription_payments
        WHERE tenant_id = $1
        ORDER BY recorded_at DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map(toPayment);
  }

  /** Sets the grace window. Separate from payment because it is a policy change, not a purchase. */
  async setGraceSeconds(tenantId: TenantId, graceSeconds: number): Promise<void> {
    await this.pool.query(
      "UPDATE tenant_subscriptions SET grace_seconds = $2, updated_at = now() WHERE tenant_id = $1",
      [tenantId, graceSeconds],
    );
  }
}

interface SubscriptionRow {
  tenant_id: string;
  plan: string;
  paid_through: string;
  grace_seconds: number;
}

interface SubscriptionPaymentRow {
  id: string;
  tenant_id: string;
  amount_wei: string | null;
  chain_id: number | null;
  tx_hash: string | null;
  extended_from: string;
  extended_to: string;
  recorded_by: string;
  note: string | null;
  recorded_at: string;
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    tenantId: row.tenant_id as TenantId,
    plan: row.plan,
    paidThrough: Number(row.paid_through),
    graceSeconds: Number(row.grace_seconds),
  };
}

function toPayment(row: SubscriptionPaymentRow): SubscriptionPayment {
  return {
    id: String(row.id),
    tenantId: row.tenant_id as TenantId,
    amountWei: row.amount_wei ?? undefined,
    chainId: row.chain_id ?? undefined,
    txHash: row.tx_hash ?? undefined,
    extendedFrom: Number(row.extended_from),
    extendedTo: Number(row.extended_to),
    recordedBy: row.recorded_by,
    note: row.note ?? undefined,
    recordedAt: Number(row.recorded_at),
  };
}

function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as {code?: string}).code === "23505";
}
