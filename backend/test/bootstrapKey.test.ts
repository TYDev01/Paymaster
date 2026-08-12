import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";

import {ensureBootstrapKey} from "../src/api/app.module.js";
import {hashApiKey} from "../src/auth/apiKey.js";
import {migrate} from "../src/db/migrate.js";
import {startPostgres, type TestPostgres} from "./support/postgres.js";

/**
 * Seeding the bootstrap key against a REAL schema.
 *
 * This exists because its absence let a total boot failure ship. Migration 0004 made
 * `api_keys.tenant_id` NOT NULL; the in-memory seeding path was updated to carry the default
 * tenant and the SQL one was not, so every deployment with a database — which is every deployment
 * that is not a single-node demo — died at startup with a constraint violation. Nothing executed
 * this function, so nothing noticed.
 *
 * The lesson generalises: a function that only ever runs at boot is a function no test runs.
 */
describe("bootstrap key seeding", () => {
  let pg: TestPostgres;
  const SECRET = `pm_test_${"z".repeat(44)}`;

  beforeAll(async () => {
    pg = await startPostgres();
    await migrate(pg.pool);
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.pool.query("DELETE FROM api_keys");
  });

  it("seeds a usable key against the real schema", async () => {
    await ensureBootstrapKey(pg.pool, SECRET);

    const {rows} = await pg.pool.query<{tenant_id: string; key_hash: string; roles: string[]; enabled: boolean}>(
      "SELECT tenant_id, key_hash, roles, enabled FROM api_keys",
    );

    expect(rows).toHaveLength(1);
    // The column that was missing. A key with no tenant is unreachable by every scoped read even
    // if the insert were allowed, so this is not merely satisfying a constraint.
    expect(rows[0]!.tenant_id).toBe("default");
    expect(rows[0]!.key_hash).toBe(hashApiKey(SECRET));
    expect(rows[0]!.enabled).toBe(true);
  });

  it("is idempotent, because it runs on every boot", async () => {
    await ensureBootstrapKey(pg.pool, SECRET);
    await ensureBootstrapKey(pg.pool, SECRET);

    const {rows} = await pg.pool.query("SELECT 1 FROM api_keys");
    expect(rows).toHaveLength(1);
  });

  it("adds a new row rather than replacing, when the secret is rotated", async () => {
    await ensureBootstrapKey(pg.pool, SECRET);
    await ensureBootstrapKey(pg.pool, `pm_test_${"y".repeat(44)}`);

    // Rotation must not lock out whoever is mid-request with the old one; revoking is a separate,
    // deliberate act.
    const {rows} = await pg.pool.query("SELECT 1 FROM api_keys");
    expect(rows).toHaveLength(2);
  });
});
