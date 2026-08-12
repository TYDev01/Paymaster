import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";

import {SubscriptionService} from "../src/billing/subscription.js";
import {migrate} from "../src/db/migrate.js";
import {tenantId} from "../src/db/scope.js";
import {DuplicatePaymentError, SubscriptionRepository} from "../src/db/subscriptionRepository.js";
import {TenantRepository} from "../src/db/tenantRepository.js";
import {startPostgres, type TestPostgres} from "./support/postgres.js";

const ACME = tenantId("t_acme");
const DAY = 86_400;
const MONTH = 30 * DAY;

describe("subscriptions", () => {
  let pg: TestPostgres;
  let repo: SubscriptionRepository;
  let tenants: TenantRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    await migrate(pg.pool);
    repo = new SubscriptionRepository(pg.pool);
    tenants = new TenantRepository(pg.pool);
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.pool.query("DELETE FROM subscription_payments");
    await pg.pool.query("DELETE FROM tenant_subscriptions");
    await pg.pool.query("DELETE FROM tenant_members");
    await pg.pool.query("DELETE FROM tenants WHERE id <> 'default'");
    await tenants.createWithOwner({id: ACME, name: "Acme", subject: "did:privy:alice"});
  });

  const NOW = 1_800_000_000;

  function serviceAt(now: number, unsubscribedAllows = true) {
    return new SubscriptionService(repo, {now: () => now, unsubscribedAllows, ttlMs: 0});
  }

  describe("buying a period", () => {
    it("extends from now for a first payment", async () => {
      const {subscription} = await repo.recordPayment({
        tenantId: ACME,
        plan: "growth",
        periodSeconds: MONTH,
        recordedBy: "platform-key",
        now: NOW,
      });

      expect(subscription.paidThrough).toBe(NOW + MONTH);
      expect(subscription.plan).toBe("growth");
    });

    it("adds to the remaining period when paying early, rather than resetting it", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});

      // Renewing a week in. The remaining three weeks must survive: a customer who renews early and
      // loses the difference learns to renew late instead, which is the opposite of the behaviour
      // a prepaid model wants.
      const {subscription} = await repo.recordPayment({
        tenantId: ACME,
        plan: "growth",
        periodSeconds: MONTH,
        recordedBy: "k",
        now: NOW + 7 * DAY,
      });

      expect(subscription.paidThrough).toBe(NOW + 2 * MONTH);
    });

    it("extends from now, not from the past, when the subscription already lapsed", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});

      // Returning after two months away. Backdating would sell them a period that had already
      // elapsed — they would pay and get nothing.
      const returned = NOW + 2 * MONTH;
      const {subscription} = await repo.recordPayment({
        tenantId: ACME,
        plan: "growth",
        periodSeconds: MONTH,
        recordedBy: "k",
        now: returned,
      });

      expect(subscription.paidThrough).toBe(returned + MONTH);
    });

    it("records what bought the period", async () => {
      const {payment} = await repo.recordPayment({
        tenantId: ACME,
        plan: "growth",
        periodSeconds: MONTH,
        amountWei: "50000000000000000",
        chainId: 8453,
        txHash: `0x${"ab".repeat(32)}`,
        recordedBy: "platform-key",
        note: "invoice 2026-08",
        now: NOW,
      });

      expect(payment).toMatchObject({
        amountWei: "50000000000000000",
        chainId: 8453,
        extendedFrom: NOW,
        extendedTo: NOW + MONTH,
        recordedBy: "platform-key",
        note: "invoice 2026-08",
      });
    });

    it("refuses to credit the same transaction twice", async () => {
      const txHash = `0x${"cd".repeat(32)}`;
      const payment = {
        tenantId: ACME,
        plan: "growth",
        periodSeconds: MONTH,
        chainId: 8453,
        txHash,
        recordedBy: "k",
      };

      await repo.recordPayment({...payment, now: NOW});
      // A retried admin call, a double-click, or a reconciler re-reading a block. Any of them would
      // otherwise buy a second period with one payment.
      await expect(repo.recordPayment({...payment, now: NOW})).rejects.toThrow(DuplicatePaymentError);

      const {rows} = await pg.pool.query<{paid_through: string}>(
        "SELECT extract(epoch FROM paid_through)::bigint AS paid_through FROM tenant_subscriptions WHERE tenant_id = $1",
        [ACME],
      );
      expect(Number(rows[0]!.paid_through), "the rejected payment must not have extended anything").toBe(NOW + MONTH);
    });

    it("allows many granted periods with no transaction behind them", async () => {
      // A trial, a credit, a goodwill extension. The unique index is partial for exactly this.
      await repo.recordPayment({tenantId: ACME, plan: "trial", periodSeconds: DAY, recordedBy: "k", now: NOW});
      await repo.recordPayment({tenantId: ACME, plan: "trial", periodSeconds: DAY, recordedBy: "k", now: NOW});
      expect(await repo.payments(ACME)).toHaveLength(2);
    });

    it("leaves nothing behind when the payment is rejected", async () => {
      const txHash = `0x${"ef".repeat(32)}`;
      await repo.recordPayment({
        tenantId: ACME,
        plan: "growth",
        periodSeconds: MONTH,
        chainId: 8453,
        txHash,
        recordedBy: "k",
        now: NOW,
      });

      await expect(
        repo.recordPayment({
          tenantId: ACME,
          plan: "growth",
          periodSeconds: MONTH,
          chainId: 8453,
          txHash,
          recordedBy: "k",
          now: NOW,
        }),
      ).rejects.toThrow();

      // The payment row and the paid-through move together or not at all.
      expect(await repo.payments(ACME)).toHaveLength(1);
    });
  });

  describe("state", () => {
    it("is active inside the paid period", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});
      const status = await serviceAt(NOW + DAY).statusOf(ACME);

      expect(status.state).toBe("active");
      expect(status.allowsSponsorship).toBe(true);
    });

    it("enters grace at the end of the period, and still sponsors", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});

      // A grace window that stopped traffic would be a lapse with a friendlier name. The whole
      // point is that a customer a day late does not have their production stop.
      const status = await serviceAt(NOW + MONTH + DAY).statusOf(ACME);
      expect(status.state).toBe("grace");
      expect(status.allowsSponsorship).toBe(true);
    });

    it("lapses once the grace window closes", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});

      const status = await serviceAt(NOW + MONTH + 4 * DAY).statusOf(ACME);
      expect(status.state).toBe("lapsed");
      expect(status.allowsSponsorship).toBe(false);
      expect(status.graceEndsAt).toBe(NOW + MONTH + 3 * DAY);
    });

    it("allows a tenant with no subscription by default", async () => {
      // Every tenant that predates this table has no row. Defaulting the other way would take a
      // working deployment offline the moment it upgraded.
      const status = await serviceAt(NOW).statusOf(ACME);
      expect(status.state).toBe("none");
      expect(status.allowsSponsorship).toBe(true);
    });

    it("refuses a tenant with no subscription when the deployment sells them", async () => {
      const status = await serviceAt(NOW, false).statusOf(ACME);
      expect(status.state).toBe("none");
      expect(status.allowsSponsorship).toBe(false);
    });

    it("restores service immediately when a lapsed tenant pays", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});
      const lapsed = NOW + MONTH + 4 * DAY;

      // A cache with a live TTL, to prove the invalidation matters rather than the TTL being zero.
      const service = new SubscriptionService(repo, {now: () => lapsed, ttlMs: 60_000});
      expect((await service.statusOf(ACME)).allowsSponsorship).toBe(false);

      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: lapsed});
      service.invalidate(ACME);

      // Being slow to notice a payment is the one direction of staleness that is unacceptable: the
      // customer has paid and is watching their traffic still fail.
      expect((await service.statusOf(ACME)).allowsSponsorship).toBe(true);
    });

    it("lets the clock decide, not the cache", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});

      // The cache holds the SUBSCRIPTION and re-derives the state, so a long TTL cannot keep a
      // tenant "active" past the moment their grace window actually closed.
      let clock = NOW + DAY;
      const service = new SubscriptionService(repo, {now: () => clock, ttlMs: 3_600_000});
      expect((await service.statusOf(ACME)).state).toBe("active");

      clock = NOW + MONTH + 4 * DAY;
      expect((await service.statusOf(ACME)).state).toBe("lapsed");
    });
  });

  describe("what lapsing must NOT do", () => {
    it("does not suspend the tenant, so the customer can still sign in and pay", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});
      const lapsed = NOW + MONTH + 30 * DAY;

      expect((await serviceAt(lapsed).statusOf(ACME)).state).toBe("lapsed");

      // `TenantSessionService.issue` refuses a session for a suspended tenant. Had lapsing been
      // modelled as `status = 'suspended'` — which migration 0004 suggested — the customer would be
      // locked out of the dashboard where they would go to pay, and support would be the only way
      // back. The tenant stays ACTIVE; only sponsorship stops.
      const tenant = await tenants.get(ACME);
      expect(tenant?.status).toBe("active");
    });

    it("keeps the payment history readable while lapsed", async () => {
      await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: MONTH, recordedBy: "k", now: NOW});

      // What they owe and what they paid is exactly what a lapsed customer needs to see.
      expect(await repo.payments(ACME)).toHaveLength(1);
    });
  });
});
