import {createHash} from "node:crypto";
import {readdir, readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import type {Pool, PoolClient} from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(HERE, "../../migrations");

/**
 * Namespace for the advisory lock. Arbitrary but must be stable: every replica has to pick the
 * same number or the lock does not serialise anything.
 */
const MIGRATION_LOCK_ID = 8_337_0001;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/** Files are `NNNN_name.sql`; the numeric prefix is the version and defines the order. */
export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<readonly Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (match === null) throw new MigrationError(`migration filename must be NNNN_name.sql, got: ${file}`);

    const version = Number(match[1]);
    const sql = await readFile(join(dir, file), "utf8");

    if (migrations.some((m) => m.version === version)) {
      throw new MigrationError(`duplicate migration version ${version}`);
    }

    migrations.push({
      version,
      name: match[2]!,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

export interface MigrateResult {
  readonly applied: readonly number[];
  readonly alreadyApplied: readonly number[];
}

/**
 * Applies pending migrations.
 *
 * Two properties make this safe to run automatically on every boot, which is what td.md's
 * "automatic migrations" plus rolling deployments requires:
 *
 * 1. AN ADVISORY LOCK SERIALISES REPLICAS. A rolling deploy starts N pods at once, all of which
 *    run this. Without the lock they race: two transactions both see version 3 as pending, both
 *    run `CREATE TABLE`, and one crashes the pod — or worse, two run a non-idempotent data
 *    migration and it happens twice. `pg_advisory_lock` makes the second replica wait and then
 *    observe the work as already done. The lock is session-scoped and released in `finally`, so a
 *    crashed migration does not wedge every future deploy.
 *
 * 2. EACH MIGRATION IS ONE TRANSACTION, WITH ITS BOOKKEEPING. The DDL and the `schema_migrations`
 *    insert commit together, so a migration can never be applied-but-unrecorded (which would make
 *    the next boot try to re-apply it) or recorded-but-unapplied (which would silently skip it).
 *    Postgres has transactional DDL; this design would not port to MySQL unchanged.
 */
export async function migrate(pool: Pool, dir?: string): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    return await applyPending(client, migrations);
  } finally {
    // Release before returning the connection: an advisory lock outlives a query but not a
    // session, and a pooled session handed to someone else still holding it would deadlock the
    // next migration.
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

async function applyPending(client: PoolClient, migrations: readonly Migration[]): Promise<MigrateResult> {
  await ensureMigrationsTable(client);

  const {rows} = await client.query<{version: string; name: string; checksum: string}>(
    "SELECT version, name, checksum FROM schema_migrations",
  );
  const applied = new Map(rows.map((r) => [Number(r.version), r]));

  // A migration whose content changed after being applied means environments have silently
  // diverged: this database has the old DDL, a fresh one would get the new. Refuse rather than
  // guess. The fix is a new migration, never an edit to an old one.
  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (record !== undefined && record.checksum !== migration.checksum) {
      throw new MigrationError(
        `migration ${migration.version}_${migration.name} was modified after being applied ` +
          `(recorded ${record.checksum.slice(0, 12)}, found ${migration.checksum.slice(0, 12)}). ` +
          `Add a new migration instead of editing an applied one.`,
      );
    }
  }

  const appliedNow: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
        migration.version,
        migration.name,
        migration.checksum,
      ]);
      await client.query("COMMIT");
      appliedNow.push(migration.version);
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new MigrationError(`migration ${migration.version}_${migration.name} failed: ${String(cause)}`, {cause});
    }
  }

  return {applied: appliedNow, alreadyApplied: [...applied.keys()].sort((a, b) => a - b)};
}

/**
 * Creates the bookkeeping table if absent.
 *
 * Chicken-and-egg: the table that records migrations cannot itself be a migration, so it is not
 * declared in 0001 and is created here instead. `IF NOT EXISTS` keeps repeated boots idempotent.
 */
async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    BIGINT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}
