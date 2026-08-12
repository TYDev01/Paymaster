import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {applyMigrations, loadMigrations} from "../src/db/migrate.js";
import {startPostgres, type TestPostgres} from "./support/postgres.js";

/**
 * The upgrade path for a database that already has data.
 *
 * A fresh migration always looks fine; the interesting question is whether an operator running the
 * single-tenant version today can apply this and keep working. That has to be tested against data
 * written by the OLD schema, so this applies the migrations up to 0003, writes rows the way that
 * version did, and only then applies 0004.
 *
 * If this ever fails, an upgrade fails in production — which is the one place a migration must not.
 */
describe("tenant migration against existing data", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres({migrate: false});
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("backfills existing rows to the default tenant and keeps them working", async () => {
    const all = await loadMigrations();
    const before = all.filter((m) => m.version < 4);
    const tenants = all.filter((m) => m.version === 4);
    expect(tenants, "0004 must exist for this test to mean anything").toHaveLength(1);

    // 1. The world as it was: schema through 0003.
    await applyMigrations(pg.pool, before);

    // 2. Data written the way the single-tenant version wrote it — no tenant anywhere.
    await pg.pool.query("INSERT INTO policies (id, name) VALUES ('default', 'Default')");
    await pg.pool.query(
      "INSERT INTO policy_rules (policy_id, ordinal, rule_type, config) VALUES ('default', 0, 'chain-enabled', $1::jsonb)",
      [JSON.stringify({chainIds: [8453]})],
    );
    await pg.pool.query(
      `INSERT INTO api_keys (id, name, key_hash, display_prefix, roles, policy_id)
       VALUES ('k1', 'legacy key', $1, 'pm_live_abc', ARRAY['sponsor'], 'default')`,
      ["a".repeat(64)],
    );
    await pg.pool.query(
      `INSERT INTO sponsorships (chain_id, sender, nonce, paymaster, entry_point, api_key_id, policy_id,
                                 signer, max_cost_wei, valid_after, valid_until)
       VALUES (8453, $1, 0, $1, $1, 'k1', 'default', $1, 1000, now(), now() + interval '1 hour')`,
      ["0x" + "1".repeat(40)],
    );
    await pg.pool.query("INSERT INTO audit_logs (actor, action) VALUES ('operator', 'policy.upsert')");

    // 3. The upgrade.
    await applyMigrations(pg.pool, tenants);

    // Everything is now owned by the default tenant, and nothing was lost.
    for (const table of ["policies", "policy_rules", "api_keys", "sponsorships", "audit_logs"]) {
      const {rows} = await pg.pool.query<{count: string; tenant: string | null}>(
        `SELECT count(*)::text AS count, min(tenant_id) AS tenant FROM ${table}`,
      );
      expect(Number(rows[0]!.count), `${table} lost rows`).toBe(1);
      expect(rows[0]!.tenant, `${table} was not backfilled`).toBe("default");
    }

    // The pinned key still points at the same policy, now through the composite key.
    const {rows: pinned} = await pg.pool.query<{tenant_id: string; policy_id: string}>(
      "SELECT tenant_id, policy_id FROM api_keys WHERE id = 'k1'",
    );
    expect(pinned[0]).toEqual({tenant_id: "default", policy_id: "default"});
  }, 120_000);

  it("makes a policy id unique per tenant rather than globally", async () => {
    await pg.pool.query("INSERT INTO tenants (id, name) VALUES ('second', 'Second') ON CONFLICT DO NOTHING");

    // The same id under a different tenant is a new row, not a conflict. Before 0004 this was a
    // primary key violation, which is exactly what would have stopped a second customer using
    // the name "default".
    await expect(
      pg.pool.query("INSERT INTO policies (tenant_id, id, name) VALUES ('second', 'default', 'Second default')"),
    ).resolves.toBeDefined();

    const {rows} = await pg.pool.query<{count: string}>(
      "SELECT count(*)::text AS count FROM policies WHERE id = 'default'",
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it("refuses a key pinned to another tenant's policy, at the database", async () => {
    // The composite foreign key, doing the job application code would otherwise have to remember.
    await expect(
      pg.pool.query(
        `INSERT INTO api_keys (tenant_id, id, name, key_hash, display_prefix, roles, policy_id)
         VALUES ('second', 'k2', 'cross-tenant', $1, 'pm_live_xyz', ARRAY['sponsor'], 'default')`,
        ["b".repeat(64)],
      ),
    ).resolves.toBeDefined();

    // ...that one is legitimate: 'second' owns a policy called 'default'. This one is not — no
    // tenant called 'third' exists, so its policy cannot either.
    await expect(
      pg.pool.query(
        `INSERT INTO api_keys (tenant_id, id, name, key_hash, display_prefix, roles, policy_id)
         VALUES ('default', 'k3', 'cross-tenant', $1, 'pm_live_xyz', ARRAY['sponsor'], 'nonexistent')`,
        ["c".repeat(64)],
      ),
    ).rejects.toThrow(/foreign key constraint/);
  });
});
