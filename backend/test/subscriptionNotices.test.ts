import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";

import {SubscriptionService} from "../src/billing/subscription.js";
import {
  SubscriptionNoticeService,
  type SubscriptionNotice,
  type SubscriptionNotifier,
} from "../src/billing/subscriptionNotices.js";
import {migrate} from "../src/db/migrate.js";
import {tenantId} from "../src/db/scope.js";
import {SubscriptionRepository} from "../src/db/subscriptionRepository.js";
import {TenantRepository} from "../src/db/tenantRepository.js";
import {startPostgres, type TestPostgres} from "./support/postgres.js";

const ACME = tenantId("t_acme");
const DAY = 86_400;
const NOW = 1_800_000_000;
const NOTICE = 7 * DAY;

class Recorder implements SubscriptionNotifier {
  readonly sent: SubscriptionNotice[] = [];
  async notify(notice: SubscriptionNotice): Promise<void> {
    this.sent.push(notice);
  }
}

describe("subscription notices", () => {
  let pg: TestPostgres;
  let repo: SubscriptionRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    await migrate(pg.pool);
    repo = new SubscriptionRepository(pg.pool);
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.pool.query("DELETE FROM subscription_notices");
    await pg.pool.query("DELETE FROM subscription_payments");
    await pg.pool.query("DELETE FROM tenant_subscriptions");
    await pg.pool.query("DELETE FROM tenant_members");
    await pg.pool.query("DELETE FROM tenants WHERE id <> 'default'");
    await new TenantRepository(pg.pool).createWithOwner({id: ACME, name: "Acme", subject: "did:privy:alice"});
  });

  /** A subscription whose paid period ends `endsIn` seconds from NOW. */
  async function subscriptionEnding(endsIn: number) {
    await repo.recordPayment({
      tenantId: ACME,
      plan: "growth",
      periodSeconds: 30 * DAY,
      recordedBy: "k",
      now: NOW + endsIn - 30 * DAY,
    });
  }

  function sweeper(recorder: Recorder, now = NOW) {
    return new SubscriptionNoticeService(repo, recorder, {intervalMs: 60_000, noticeSeconds: NOTICE, now: () => now});
  }

  it("sends a renewal notice once a period is inside the notice window, and only once", async () => {
    await subscriptionEnding(3 * DAY);
    const recorder = new Recorder();

    expect(await sweeper(recorder).sweep()).toHaveLength(1);
    expect(recorder.sent[0]).toMatchObject({kind: "renewal-due", tenantId: ACME, tenantName: "Acme", plan: "growth"});

    // A second sweep, or a second replica, finds nothing new to send.
    expect(await sweeper(recorder).sweep()).toHaveLength(0);
    expect(recorder.sent).toHaveLength(1);
  });

  it("sends nothing while the period is comfortably paid", async () => {
    await subscriptionEnding(20 * DAY);
    expect(await sweeper(new Recorder()).sweep()).toHaveLength(0);
  });

  it("sends a separate notice when the subscription enters grace", async () => {
    await subscriptionEnding(3 * DAY);
    const recorder = new Recorder();
    await sweeper(recorder).sweep();

    await sweeper(recorder, NOW + 4 * DAY).sweep();
    expect(recorder.sent.map((n) => n.kind)).toEqual(["renewal-due", "grace"]);
  });

  it("stops once the grace window has passed — sponsorship has already stopped by then", async () => {
    await subscriptionEnding(-10 * DAY);
    expect(await sweeper(new Recorder()).sweep()).toHaveLength(0);
  });

  it("starts over for the next period once the customer renews", async () => {
    await subscriptionEnding(3 * DAY);
    const recorder = new Recorder();
    await sweeper(recorder).sweep();

    // Renewal moves paid_through, which is part of the notice's identity.
    await repo.recordPayment({tenantId: ACME, plan: "growth", periodSeconds: 30 * DAY, recordedBy: "k", now: NOW});
    await sweeper(recorder, NOW + 28 * DAY).sweep();
    expect(recorder.sent).toHaveLength(2);
    expect(recorder.sent[1]!.paidThrough).toBe(NOW + 33 * DAY);
  });

  it("marks the same window as due on the dashboard", async () => {
    await subscriptionEnding(3 * DAY);
    const status = await new SubscriptionService(repo, {now: () => NOW, ttlMs: 0, noticeSeconds: NOTICE}).statusOf(
      ACME,
    );
    expect(status).toMatchObject({state: "active", renewalDue: true});

    const later = await new SubscriptionService(repo, {
      now: () => NOW - 10 * DAY,
      ttlMs: 0,
      noticeSeconds: NOTICE,
    }).statusOf(ACME);
    expect(later.renewalDue).toBe(false);
  });
});
