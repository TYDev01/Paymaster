import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {Address} from "viem";

import {generateApiKey, hashApiKey} from "../src/auth/apiKey.js";
import type {ApiKeyRecord} from "../src/auth/apiKeyStore.js";
import {ApiKeyAuthenticator} from "../src/auth/authenticator.js";
import {AuditLogRepository} from "../src/db/auditLogRepository.js";
import {loadMigrations, migrate, MigrationError} from "../src/db/migrate.js";
import {PostgresApiKeyStore} from "../src/db/postgresApiKeyStore.js";
import {SponsorshipRepository} from "../src/db/sponsorshipRepository.js";
import {startPostgres, truncateAll, type TestPostgres} from "./support/postgres.js";

const NOW = 1_700_000_000;
const SENDER = "0x1234567890123456789012345678901234567890" as Address;
const PAYMASTER = "0x1111111111111111111111111111111111111111" as Address;
const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032" as Address;
const SIGNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;

describe("database", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await truncateAll(pg.pool);
  });

  describe("api_keys.policy_id foreign key", () => {
    /**
     * A key pinned to a policy that does not exist could never sponsor anything — every request
     * would fail as an unknown policy. Rejecting at creation turns a silent dead key into an
     * immediate error.
     */
    it("refuses a key pinned to a policy that does not exist", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord({policyId: "ghost"});
      await expect(store.create(record)).rejects.toThrow(/foreign key constraint/);
    });

    /**
     * The escalation this prevents: an unpinned key may name any policy in the request body, so
     * silently unpinning keys on delete would hand every one of them a free upgrade.
     */
    it("refuses to delete a policy a key is pinned to", async () => {
      await pg.pool.query("INSERT INTO policies (id, name) VALUES ('pinned', 'pinned')");
      const store = new PostgresApiKeyStore(pg.pool);
      await store.create(keyRecord({policyId: "pinned"}).record);

      await expect(pg.pool.query("DELETE FROM policies WHERE id = 'pinned'")).rejects.toThrow(
        /foreign key constraint/,
      );
    });
  });

  function keyRecord(over: Partial<ApiKeyRecord> = {}): {record: ApiKeyRecord; secret: string} {
    const generated = generateApiKey("test");
    return {
      secret: generated.secret,
      record: {
        id: "k1",
        name: "test key",
        hash: generated.hash,
        displayPrefix: generated.displayPrefix,
        roles: ["sponsor"],
        policyId: undefined,
        enabled: true,
        createdAt: NOW,
        expiresAt: undefined,
        lastUsedAt: undefined,
        ...over,
      },
    };
  }

  describe("migrations", () => {
    it("applies cleanly and is idempotent", async () => {
      // startPostgres already migrated; running again must be a no-op, which is what makes it safe
      // to run automatically on every boot.
      const result = await migrate(pg.pool);
      expect(result.applied).toEqual([]);
      expect(result.alreadyApplied).toContain(1);
    });

    it("records a checksum for each applied migration", async () => {
      const {rows} = await pg.pool.query<{version: string; checksum: string}>(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    /**
     * Editing an applied migration silently desynchronises environments: this database keeps the
     * old DDL while a fresh one gets the new. Refusing is the only safe answer.
     */
    it("refuses to run when an applied migration was modified", async () => {
      await pg.pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = 1", ["0".repeat(64)]);
      await expect(migrate(pg.pool)).rejects.toThrow(/modified after being applied/);
      // Restore so later tests see a consistent ledger.
      const migrations = await loadMigrations();
      await pg.pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = 1", [migrations[0]!.checksum]);
    });

    /**
     * A rolling deploy starts every replica at once and they all migrate. The advisory lock is
     * what stops them racing; without it, two would run the same DDL and one would crash.
     */
    it("serialises concurrent migrators", async () => {
      const results = await Promise.all(Array.from({length: 8}, () => migrate(pg.pool)));
      // Whichever ran first found nothing pending; none may error or double-apply.
      for (const result of results) expect(result.applied).toEqual([]);

      // Derived from the files, not hardcoded: a new migration must not break this test.
      const expected = (await loadMigrations()).length;
      const {rows} = await pg.pool.query<{count: string}>("SELECT count(*)::text AS count FROM schema_migrations");
      expect(rows[0]!.count, "each migration must be applied exactly once").toBe(String(expected));
    });

    it("releases the advisory lock", async () => {
      await migrate(pg.pool);
      const {rows} = await pg.pool.query<{count: string}>(
        "SELECT count(*)::text AS count FROM pg_locks WHERE locktype = 'advisory'",
      );
      expect(rows[0]!.count, "a leaked lock would wedge every future deploy").toBe("0");
    });

    it("rejects a badly named migration file", async () => {
      await expect(loadMigrations("/nonexistent")).rejects.toThrow();
    });
  });

  describe("schema constraints", () => {
    /**
     * The reason wei is NUMERIC(78,0) and not BIGINT: BIGINT overflows at ~9.22e18, which is 9.22
     * ETH. A paymaster holding 10 ETH could not record its own spending.
     */
    it("stores wei amounts beyond BIGINT range", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);

      const repo = new SponsorshipRepository(pg.pool);
      // 1000 ETH in wei — over 100x what BIGINT can hold.
      const huge = 1_000n * 10n ** 18n;
      expect(huge).toBeGreaterThan(2n ** 63n - 1n);

      await repo.record({
        chainId: 8453,
        sender: SENDER,
        nonce: 0n,
        paymaster: PAYMASTER,
        entryPoint: ENTRY_POINT,
        apiKeyId: record.id,
        policyId: "default",
        signer: SIGNER,
        maxCostWei: huge,
        validAfter: NOW,
        validUntil: NOW + 300,
      });

      const [stored] = await repo.findForOperation(8453, SENDER, 0n);
      expect(stored!.maxCostWei, "wei must survive the round trip exactly").toBe(huge);
    });

    it("stores a uint256 nonce without precision loss", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);

      const repo = new SponsorshipRepository(pg.pool);
      // A 2D-nonce key uses the high 192 bits, so large nonces are normal, not exotic.
      const nonce = 2n ** 200n + 12_345n;
      await repo.record({
        chainId: 8453,
        sender: SENDER,
        nonce,
        paymaster: PAYMASTER,
        entryPoint: ENTRY_POINT,
        apiKeyId: record.id,
        policyId: "default",
        signer: SIGNER,
        maxCostWei: 1n,
        validAfter: NOW,
        validUntil: NOW + 300,
      });

      const [stored] = await repo.findForOperation(8453, SENDER, nonce);
      expect(stored!.nonce).toBe(nonce);
    });

    it("rejects a malformed address at the database boundary", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);

      await expect(
        pg.pool.query(
          `INSERT INTO sponsorships (chain_id, sender, nonce, paymaster, entry_point, api_key_id, policy_id, signer, max_cost_wei, valid_after, valid_until)
           VALUES (1, 'not-an-address', 0, $1, $2, $3, 'p', $4, 1, now(), now() + interval '1 hour')`,
          [PAYMASTER, ENTRY_POINT, record.id, SIGNER],
        ),
      ).rejects.toThrow(/sender_check|violates check constraint/);
    });

    it("rejects an uppercase address, which would break equality", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);

      await expect(
        pg.pool.query(
          `INSERT INTO sponsorships (chain_id, sender, nonce, paymaster, entry_point, api_key_id, policy_id, signer, max_cost_wei, valid_after, valid_until)
           VALUES (1, $1, 0, $2, $3, $4, 'p', $5, 1, now(), now() + interval '1 hour')`,
          ["0xABCDEF1234567890ABCDEF1234567890ABCDEF12", PAYMASTER, ENTRY_POINT, record.id, SIGNER],
        ),
      ).rejects.toThrow(/violates check constraint/);
    });

    it("rejects an inverted validity window", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);

      await expect(
        pg.pool.query(
          `INSERT INTO sponsorships (chain_id, sender, nonce, paymaster, entry_point, api_key_id, policy_id, signer, max_cost_wei, valid_after, valid_until)
           VALUES (1, $1, 0, $2, $3, $4, 'p', $5, 1, now(), now() - interval '1 hour')`,
          [SENDER, PAYMASTER, ENTRY_POINT, record.id, SIGNER],
        ),
      ).rejects.toThrow(/sponsorships_window/);
    });

    /** Sponsorship history must outlive the key that authorised it. */
    it("refuses to delete a key that authorised sponsorships", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);

      await new SponsorshipRepository(pg.pool).record({
        chainId: 8453,
        sender: SENDER,
        nonce: 1n,
        paymaster: PAYMASTER,
        entryPoint: ENTRY_POINT,
        apiKeyId: record.id,
        policyId: "default",
        signer: SIGNER,
        maxCostWei: 1n,
        validAfter: NOW,
        validUntil: NOW + 300,
      });

      await expect(pg.pool.query("DELETE FROM api_keys WHERE id = $1", [record.id])).rejects.toThrow(
        /foreign key constraint/,
      );
    });

    it("keeps enabled and revoked_at consistent", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);
      await expect(
        pg.pool.query("UPDATE api_keys SET enabled = false WHERE id = $1", [record.id]),
      ).rejects.toThrow(/api_keys_revoked_consistency/);
    });
  });

  describe("PostgresApiKeyStore", () => {
    it("round-trips a key", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      // The policy must exist first: api_keys.policy_id is a foreign key as of 0002.
      await pg.pool.query("INSERT INTO policies (id, name) VALUES ('restricted', 'restricted')");
      const {record, secret} = keyRecord({policyId: "restricted", expiresAt: NOW + 3_600});
      await store.create(record);

      const found = await store.findByHash(hashApiKey(secret));
      expect(found).toMatchObject({
        id: "k1",
        name: "test key",
        roles: ["sponsor"],
        policyId: "restricted",
        enabled: true,
        expiresAt: NOW + 3_600,
      });
    });

    it("returns undefined for an unknown hash", async () => {
      expect(await new PostgresApiKeyStore(pg.pool).findByHash("0".repeat(64))).toBeUndefined();
    });

    it("enforces hash uniqueness", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);
      await expect(store.create({...record, id: "k2"})).rejects.toThrow(/duplicate key|unique/i);
    });

    it("revokes idempotently", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record, secret} = keyRecord();
      await store.create(record);

      expect(await store.revoke("k1", NOW)).toBe(true);
      expect(await store.revoke("k1", NOW), "a second revoke changes nothing").toBe(false);
      expect((await store.findByHash(hashApiKey(secret)))!.enabled).toBe(false);
    });

    /** Two replicas racing must not let an older timestamp win and make a live key look stale. */
    it("keeps last_used_at monotonic", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord();
      await store.create(record);

      await store.touch("k1", NOW);
      await store.touch("k1", NOW - 500);

      expect((await store.list())[0]!.lastUsedAt).toBe(NOW);
    });

    it("drops roles that no longer exist in code", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record, secret} = keyRecord();
      await store.create(record);
      await pg.pool.query("UPDATE api_keys SET roles = ARRAY['sponsor','wizard'] WHERE id = $1", [record.id]);

      const found = await store.findByHash(hashApiKey(secret));
      expect(found!.roles, "an unknown role must not survive into permission checks").toEqual(["sponsor"]);
    });

    it("stores no recoverable credential", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record, secret} = keyRecord();
      await store.create(record);

      const {rows} = await pg.pool.query("SELECT * FROM api_keys");
      expect(JSON.stringify(rows)).not.toContain(secret.slice(8));
    });

    /** The whole point: keys must survive a restart, which the in-memory store cannot do. */
    it("authenticates through the real authenticator", async () => {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record, secret} = keyRecord();
      await store.create(record);

      const auth = new ApiKeyAuthenticator(store);
      const result = await auth.authenticate(secret, NOW);
      expect(result.ok && result.principal.permissions.has("sponsor:create")).toBe(true);
    });
  });

  describe("SponsorshipRepository", () => {
    async function seedKey(id = "k1"): Promise<string> {
      const store = new PostgresApiKeyStore(pg.pool);
      const {record} = keyRecord({id});
      await store.create(record);
      return id;
    }

    function sponsorship(over: Partial<Parameters<SponsorshipRepository["record"]>[0]> = {}) {
      return {
        chainId: 8453,
        sender: SENDER,
        nonce: 0n,
        paymaster: PAYMASTER,
        entryPoint: ENTRY_POINT,
        apiKeyId: "k1",
        policyId: "default",
        signer: SIGNER,
        maxCostWei: 10n ** 15n,
        validAfter: NOW,
        validUntil: NOW + 300,
        ...over,
      };
    }

    it("records and reads back an attestation", async () => {
      await seedKey();
      const repo = new SponsorshipRepository(pg.pool);
      const id = await repo.record(sponsorship());

      expect(id).toBeGreaterThan(0n);
      const [stored] = await repo.findForOperation(8453, SENDER, 0n);
      expect(stored).toMatchObject({policyId: "default", maxCostWei: 10n ** 15n, apiKeyId: "k1"});
    });

    it("normalises address casing on write", async () => {
      await seedKey();
      const repo = new SponsorshipRepository(pg.pool);
      await repo.record(sponsorship({sender: SENDER.toUpperCase().replace("0X", "0x") as Address}));

      // Found by the lowercase form, which is what the correlation query will use.
      expect(await repo.findForOperation(8453, SENDER, 0n)).toHaveLength(1);
    });

    /** Several attestations per nonce is normal: clients re-estimate gas. */
    it("permits multiple attestations for one operation", async () => {
      await seedKey();
      const repo = new SponsorshipRepository(pg.pool);
      await repo.record(sponsorship());
      await repo.record(sponsorship({maxCostWei: 2n * 10n ** 15n}));

      expect(await repo.findForOperation(8453, SENDER, 0n)).toHaveLength(2);
    });

    it("filters by key, chain, and sender", async () => {
      await seedKey("k1");
      await seedKey("k2");
      const repo = new SponsorshipRepository(pg.pool);

      await repo.record(sponsorship({apiKeyId: "k1", chainId: 8453}));
      await repo.record(sponsorship({apiKeyId: "k2", chainId: 10, nonce: 1n}));

      expect(await repo.list({apiKeyId: "k1"})).toHaveLength(1);
      expect(await repo.list({chainId: 10})).toHaveLength(1);
      expect(await repo.list({sender: SENDER})).toHaveLength(2);
      expect(await repo.list()).toHaveLength(2);
    });

    /** An unbounded admin listing is a denial of service wearing a report's clothes. */
    it("caps the result set", async () => {
      await seedKey();
      const repo = new SponsorshipRepository(pg.pool);
      for (let i = 0; i < 5; i++) await repo.record(sponsorship({nonce: BigInt(i)}));

      expect(await repo.list({limit: 2})).toHaveLength(2);
      expect(await repo.list({limit: 10_000})).toHaveLength(5);
    });

    it("sums committed wei beyond BIGINT range", async () => {
      await seedKey();
      const repo = new SponsorshipRepository(pg.pool);
      const each = 5n * 10n ** 18n; // 5 ETH

      for (let i = 0; i < 4; i++) await repo.record(sponsorship({nonce: BigInt(i), maxCostWei: each}));

      // 20 ETH total: over twice what a BIGINT sum could hold.
      expect(await repo.sumCommittedWei(NOW - 3_600)).toBe(4n * each);
    });

    it("scopes the sum by chain and window", async () => {
      await seedKey();
      const repo = new SponsorshipRepository(pg.pool);
      await repo.record(sponsorship({chainId: 8453, maxCostWei: 100n}));
      await repo.record(sponsorship({chainId: 10, nonce: 1n, maxCostWei: 200n}));

      expect(await repo.sumCommittedWei(NOW - 3_600, 8453)).toBe(100n);
      expect(await repo.sumCommittedWei(NOW - 3_600)).toBe(300n);
      // A window starting in the future contains nothing.
      expect(await repo.sumCommittedWei(Math.floor(Date.now() / 1000) + 3_600)).toBe(0n);
    });

    it("is not confused by a SQL-injection-shaped sender", async () => {
      await seedKey();
      const repo = new SponsorshipRepository(pg.pool);
      await repo.record(sponsorship());

      // Parameterised: this is data, not syntax. The table must survive.
      const hostile = "0x'; DROP TABLE sponsorships; --" as Address;
      expect(await repo.list({sender: hostile})).toHaveLength(0);
      expect(await repo.list()).toHaveLength(1);
    });
  });

  describe("AuditLogRepository", () => {
    it("records and lists entries newest first", async () => {
      const repo = new AuditLogRepository(pg.pool);
      await repo.record({actor: "admin1", action: "policy.update", subject: "policy:default"});
      await repo.record({actor: "admin1", action: "key.revoke", subject: "api_key:k1"});

      const entries = await repo.list();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.action).toBe("key.revoke");
    });

    it("stores structured detail and client ip", async () => {
      const repo = new AuditLogRepository(pg.pool);
      await repo.record({
        actor: "admin1",
        action: "chain.disable",
        subject: "chain:8453",
        detail: {reason: "deposit low", previous: true},
        clientIp: "203.0.113.7",
      });

      const [entry] = await repo.list();
      expect(entry!.detail).toEqual({reason: "deposit low", previous: true});
      expect(entry!.clientIp).toBe("203.0.113.7");
    });

    /**
     * The audit log is where a careless payload leaves a credential sitting in plain text forever.
     * Redaction is at the write: a secret that reaches the table is already leaked.
     */
    it("redacts credentials before writing", async () => {
      const repo = new AuditLogRepository(pg.pool);
      await repo.record({
        actor: "admin1",
        action: "key.create",
        detail: {
          name: "acme",
          secret: "pm_live_SUPERSECRET",
          apiKey: "pm_live_ALSOSECRET",
          nested: {privateKey: "0xdeadbeef", harmless: "keep me"},
        },
      });

      const {rows} = await pg.pool.query<{detail: Record<string, unknown>}>("SELECT detail FROM audit_logs");
      const raw = JSON.stringify(rows[0]!.detail);

      expect(raw).not.toContain("SUPERSECRET");
      expect(raw).not.toContain("ALSOSECRET");
      expect(raw).not.toContain("0xdeadbeef");
      expect(raw).toContain("keep me");
      expect(raw).toContain("acme");
    });

    it("redacts regardless of key casing or separators", async () => {
      const repo = new AuditLogRepository(pg.pool);
      await repo.record({
        actor: "a",
        action: "t",
        detail: {API_KEY: "s1", "private-key": "s2", Token: "s3", PASSWORD: "s4"},
      });

      const {rows} = await pg.pool.query<{detail: Record<string, unknown>}>("SELECT detail FROM audit_logs");
      const raw = JSON.stringify(rows[0]!.detail);
      for (const secret of ["s1", "s2", "s3", "s4"]) expect(raw).not.toContain(secret);
    });

    it("redacts inside arrays", async () => {
      const repo = new AuditLogRepository(pg.pool);
      await repo.record({actor: "a", action: "t", detail: {keys: [{secret: "hideme"}, {name: "ok"}]}});

      const {rows} = await pg.pool.query<{detail: Record<string, unknown>}>("SELECT detail FROM audit_logs");
      expect(JSON.stringify(rows[0]!.detail)).not.toContain("hideme");
    });

    it("survives a deeply nested payload", async () => {
      const repo = new AuditLogRepository(pg.pool);
      let deep: Record<string, unknown> = {secret: "hideme"};
      for (let i = 0; i < 50; i++) deep = {nested: deep};

      await expect(repo.record({actor: "a", action: "t", detail: deep})).resolves.toBeGreaterThan(0n);
      const {rows} = await pg.pool.query<{detail: Record<string, unknown>}>("SELECT detail FROM audit_logs");
      expect(JSON.stringify(rows[0]!.detail)).not.toContain("hideme");
    });

    it("filters by actor, action, and time", async () => {
      const repo = new AuditLogRepository(pg.pool);
      await repo.record({actor: "admin1", action: "policy.update"});
      await repo.record({actor: "admin2", action: "key.revoke"});

      expect(await repo.list({actor: "admin1"})).toHaveLength(1);
      expect(await repo.list({action: "key.revoke"})).toHaveLength(1);
      expect(await repo.list({since: Math.floor(Date.now() / 1000) + 60})).toHaveLength(0);
    });

    it("rejects a malformed client ip rather than storing junk", async () => {
      const repo = new AuditLogRepository(pg.pool);
      await expect(repo.record({actor: "a", action: "t", clientIp: "not-an-ip"})).rejects.toThrow();
    });
  });
});
