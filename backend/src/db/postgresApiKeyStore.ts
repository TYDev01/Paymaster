import type {ApiKeyRecord, ApiKeyStore} from "../auth/apiKeyStore.js";
import {isRole, type Role} from "../auth/permissions.js";
import type {DatabasePool} from "./pool.js";

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  display_prefix: string;
  roles: string[];
  policy_id: string | null;
  enabled: boolean;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
}

/**
 * PostgreSQL-backed key store.
 *
 * Every query is parameterised — no string interpolation reaches SQL anywhere in this file, which
 * is what td.md's "SQL injection prevention" amounts to in practice. The `$1` form is not a style
 * choice; it is the whole defence.
 */
export class PostgresApiKeyStore implements ApiKeyStore {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * The request path. One indexed lookup on a UNIQUE column and nothing else — no join, no scan.
   *
   * Filtering on enabled/expiry is deliberately NOT done in SQL: the authenticator distinguishes
   * "unknown" from "revoked" from "expired" for its observer, and a query that returned nothing
   * for all three would erase that signal. The response to the caller is uniform regardless.
   */
  async findByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    const {rows} = await this.pool.query<ApiKeyRow>(
      `SELECT id, name, key_hash, display_prefix, roles, policy_id, enabled, created_at, expires_at, last_used_at
         FROM api_keys
        WHERE key_hash = $1`,
      [hash],
    );
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async create(record: ApiKeyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_keys (id, name, key_hash, display_prefix, roles, policy_id, enabled, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9)`,
      [
        record.id,
        record.name,
        record.hash,
        record.displayPrefix,
        record.roles,
        record.policyId ?? null,
        record.enabled,
        record.createdAt,
        record.expiresAt === undefined ? null : new Date(record.expiresAt * 1000),
      ],
    );
  }

  /**
   * Revocation is a flag, never a DELETE.
   *
   * Sponsorships reference the key that authorised them with ON DELETE RESTRICT: deleting a key
   * would either fail or, without the constraint, orphan the record of who spent the money. A
   * revoked key must stay legible forever.
   *
   * Returns false when the key was already revoked — the WHERE clause makes this idempotent
   * without a read-then-write race.
   */
  async revoke(id: string, now: number): Promise<boolean> {
    const {rowCount} = await this.pool.query(
      `UPDATE api_keys
          SET enabled = false, revoked_at = to_timestamp($2)
        WHERE id = $1 AND enabled`,
      [id, now],
    );
    return (rowCount ?? 0) > 0;
  }

  async list(): Promise<readonly ApiKeyRecord[]> {
    const {rows} = await this.pool.query<ApiKeyRow>(
      `SELECT id, name, key_hash, display_prefix, roles, policy_id, enabled, created_at, expires_at, last_used_at
         FROM api_keys
        ORDER BY created_at DESC`,
    );
    return rows.map(toRecord);
  }

  /**
   * Called from the throttled tracker, not from the request path directly — see
   * ThrottledLastUsedTracker for why this must not be one write per request.
   *
   * `GREATEST` keeps the column monotonic: two replicas can race here, and the older timestamp
   * must not win and make a live key look stale.
   */
  async touch(id: string, now: number): Promise<void> {
    await this.pool.query(
      `UPDATE api_keys
          SET last_used_at = GREATEST(last_used_at, to_timestamp($2))
        WHERE id = $1`,
      [id, now],
    );
  }
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    hash: row.key_hash,
    displayPrefix: row.display_prefix,
    // A role removed from the code but still in a row must not silently grant nothing under a name
    // that looks valid; filtering here means permissionsFor only ever sees roles that exist.
    roles: row.roles.filter((r): r is Role => isRole(r)),
    policyId: row.policy_id ?? undefined,
    enabled: row.enabled,
    createdAt: toUnix(row.created_at),
    expiresAt: row.expires_at === null ? undefined : toUnix(row.expires_at),
    lastUsedAt: row.last_used_at === null ? undefined : toUnix(row.last_used_at),
  };
}

function toUnix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
