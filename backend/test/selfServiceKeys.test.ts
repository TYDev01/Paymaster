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
import {ChainRegistry} from "../src/chain/chainRegistry.js";
import {migrate} from "../src/db/migrate.js";
import {PostgresApiKeyStore} from "../src/db/postgresApiKeyStore.js";
import {PostgresPolicyRepository} from "../src/db/postgresPolicyRepository.js";
import {AuditLogRepository} from "../src/db/auditLogRepository.js";
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

    const deps: AppDependencies = {
      chains: ChainRegistry.fromConfigs([]),
      policies: policySource,
      signer: new LocalSponsorshipSigner(SIGNER_KEY),
      apiKeys: new PostgresApiKeyStore(pg.pool),
      policyRepository: new PostgresPolicyRepository(pg.pool, new PolicyFactory(new InMemoryQuotaStore())),
      audit: new AuditLogRepository(pg.pool),
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
});
