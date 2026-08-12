import type {DatabasePool} from "./pool.js";
import {tenantId, type TenantId} from "./scope.js";

/**
 * Tenants and who may act within them.
 *
 * The one repository that is deliberately NOT `Scope`-parameterised, because it is what ESTABLISHES
 * scope: a caller arriving with a verified identity has no tenant yet, and this is the lookup that
 * gives them one. Every method here therefore takes the identity's `subject` and answers only about
 * that person — which is the same constraint expressed differently.
 */
export type TenantRole = "owner" | "admin" | "member";

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly status: "active" | "suspended";
  readonly createdAt: number;
}

export interface Membership {
  readonly tenant: Tenant;
  readonly role: TenantRole;
}

export class TenantSuspendedError extends Error {
  constructor(id: string) {
    super(`tenant ${id} is suspended`);
    this.name = "TenantSuspendedError";
  }
}

export class TenantRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Every tenant this person belongs to.
   *
   * Returns memberships rather than tenants because the ROLE is what the session needs: the same
   * person may own one organisation and be a read-only member of another, and a session must carry
   * the role for the tenant it was issued against.
   */
  async membershipsFor(subject: string): Promise<readonly Membership[]> {
    const {rows} = await this.pool.query<MembershipRow>(
      `SELECT t.id, t.name, t.status, extract(epoch FROM t.created_at)::bigint AS created_at, m.role
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.subject = $1
        ORDER BY t.created_at`,
      [subject],
    );
    return rows.map(toMembership);
  }

  /** One membership, or undefined when this person is not a member of that tenant. */
  async membership(subject: string, id: TenantId): Promise<Membership | undefined> {
    const {rows} = await this.pool.query<MembershipRow>(
      `SELECT t.id, t.name, t.status, extract(epoch FROM t.created_at)::bigint AS created_at, m.role
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.subject = $1 AND m.tenant_id = $2`,
      [subject, id],
    );
    const row = rows[0];
    return row === undefined ? undefined : toMembership(row);
  }

  /**
   * Creates a tenant with this person as its owner, in one transaction.
   *
   * Both rows or neither: a tenant with no owner is unreachable — nobody can administer it, nobody
   * can delete it, and it would sit in the table forever. That is exactly the kind of orphan a
   * partial failure produces without a transaction.
   */
  async createWithOwner(params: {id: TenantId; name: string; subject: string}): Promise<Tenant> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const {rows} = await client.query<TenantRow>(
        `INSERT INTO tenants (id, name) VALUES ($1, $2)
         RETURNING id, name, status, extract(epoch FROM created_at)::bigint AS created_at`,
        [params.id, params.name],
      );

      await client.query("INSERT INTO tenant_members (tenant_id, subject, role) VALUES ($1, $2, 'owner')", [
        params.id,
        params.subject,
      ]);

      await client.query("COMMIT");
      return toTenant(rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Adds someone to an existing tenant. Idempotent on (tenant, subject): the role is updated. */
  async addMember(id: TenantId, subject: string, role: TenantRole): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_members (tenant_id, subject, role) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, subject) DO UPDATE SET role = EXCLUDED.role`,
      [id, subject, role],
    );
  }

  async get(id: TenantId): Promise<Tenant | undefined> {
    const {rows} = await this.pool.query<TenantRow>(
      `SELECT id, name, status, extract(epoch FROM created_at)::bigint AS created_at
         FROM tenants WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : toTenant(row);
  }

  /**
   * Suspends or reactivates a tenant.
   *
   * Suspension rather than deletion is the whole model: an unpaid subscription must not take the
   * audit trail, the spend history or the customer's own balance with it. See the migration.
   */
  async setStatus(id: TenantId, status: "active" | "suspended"): Promise<boolean> {
    const {rowCount} = await this.pool.query("UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1", [
      id,
      status,
    ]);
    return (rowCount ?? 0) > 0;
  }
}

interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

interface MembershipRow extends TenantRow {
  role: string;
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: tenantId(row.id),
    name: row.name,
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: Number(row.created_at),
  };
}

function toMembership(row: MembershipRow): Membership {
  return {tenant: toTenant(row), role: asRole(row.role)};
}

/** An unknown role in a row grants the least, never the most. */
function asRole(value: string): TenantRole {
  return value === "owner" || value === "admin" ? value : "member";
}
