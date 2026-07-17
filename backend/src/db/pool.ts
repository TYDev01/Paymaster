import pg from "pg";

const {Pool, types} = pg;

/**
 * NUMERIC arrives as a JavaScript string by default, because node-postgres will not silently
 * convert a value that may not survive a float64. That default is right, and we lean on it: wei
 * amounts are read as strings and turned into bigint by the repositories.
 *
 * Explicitly re-registering it documents the dependency. If a future contributor "helpfully" adds
 * a global parser turning NUMERIC into Number, every wei amount above 2^53 silently corrupts —
 * this line and this comment are the tripwire.
 */
const NUMERIC_OID = 1700;
types.setTypeParser(NUMERIC_OID, (value: string) => value);

/**
 * BIGINT (int8) likewise arrives as a string. chain_id fits a float64 comfortably, but ids do not
 * necessarily, and a parser that is correct for one column and wrong for another is worse than no
 * parser. Repositories convert explicitly at the point of use.
 */
const INT8_OID = 20;
types.setTypeParser(INT8_OID, (value: string) => value);

export interface DatabaseConfig {
  readonly connectionString: string;
  /**
   * Maximum pooled connections PER PROCESS. The ceiling that matters is Postgres's global
   * max_connections divided by the number of replicas — a pool sized for a single instance will
   * exhaust the server the moment it scales out.
   */
  readonly maxConnections?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  readonly ssl?: boolean;
}

export type DatabasePool = pg.Pool;

export function createPool(config: DatabaseConfig): DatabasePool {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    ssl: config.ssl === true ? {rejectUnauthorized: true} : undefined,
    // Fail a wedged query rather than holding a connection forever. Every query in this service is
    // a small indexed read or a single-row insert; one taking 15s means something is wrong.
    statement_timeout: 15_000,
    query_timeout: 15_000,
    application_name: "paymaster-backend",
  });

  /**
   * An idle client erroring (the server restarted, a proxy dropped the connection) emits 'error'
   * on the POOL. With no listener, node treats it as an unhandled 'error' event and terminates the
   * process — turning a routine database blip into a crash loop.
   */
  pool.on("error", (error) => {
    // eslint-disable-next-line no-console -- the logger is not available at this layer
    console.error(`[db] idle client error: ${error.message}`);
  });

  return pool;
}

/** Reads a wei amount. NUMERIC comes back as a string precisely so this conversion is explicit. */
export function toWei(value: string): bigint {
  return BigInt(value);
}
