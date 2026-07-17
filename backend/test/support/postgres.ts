import {execFile} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";

import {createPool, type DatabasePool} from "../../src/db/pool.js";
import {migrate} from "../../src/db/migrate.js";

const run = promisify(execFile);

/**
 * Locates the PostgreSQL server binaries.
 *
 * Debian/Ubuntu install the server under /usr/lib/postgresql/<major>/bin and put only the client
 * on PATH, so `which postgres` finds nothing even when the server is installed.
 */
async function findBinDir(): Promise<string> {
  const {stdout} = await run("bash", ["-lc", "ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1"]);
  const dir = stdout.trim();
  if (dir === "") {
    throw new Error(
      "PostgreSQL server binaries not found. Install postgresql (e.g. apt install postgresql-16) " +
        "or run these tests against an external database.",
    );
  }
  return dir;
}

export interface TestPostgres {
  readonly pool: DatabasePool;
  readonly connectionString: string;
  stop: () => Promise<void>;
}

/**
 * Starts a disposable PostgreSQL cluster and migrates it.
 *
 * A real server, not an emulation: these tests exercise NUMERIC(78,0) precision, CHECK
 * constraints, advisory locks, and transactional DDL — none of which an in-memory fake reproduces
 * faithfully, and all of which are exactly what could break in production.
 *
 * The cluster is entirely self-contained: its own data directory under the OS temp dir, its own
 * port on loopback, trust auth, and no unix socket. It never touches an existing installation.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const bin = await findBinDir();
  // mkdtemp under the OS temp dir, not the scratchpad: a unix socket path is capped at ~107 bytes
  // and the scratchpad path alone nearly exhausts it. We disable the socket anyway, but initdb and
  // pg_ctl are happier with a short path.
  const dataDir = await mkdtemp(join(tmpdir(), "pm-pg-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);

  await run(join(bin, "initdb"), ["-D", dataDir, "-U", "paymaster", "--auth=trust", "-E", "UTF8"]);

  await run(join(bin, "pg_ctl"), [
    "-D",
    dataDir,
    "-o",
    // TCP on loopback only; no unix socket (path length), no fsync (throwaway data, ~3x faster).
    `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c full_page_writes=off`,
    "-l",
    join(dataDir, "log"),
    "-w",
    "start",
  ]);

  const connectionString = `postgresql://paymaster@127.0.0.1:${port}/postgres`;
  const pool = createPool({connectionString, maxConnections: 5});

  await migrate(pool);

  return {
    pool,
    connectionString,
    stop: async () => {
      await pool.end().catch(() => undefined);
      // -m immediate: this data is disposable and a clean shutdown just costs test time.
      await run(join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"]).catch(() => undefined);
      await rm(dataDir, {recursive: true, force: true}).catch(() => undefined);
    },
  };
}

/** Empties every table, so tests do not depend on each other's rows. */
export async function truncateAll(pool: DatabasePool): Promise<void> {
  await pool.query("TRUNCATE policy_rules, sponsorships, audit_logs, api_keys, policies RESTART IDENTITY CASCADE");
}
