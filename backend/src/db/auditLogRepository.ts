import type {DatabasePool} from "./pool.js";

export interface AuditEntry {
  /** An api key id, an admin id, or "system" for automated action. */
  readonly actor: string;
  readonly action: string;
  readonly subject?: string | undefined;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
  readonly clientIp?: string | undefined;
}

export interface StoredAuditEntry extends AuditEntry {
  readonly id: bigint;
  readonly createdAt: number;
}

export interface AuditQuery {
  readonly actor?: string;
  readonly action?: string;
  readonly since?: number;
  readonly limit?: number;
}

/**
 * Keys whose values are redacted before an entry is written.
 *
 * An audit log is a high-value target: it records exactly what an operator did, which means a
 * careless `detail` payload is where a rotated API key or a signer key ends up sitting in plain
 * text forever. Redaction happens at the write, not the read — a secret that reaches the table is
 * already leaked, and no amount of careful querying afterwards undoes it.
 */
const REDACTED_KEYS = ["secret", "key", "apikey", "api_key", "password", "token", "privatekey", "private_key"];
const REDACTED = "[redacted]";

/**
 * Append-only audit trail.
 *
 * There is no update and no delete, and none should be added: a log that can be edited is not
 * evidence. Retention is a database concern (partition drop, or a scheduled purge with its own
 * audited grant), not something this class should offer a method for.
 */
export class AuditLogRepository {
  constructor(private readonly pool: DatabasePool) {}

  async record(entry: AuditEntry): Promise<bigint> {
    const {rows} = await this.pool.query<{id: string}>(
      `INSERT INTO audit_logs (actor, action, subject, detail, client_ip)
       VALUES ($1, $2, $3, $4::jsonb, $5::inet)
       RETURNING id`,
      [
        entry.actor,
        entry.action,
        entry.subject ?? null,
        JSON.stringify(redact(entry.detail ?? {})),
        entry.clientIp ?? null,
      ],
    );
    return BigInt(rows[0]!.id);
  }

  async list(query: AuditQuery = {}): Promise<readonly StoredAuditEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.actor !== undefined) {
      params.push(query.actor);
      conditions.push(`actor = $${params.length}`);
    }
    if (query.action !== undefined) {
      params.push(query.action);
      conditions.push(`action = $${params.length}`);
    }
    if (query.since !== undefined) {
      params.push(query.since);
      conditions.push(`created_at >= to_timestamp($${params.length})`);
    }

    params.push(Math.min(query.limit ?? 100, 1_000));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const {rows} = await this.pool.query<AuditRow>(
      `SELECT id, actor, action, subject, detail, host(client_ip) AS client_ip, created_at
         FROM audit_logs ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );

    return rows.map((row) => ({
      id: BigInt(row.id),
      actor: row.actor,
      action: row.action,
      subject: row.subject ?? undefined,
      detail: row.detail,
      clientIp: row.client_ip ?? undefined,
      createdAt: Math.floor(row.created_at.getTime() / 1000),
    }));
  }
}

/** Recursively replaces sensitive values. Matching is on the KEY, case- and separator-insensitive. */
function redact(value: unknown, depth = 0): unknown {
  // Bounds a hostile or cyclic payload; nothing legitimate here is this deep.
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitive(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

function isSensitive(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, "");
  return REDACTED_KEYS.some((sensitive) => normalised.includes(sensitive.replace(/_/g, "")));
}

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  subject: string | null;
  detail: Record<string, unknown>;
  client_ip: string | null;
  created_at: Date;
}
