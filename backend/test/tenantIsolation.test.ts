import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {Address} from "viem";

import {generateApiKey} from "../src/auth/apiKey.js";
import {InMemoryApiKeyStore} from "../src/auth/inMemoryApiKeyStore.js";
import type {ApiKeyRecord} from "../src/auth/apiKeyStore.js";
import {AuditLogRepository} from "../src/db/auditLogRepository.js";
import {migrate} from "../src/db/migrate.js";
import {PostgresApiKeyStore} from "../src/db/postgresApiKeyStore.js";
import {PostgresPolicyRepository} from "../src/db/postgresPolicyRepository.js";
import {SponsorshipRepository} from "../src/db/sponsorshipRepository.js";
import {
  DEFAULT_TENANT_ID,
  forTenant,
  InvalidTenantIdError,
  PLATFORM_SCOPE,
  PlatformScopeCannotWriteError,
  tenantId,
} from "../src/db/scope.js";
import {PolicyFactory} from "../src/policy/policyFactory.js";
import {PolicySource} from "../src/policy/policySource.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {startPostgres, type TestPostgres} from "./support/postgres.js";
import {ACME, ACME_SCOPE, RIVAL, RIVAL_SCOPE} from "./support/tenants.js";

/**
 * The tenant boundary, asserted rather than assumed.
 *
 * Every test here is the same shape: give two tenants identical-looking data, then check that one
 * cannot see, change, or destroy the other's. They exist because the failure mode is silent — a
 * query missing its `WHERE tenant_id` returns MORE rows, not an error, so nothing fails until a
 * customer sees another customer's configuration.
 *
 * Against a real PostgreSQL, deliberately: the composite foreign key that stops a key being pinned
 * to another tenant's policy is a database constraint, and an in-memory fake would assert only that
 * this file's own logic is self-consistent.
 */
describe("tenant isolation", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
    await migrate(pg.pool);
    // The default tenant arrives with the migration; the rival is created here so both exist before
    // anything references them.
    await pg.pool.query("INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [RIVAL, "Rival"]);
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.pool.query("DELETE FROM sponsorships");
    await pg.pool.query("DELETE FROM audit_logs");
    await pg.pool.query("DELETE FROM api_keys");
    await pg.pool.query("DELETE FROM policies");
  });

  // ----------------------------------------------------------------------------------------------
  // policies
  // ----------------------------------------------------------------------------------------------

  describe("policies", () => {
    function repository() {
      return new PostgresPolicyRepository(pg.pool, new PolicyFactory(new InMemoryQuotaStore()));
    }

    const definition = (id: string, name: string) => ({
      id,
      name,
      enabled: true,
      rules: [{ruleType: "chain-enabled", config: {chainIds: [8453]}}],
    });

    it("lets two tenants both own a policy called 'default'", async () => {
      const repo = repository();
      await repo.upsert(ACME_SCOPE, definition("default", "Acme default"));
      await repo.upsert(RIVAL_SCOPE, definition("default", "Rival default"));

      // The whole reason the primary key is (tenant_id, id): whoever signs up first must not take
      // the name "default" from everyone else, and DEFAULT_POLICY_ID means every tenant wants it.
      expect((await repo.get(ACME_SCOPE, "default")).name).toBe("Acme default");
      expect((await repo.get(RIVAL_SCOPE, "default")).name).toBe("Rival default");
    });

    it("does not list another tenant's policies", async () => {
      const repo = repository();
      await repo.upsert(ACME_SCOPE, definition("acme-only", "Acme"));
      await repo.upsert(RIVAL_SCOPE, definition("rival-only", "Rival"));

      expect((await repo.list(ACME_SCOPE)).map((p) => p.id)).toEqual(["acme-only"]);
      expect((await repo.list(RIVAL_SCOPE)).map((p) => p.id)).toEqual(["rival-only"]);
    });

    it("reports another tenant's policy as not found, never as forbidden", async () => {
      const repo = repository();
      await repo.upsert(RIVAL_SCOPE, definition("secret-plan", "Rival"));

      // "Forbidden" would confirm the id exists. Policy ids are guessable, so that is a disclosure.
      await expect(repo.get(ACME_SCOPE, "secret-plan")).rejects.toThrow(/no policy with id/);
    });

    it("refuses to delete another tenant's policy", async () => {
      const repo = repository();
      await repo.upsert(RIVAL_SCOPE, definition("rival-only", "Rival"));

      expect(await repo.delete(ACME_SCOPE, "rival-only")).toBe(false);
      expect((await repo.list(RIVAL_SCOPE)).map((p) => p.id)).toEqual(["rival-only"]);
    });

    it("does not overwrite another tenant's policy of the same name", async () => {
      const repo = repository();
      await repo.upsert(RIVAL_SCOPE, definition("shared-name", "Rival original"));
      await repo.upsert(ACME_SCOPE, definition("shared-name", "Acme's own"));

      // An upsert keyed on id alone would have UPDATED the rival's row here.
      expect((await repo.get(RIVAL_SCOPE, "shared-name")).name).toBe("Rival original");
      expect((await repo.get(ACME_SCOPE, "shared-name")).name).toBe("Acme's own");
    });

    it("loads every tenant's policies under platform scope, keyed so they cannot collide", async () => {
      const repo = repository();
      await repo.upsert(ACME_SCOPE, definition("default", "Acme default"));
      await repo.upsert(RIVAL_SCOPE, definition("default", "Rival default"));

      const source = new PolicySource(repo);
      await source.reload();

      // Both are loaded and both are reachable — but only through their own tenant.
      expect(source.has(ACME, "default")).toBe(true);
      expect(source.has(RIVAL, "default")).toBe(true);
      expect(source.get(ACME, "default")).not.toBe(source.get(RIVAL, "default"));
    });

    it("refuses a policy write under platform scope", async () => {
      // A row with no owner would be invisible to every tenant-scoped read forever.
      await expect(repository().upsert(PLATFORM_SCOPE, definition("orphan", "Nobody"))).rejects.toBeInstanceOf(
        PlatformScopeCannotWriteError,
      );
    });
  });

  // ----------------------------------------------------------------------------------------------
  // api keys
  // ----------------------------------------------------------------------------------------------

  describe("api keys", () => {
    function record(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
      const generated = generateApiKey("test");
      return {
        tenantId: ACME,
        id: "key-1",
        name: "key",
        hash: generated.hash,
        displayPrefix: generated.displayPrefix,
        roles: ["sponsor"],
        policyId: undefined,
        enabled: true,
        createdAt: 1_700_000_000,
        expiresAt: undefined,
        lastUsedAt: undefined,
        ...over,
      };
    }

    it("does not list another tenant's keys", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      await store.create(ACME_SCOPE, record({id: "acme-key"}));
      await store.create(RIVAL_SCOPE, record({id: "rival-key"}));

      expect((await store.list(ACME_SCOPE)).map((k) => k.id)).toEqual(["acme-key"]);
      expect((await store.list(RIVAL_SCOPE)).map((k) => k.id)).toEqual(["rival-key"]);
    });

    it("refuses to revoke another tenant's key", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      await store.create(RIVAL_SCOPE, record({id: "rival-key"}));

      expect(await store.revoke(ACME_SCOPE, "rival-key", 1_700_000_100)).toBe(false);
      expect((await store.list(RIVAL_SCOPE))[0]!.enabled, "the rival's key must still work").toBe(true);
    });

    it("puts the tenant on the key, so authentication establishes it", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const rival = record({id: "rival-key"});
      await store.create(RIVAL_SCOPE, rival);

      // The request path looks a key up by hash with no scope — this is where a request acquires
      // its tenant, so the value must come back from the store rather than be assumed.
      const found = await store.findByHash(rival.hash);
      expect(found?.tenantId).toBe(RIVAL);
    });

    it("cannot pin a key to another tenant's policy", async () => {
      const policies = new PostgresPolicyRepository(pg.pool, new PolicyFactory(new InMemoryQuotaStore()));
      await policies.upsert(RIVAL_SCOPE, {id: "rival-policy", name: "Rival", enabled: true, rules: []});

      const store = new PostgresApiKeyStore(pg.pool);

      // Refused by the composite foreign key, not by application code — which is the point. Even a
      // bug in the admin service cannot store this row.
      await expect(store.create(ACME_SCOPE, record({id: "sneaky", policyId: "rival-policy"}))).rejects.toThrow(
        /foreign key constraint/,
      );
    });

    it("applies the same boundary in the in-memory store", async () => {
      // The two implementations must agree: a deployment without a database must not have a weaker
      // boundary than one with it.
      const store = new InMemoryApiKeyStore();
      await store.create(ACME_SCOPE, record({id: "acme-key"}));
      await store.create(RIVAL_SCOPE, record({id: "rival-key"}));

      expect((await store.list(ACME_SCOPE)).map((k) => k.id)).toEqual(["acme-key"]);
      expect(await store.revoke(ACME_SCOPE, "rival-key", 1)).toBe(false);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // sponsorships and audit
  // ----------------------------------------------------------------------------------------------

  describe("sponsorships", () => {
    const SENDER = "0x1111111111111111111111111111111111111111" as Address;

    async function seed(scope: typeof ACME_SCOPE, keyId: string) {
      const store = new PostgresApiKeyStore(pg.pool);
      const generated = generateApiKey("test");
      await store.create(scope, {
        id: keyId,
        name: keyId,
        hash: generated.hash,
        displayPrefix: generated.displayPrefix,
        roles: ["sponsor"],
        policyId: undefined,
        enabled: true,
        createdAt: 1_700_000_000,
        expiresAt: undefined,
        lastUsedAt: undefined,
      });

      await new SponsorshipRepository(pg.pool).record({
        tenantId: scope.tenantId,
        chainId: 8453,
        sender: SENDER,
        nonce: 1n,
        paymaster: SENDER,
        entryPoint: SENDER,
        apiKeyId: keyId,
        policyId: "default",
        signer: SENDER,
        maxCostWei: 10n ** 15n,
        validAfter: 1_700_000_000,
        validUntil: 1_700_000_300,
      });
    }

    it("does not show one tenant another's sponsorships", async () => {
      await seed(ACME_SCOPE, "acme-key");
      await seed(RIVAL_SCOPE, "rival-key");

      const repo = new SponsorshipRepository(pg.pool);
      expect((await repo.list(ACME_SCOPE)).map((s) => s.apiKeyId)).toEqual(["acme-key"]);
      expect((await repo.list(RIVAL_SCOPE)).map((s) => s.apiKeyId)).toEqual(["rival-key"]);

      // Usage metering and billing both read this under platform scope, and must see everything.
      expect(await repo.list(PLATFORM_SCOPE)).toHaveLength(2);
    });

    it("keeps the tenant on the row, so billing needs no join", async () => {
      await seed(RIVAL_SCOPE, "rival-key");
      const rows = await new SponsorshipRepository(pg.pool).list(RIVAL_SCOPE);
      expect(rows[0]!.tenantId).toBe(RIVAL);
    });

    it("does not show one tenant another's audit trail", async () => {
      const audit = new AuditLogRepository(pg.pool);
      await audit.record({tenantId: ACME, actor: "acme-admin", action: "policy.upsert"});
      await audit.record({tenantId: RIVAL, actor: "rival-admin", action: "policy.upsert"});
      // A platform action, belonging to no tenant.
      await audit.record({actor: "system", action: "chain.enable"});

      expect((await audit.list(ACME_SCOPE)).map((e) => e.actor)).toEqual(["acme-admin"]);
      expect((await audit.list(RIVAL_SCOPE)).map((e) => e.actor)).toEqual(["rival-admin"]);
      // The operator sees everything, including the row no tenant owns.
      expect((await audit.list(PLATFORM_SCOPE)).map((e) => e.actor).sort()).toEqual([
        "acme-admin",
        "rival-admin",
        "system",
      ]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // the scope type itself
  // ----------------------------------------------------------------------------------------------

  describe("scope", () => {
    it("refuses a malformed tenant id at construction", () => {
      // Rejected here rather than by the column's CHECK three layers down, and never interpolated
      // into SQL regardless — every query binds it as a parameter.
      for (const bad of ["", " ", "a".repeat(65), "has space", "quote'--", "semi;colon"]) {
        expect(() => tenantId(bad), `should reject ${JSON.stringify(bad)}`).toThrow(InvalidTenantIdError);
      }
    });

    it("accepts the default tenant the migration creates", () => {
      expect(DEFAULT_TENANT_ID).toBe("default");
      expect(forTenant("default").tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
