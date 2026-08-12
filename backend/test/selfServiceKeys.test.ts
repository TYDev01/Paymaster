import "reflect-metadata";

import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {NestFactory} from "@nestjs/core";
import {FastifyAdapter, type NestFastifyApplication} from "@nestjs/platform-fastify";

import {AppModule, type AppDependencies} from "../src/api/app.module.js";
import {DomainErrorFilter} from "../src/api/filters/domainError.filter.js";
import {hashApiKey} from "../src/auth/apiKey.js";
import type {IdentityProvider, IdentityResult} from "../src/auth/identity.js";
import {JwtService} from "../src/auth/jwt.js";
import {TenantSessionService} from "../src/auth/tenantSession.js";
import {CANONICAL_ENTRYPOINT_V07} from "../src/chain/chainConfig.js";
import {ChainRegistry} from "../src/chain/chainRegistry.js";
import {TenantBalanceReader} from "../src/chain/tenantBalance.js";
import {onChainTenantKey} from "../src/signature/paymasterLayout.js";
import {migrate} from "../src/db/migrate.js";
import {PostgresApiKeyStore} from "../src/db/postgresApiKeyStore.js";
import {PostgresPolicyRepository} from "../src/db/postgresPolicyRepository.js";
import {AuditLogRepository} from "../src/db/auditLogRepository.js";
import {SubscriptionRepository} from "../src/db/subscriptionRepository.js";
import {TenantRepository} from "../src/db/tenantRepository.js";
import {tenantId} from "../src/db/scope.js";
import {PolicyFactory} from "../src/policy/policyFactory.js";
import {PolicySource} from "../src/policy/policySource.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import {startPostgres, type TestPostgres} from "./support/postgres.js";
import {testEnv} from "./support/env.js";

/**
 * Self-service key issuance, over HTTP, through the real guard and filter.
 *
 * The mechanics were already in place after the tenant boundary landed — a tenant-scoped session
 * carries `admin`, and the admin path derives its scope from the principal. What this file proves is
 * that the mechanics compose into the property that matters: **a customer can mint keys inside their
 * own account and cannot reach anyone else's, or grant themselves more than they hold.**
 *
 * Driven through `app.inject` rather than by calling the service, because the interesting parts
 * are the guard, the scope derivation and the error mapping — none of which a direct service call
 * exercises.
 */
const ALICE = "did:privy:alice";
const BOB = "did:privy:bob";
const SIGNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("self-service key issuance", () => {
  let pg: TestPostgres;
  let app: NestFastifyApplication;
  let tenants: TenantRepository;
  let sessions: TenantSessionService;
  let subject = ALICE;

  const jwt = new JwtService("s".repeat(32), {
    issuer: "paymaster",
    audience: "paymaster-admin",
    ttlSeconds: 900,
  });

  // The person the stub provider will vouch for. Swapping it is how a test "signs in as" someone.
  const identity: IdentityProvider = {
    verify: async (): Promise<IdentityResult> => ({
      ok: true,
      identity: {subject, email: undefined, expiresAt: 2_000_000_000},
    }),
  };

  beforeAll(async () => {
    pg = await startPostgres();
    await migrate(pg.pool);
    tenants = new TenantRepository(pg.pool);
    sessions = new TenantSessionService(identity, tenants, jwt, {allowSelfSignup: true});

    const policySource = new PolicySource(
      new PostgresPolicyRepository(pg.pool, new PolicyFactory(new InMemoryQuotaStore())),
    );
    await policySource.reload();

    // Two chains, so the funding view has something to include and something to leave out.
    const chains = ChainRegistry.fromConfigs([
      {
        chainId: 8453,
        name: "Base",
        rpcUrls: ["https://base.example.com"],
        entryPoint: CANONICAL_ENTRYPOINT_V07,
        paymaster: "0x1111111111111111111111111111111111111111",
        paymasterKind: "tenant",
        explorerUrl: "https://basescan.org",
        nativeCurrency: {symbol: "ETH", decimals: 18},
        minDepositWei: 0n,
        minStakeWei: 0n,
        enabled: true,
      },
      {
        chainId: 10,
        name: "Optimism",
        rpcUrls: ["https://optimism.example.com"],
        entryPoint: CANONICAL_ENTRYPOINT_V07,
        paymaster: "0x2222222222222222222222222222222222222222",
        paymasterKind: "verifying",
        explorerUrl: "https://optimistic.etherscan.io",
        nativeCurrency: {symbol: "ETH", decimals: 18},
        minDepositWei: 0n,
        minStakeWei: 0n,
        enabled: true,
      },
    ]);

    // Stands in for the RPC. What is under test here is the scoping and shape of the view, not the
    // call — `tenantDifferential.test.ts` asserts the read itself against real bytecode.
    const balanceRegistry = {
      get: () => ({
        config: {chainId: 8453, paymasterKind: "tenant" as const},
        getTenantBalance: async () => 4_200_000_000_000_000_000n,
      }),
    } as unknown as ChainRegistry;

    const deps: AppDependencies = {
      chains,
      tenantBalances: new TenantBalanceReader(balanceRegistry, {ttlMs: 0}),
      policies: policySource,
      signer: new LocalSponsorshipSigner(SIGNER_KEY),
      apiKeys: new PostgresApiKeyStore(pg.pool),
      policyRepository: new PostgresPolicyRepository(pg.pool, new PolicyFactory(new InMemoryQuotaStore())),
      audit: new AuditLogRepository(pg.pool),
      subscriptions: new SubscriptionRepository(pg.pool),
      quotasAreLocal: true,
      jwt,
      tenantSessions: sessions,
      env: testEnv(),
    };

    app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(deps), new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    subject = ALICE;
    await pg.pool.query("DELETE FROM subscription_payments");
    await pg.pool.query("DELETE FROM tenant_subscriptions");
    await pg.pool.query("DELETE FROM audit_logs");
    await pg.pool.query("DELETE FROM api_keys");
    await pg.pool.query("DELETE FROM tenant_members");
    await pg.pool.query("DELETE FROM tenants WHERE id <> 'default'");
  });

  /** Signs in as `who` and returns the bearer token for their (only) tenant. */
  async function signIn(who: string, tenant: string): Promise<string> {
    subject = who;
    const result = await sessions.issue("provider-token", tenant);
    if (!result.ok) throw new Error(`could not sign in: ${result.reason}`);
    return result.token;
  }

  const post = (url: string, token: string, payload: unknown) =>
    app.inject({method: "POST", url, payload: payload as object, headers: {authorization: `Bearer ${token}`}});

  const get = (url: string, token: string) =>
    app.inject({method: "GET", url, headers: {authorization: `Bearer ${token}`}});

  it("lets a customer mint a key inside their own account", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    const token = await signIn(ALICE, "t_acme");

    const response = await post("/admin/keys", token, {
      name: "acme production",
      environment: "live",
      roles: ["sponsor"],
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {secret: string; id: string};
    // The secret is returned here and nowhere else, ever.
    expect(body.secret).toMatch(/^pm_live_/);

    // Stored against THEIR tenant, and only the hash is stored.
    const {rows} = await pg.pool.query<{tenant_id: string; key_hash: string}>(
      "SELECT tenant_id, key_hash FROM api_keys WHERE id = $1",
      [body.id],
    );
    expect(rows[0]?.tenant_id).toBe("t_acme");
    expect(rows[0]?.key_hash).toBe(hashApiKey(body.secret));
  });

  it("shows a customer only their own keys", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    await tenants.createWithOwner({id: tenantId("t_rival"), name: "Rival", subject: BOB});

    const acme = await signIn(ALICE, "t_acme");
    const rival = await signIn(BOB, "t_rival");

    await post("/admin/keys", acme, {name: "acme key", environment: "live", roles: ["sponsor"]});
    await post("/admin/keys", rival, {name: "rival key", environment: "live", roles: ["sponsor"]});

    const listed = JSON.parse((await get("/admin/keys", acme)).body) as {keys: {name: string}[]};
    expect(listed.keys.map((k) => k.name)).toEqual(["acme key"]);
  });

  it("cannot revoke another customer's key", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    await tenants.createWithOwner({id: tenantId("t_rival"), name: "Rival", subject: BOB});

    const rival = await signIn(BOB, "t_rival");
    const created = JSON.parse(
      (await post("/admin/keys", rival, {name: "rival key", environment: "live", roles: ["sponsor"]})).body,
    ) as {id: string};

    const acme = await signIn(ALICE, "t_acme");
    const response = await app.inject({
      method: "DELETE",
      url: `/admin/keys/${created.id}`,
      headers: {authorization: `Bearer ${acme}`},
    });

    // 404, not 403: distinguishing them would confirm the key id exists.
    expect(response.statusCode).toBe(404);

    const {rows} = await pg.pool.query<{enabled: boolean}>("SELECT enabled FROM api_keys WHERE id = $1", [created.id]);
    expect(rows[0]?.enabled, "the rival's key must still work").toBe(true);
  });

  it("refuses to grant a role the caller does not hold", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    const token = await signIn(ALICE, "t_acme");

    // A tenant owner is an `admin` WITHIN their tenant. Minting a `platform` key would hand
    // themselves reads across every other customer — the single most valuable escalation available,
    // and the reason the platform role is safe to have at all.
    const response = await post("/admin/keys", token, {
      name: "escalation attempt",
      environment: "live",
      roles: ["platform"],
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({error: "ROLE_ESCALATION"});
    // And nothing was written.
    const {rows} = await pg.pool.query("SELECT 1 FROM api_keys WHERE name = 'escalation attempt'");
    expect(rows).toHaveLength(0);
  });

  it("allows delegating the caller's own role", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    const token = await signIn(ALICE, "t_acme");

    // The rule is "you cannot give away what you do not have", not "you may only grant less than
    // yourself" — an owner issuing a second administrative credential is ordinary and must work.
    expect(
      (await post("/admin/keys", token, {name: "colleague", environment: "live", roles: ["tenant_admin"]})).statusCode,
    ).toBe(201);

    // ...but not the operator's `admin`, which additionally carries `chain:write` — configuring
    // which chains the PLATFORM serves is not a customer's decision to delegate.
    const escalation = await post("/admin/keys", token, {name: "too much", environment: "live", roles: ["admin"]});
    expect(escalation.statusCode).toBe(403);
    expect(JSON.parse(escalation.body).message).toContain("chain:write");
  });

  it("lets a customer mint a key that CAN spend, though the session cannot", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    const token = await signIn(ALICE, "t_acme");

    // The one delegated capability: issuing a spending credential is the entire product, so
    // `sponsor:create` may be granted by someone who does not hold it. Nothing else may be.
    const response = await post("/admin/keys", token, {
      name: "server key",
      environment: "live",
      roles: ["sponsor"],
    });
    expect(response.statusCode, response.body).toBe(201);
  });

  it("does not let a dashboard session spend, whatever its tenant role", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    const token = await signIn(ALICE, "t_acme");

    const response = await post("/paymaster/sponsor", token, {
      chainId: 1,
      userOperation: {
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x0",
        callData: "0x",
        callGasLimit: "0x30d40",
        verificationGasLimit: "0x7a120",
        preVerificationGas: "0x186a0",
        maxFeePerGas: "0x4a817c800",
        maxPriorityFeePerGas: "0x3b9aca00",
      },
    });

    // 403 from the permission check. The session can MINT a key that spends — that is the product —
    // but it cannot spend itself, so a stolen tab has to leave an audit entry naming a revocable
    // credential before it can touch the balance.
    expect(response.statusCode).toBe(403);
  });

  it("records the tenant on the audit entry", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    const token = await signIn(ALICE, "t_acme");
    await post("/admin/keys", token, {name: "audited", environment: "live", roles: ["sponsor"]});

    const {rows} = await pg.pool.query<{tenant_id: string; actor: string}>(
      "SELECT tenant_id, actor FROM audit_logs WHERE action = 'key.create'",
    );
    expect(rows[0]?.tenant_id).toBe("t_acme");
    // The actor is the PERSON, not a credential they do not have.
    expect(rows[0]?.actor).toBe(ALICE);
  });

  describe("the platform operator", () => {
    /** Seeds a platform key directly, which is the only way one can come into existence. */
    async function platformKey(): Promise<string> {
      const secret = `pm_test_${"p".repeat(44)}`;
      await pg.pool.query(
        `INSERT INTO api_keys (tenant_id, id, name, key_hash, display_prefix, roles)
         VALUES ('default', 'platform-1', 'operator', $1, 'pm_test_pppp', ARRAY['platform'])`,
        [hashApiKey(secret)],
      );
      return secret;
    }

    it("reads across every tenant", async () => {
      await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
      await tenants.createWithOwner({id: tenantId("t_rival"), name: "Rival", subject: BOB});

      await post("/admin/keys", await signIn(ALICE, "t_acme"), {
        name: "acme key",
        environment: "live",
        roles: ["sponsor"],
      });
      await post("/admin/keys", await signIn(BOB, "t_rival"), {
        name: "rival key",
        environment: "live",
        roles: ["sponsor"],
      });

      const listed = JSON.parse((await get("/admin/keys", await platformKey())).body) as {keys: {name: string}[]};
      // The operator console's view. Without this, adding tenancy would have silently blinded the
      // operator to every customer but the default one.
      expect(listed.keys.map((k) => k.name).sort()).toEqual(["acme key", "operator", "rival key"]);
    });

    it("writes into its own tenant, not across the platform", async () => {
      const secret = await platformKey();

      const response = await post("/admin/keys", secret, {
        name: "operator-made",
        environment: "live",
        roles: ["sponsor"],
      });
      expect(response.statusCode, response.body).toBe(201);

      const {rows} = await pg.pool.query<{tenant_id: string}>(
        "SELECT tenant_id FROM api_keys WHERE name = 'operator-made'",
      );
      // Seeing every customer is a support requirement; editing their account from the same
      // credential is not, so writes stay bound to the operator's own tenant.
      expect(rows[0]?.tenant_id).toBe("default");
    });
  });

  describe("funding", () => {
    it("tells a customer where to send money, and what they have", async () => {
      await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
      const token = await signIn(ALICE, "t_acme");

      const response = await get("/admin/funding", token);
      expect(response.statusCode, response.body).toBe(200);
      const {funding} = JSON.parse(response.body) as {
        funding: {chainId: number; tenantKey: string; balanceWei: string}[];
      };

      // Only the chain that HAS per-tenant balances. Listing the single-tenant chain with a zero
      // would read as "you are out of money" rather than "this does not apply to you".
      expect(funding.map((f) => f.chainId)).toEqual([8453]);
      expect(funding[0]!.balanceWei).toBe("4200000000000000000");

      // The whole reason this endpoint exists: `depositFor` takes this, and a customer cannot
      // derive it from anything else the dashboard shows them.
      expect(funding[0]!.tenantKey).toBe(onChainTenantKey(tenantId("t_acme")));
    });

    it("gives each tenant their own key, so one cannot fund into another's balance", async () => {
      await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
      await tenants.createWithOwner({id: tenantId("t_rival"), name: "Rival", subject: BOB});

      const acme = JSON.parse((await get("/admin/funding", await signIn(ALICE, "t_acme"))).body) as {
        funding: {tenantKey: string}[];
      };
      const rival = JSON.parse((await get("/admin/funding", await signIn(BOB, "t_rival"))).body) as {
        funding: {tenantKey: string}[];
      };

      expect(acme.funding[0]!.tenantKey).not.toBe(rival.funding[0]!.tenantKey);
    });

    it("shows a platform operator their OWN funding key, not a customer's", async () => {
      await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
      const secret = `pm_test_${"q".repeat(44)}`;
      await pg.pool.query(
        `INSERT INTO api_keys (tenant_id, id, name, key_hash, display_prefix, roles)
         VALUES ('default', 'platform-funding', 'operator', $1, 'pm_test_qqqq', ARRAY['platform'])`,
        [hashApiKey(secret)],
      );

      const response = await get("/admin/funding", secret);
      expect(response.statusCode, response.body).toBe(200);
      const {funding} = JSON.parse(response.body) as {funding: {tenantKey: string}[]};

      // `platform:read` widens reads across tenants everywhere else. Not here: a funding key is an
      // instruction to send money, and showing an operator a customer's key under the heading
      // "fund your account" is how money lands in the wrong balance.
      expect(funding[0]!.tenantKey).toBe(onChainTenantKey(tenantId("default")));
      expect(funding[0]!.tenantKey).not.toBe(onChainTenantKey(tenantId("t_acme")));
    });
  });

  describe("billing", () => {
    /** Seeds a platform key. `billing:write` is only reachable this way, never through the API. */
    async function platformBillingKey(): Promise<string> {
      const secret = `pm_test_${"b".repeat(44)}`;
      await pg.pool.query(
        `INSERT INTO api_keys (tenant_id, id, name, key_hash, display_prefix, roles)
         VALUES ('default', 'platform-billing', 'operator', $1, 'pm_test_bbbb', ARRAY['platform'])`,
        [hashApiKey(secret)],
      );
      return secret;
    }

    it("reports no subscription rather than inventing one", async () => {
      await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
      const token = await signIn(ALICE, "t_acme");

      const response = await get("/admin/subscription", token);
      expect(response.statusCode, response.body).toBe(200);
      const body = JSON.parse(response.body) as {status: {state: string}; payments: unknown[]};
      expect(body.status.state).toBe("none");
      expect(body.payments).toEqual([]);
    });

    it("refuses a customer trying to extend their own subscription", async () => {
      await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
      const token = await signIn(ALICE, "t_acme");

      // The one write that crosses the tenant boundary, and therefore the one a customer must not
      // reach. A tenant who could extend their own subscription would not need to buy one.
      const response = await post("/admin/subscriptions/payments", token, {
        tenantId: "t_acme",
        plan: "growth",
        periodSeconds: 2_592_000,
      });
      expect(response.statusCode).toBe(403);
    });

    it("lets the platform record a payment for a customer", async () => {
      await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
      const secret = await platformBillingKey();

      const response = await post("/admin/subscriptions/payments", secret, {
        tenantId: "t_acme",
        plan: "growth",
        periodSeconds: 2_592_000,
        amountWei: "50000000000000000",
        chainId: 8453,
        txHash: `0x${"a1".repeat(32)}`,
      });
      expect(response.statusCode, response.body).toBe(201);

      // And the customer sees it on their own page, recorded against THEIR tenant.
      const view = JSON.parse((await get("/admin/subscription", await signIn(ALICE, "t_acme"))).body) as {
        status: {state: string; plan: string};
        payments: {amountWei: string}[];
      };
      expect(view.status.state).toBe("active");
      expect(view.status.plan).toBe("growth");
      expect(view.payments[0]!.amountWei).toBe("50000000000000000");
    });

    it("keeps a LAPSED customer able to sign in and see what they owe", async () => {
      // The property the whole design exists for. Migration 0004 described an unpaid subscription
      // as reaching `status = 'suspended'`, and `issue` refuses a session for a suspended tenant —
      // so building it that way would lock a customer out of the page where they would pay.
      await tenants.createWithOwner({id: tenantId("t_lapsed"), name: "Lapsed Co", subject: ALICE});
      await new SubscriptionRepository(pg.pool).recordPayment({
        tenantId: tenantId("t_lapsed"),
        plan: "growth",
        periodSeconds: 60,
        recordedBy: "test",
        // Long expired, grace included.
        now: Math.floor(Date.now() / 1000) - 400 * 86_400,
      });

      const token = await signIn(ALICE, "t_lapsed");
      const response = await get("/admin/subscription", token);

      expect(response.statusCode, "a lapsed customer must still be able to sign in").toBe(200);
      const body = JSON.parse(response.body) as {status: {state: string; allowsSponsorship: boolean}};
      expect(body.status.state).toBe("lapsed");
      expect(body.status.allowsSponsorship).toBe(false);

      // Their keys and funding page stay readable too, for the same reason.
      expect((await get("/admin/keys", token)).statusCode).toBe(200);
      expect((await get("/admin/funding", token)).statusCode).toBe(200);
    });

    it("refuses a malformed transaction hash rather than storing it", async () => {
      await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
      const secret = await platformBillingKey();

      const response = await post("/admin/subscriptions/payments", secret, {
        tenantId: "t_acme",
        plan: "growth",
        periodSeconds: 2_592_000,
        chainId: 8453,
        txHash: "not-a-hash",
      });
      // A hash that cannot be checked against the chain is worse than no hash: it looks like proof.
      expect(response.statusCode).toBe(400);
    });
  });
});
