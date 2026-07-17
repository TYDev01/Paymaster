import type {Policy} from "../policy/engine.js";
import type {PolicyFactory} from "../policy/policyFactory.js";
import type {PolicyRepository} from "../policy/policySource.js";
import type {DatabasePool} from "./pool.js";

export interface PolicyDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly enabled: boolean;
  readonly rules: readonly {ruleType: string; config: unknown}[];
}

export interface StoredPolicy extends PolicyDefinition {
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class PolicyNotFoundError extends Error {
  constructor(id: string) {
    super(`no policy with id ${id}`);
    this.name = "PolicyNotFoundError";
  }
}

/**
 * Loads policies from PostgreSQL and builds them into rule objects.
 *
 * `load()` is what `PolicySource.reload()` calls, so it runs on a timer and on operator demand.
 * It is one query with a join, not a query per policy: a reload that issues N+1 queries would make
 * reloading expensive enough that operators stop doing it.
 */
export class PostgresPolicyRepository implements PolicyRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly factory: PolicyFactory,
  ) {}

  /**
   * Every enabled policy, with its rules built.
   *
   * A rule that fails to build throws, which fails the whole reload. `PolicySource` then keeps the
   * previous set — so a bad policy row degrades to "stale policy", never to "policy silently
   * missing a rule". See PolicyFactory for why that asymmetry is the safe one.
   */
  async load(): Promise<readonly Policy[]> {
    const {rows} = await this.pool.query<PolicyRow>(
      `SELECT p.id,
              p.name,
              p.description,
              p.enabled,
              extract(epoch FROM p.created_at)::bigint AS created_at,
              extract(epoch FROM p.updated_at)::bigint AS updated_at,
              COALESCE(
                json_agg(
                  json_build_object('ruleType', r.rule_type, 'config', r.config)
                  ORDER BY r.ordinal
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'
              ) AS rules
         FROM policies p
         LEFT JOIN policy_rules r ON r.policy_id = p.id
        WHERE p.enabled
        GROUP BY p.id
        ORDER BY p.id`,
    );

    return rows.map((row) => ({
      id: row.id,
      rules: row.rules.map((spec) => this.factory.build(row.id, spec)),
    }));
  }

  /** Definitions rather than built rules, for the admin API to display and edit. */
  async list(): Promise<readonly StoredPolicy[]> {
    const {rows} = await this.pool.query<PolicyRow>(
      `SELECT p.id,
              p.name,
              p.description,
              p.enabled,
              extract(epoch FROM p.created_at)::bigint AS created_at,
              extract(epoch FROM p.updated_at)::bigint AS updated_at,
              COALESCE(
                json_agg(
                  json_build_object('ruleType', r.rule_type, 'config', r.config)
                  ORDER BY r.ordinal
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'
              ) AS rules
         FROM policies p
         LEFT JOIN policy_rules r ON r.policy_id = p.id
        GROUP BY p.id
        ORDER BY p.id`,
    );
    return rows.map(toStored);
  }

  async get(id: string): Promise<StoredPolicy> {
    const all = await this.list();
    const found = all.find((p) => p.id === id);
    if (found === undefined) throw new PolicyNotFoundError(id);
    return found;
  }

  /**
   * Creates or replaces a policy and its rules, in one transaction.
   *
   * Rules are deleted and re-inserted rather than diffed. A policy has a handful of rules, so the
   * churn is irrelevant — and diffing would introduce an intermediate state where the policy is
   * partially updated. Inside a transaction no reader ever sees that, but only because the whole
   * thing commits at once.
   *
   * The rules are validated by building them BEFORE the transaction opens: a config that cannot
   * produce a working rule must be rejected at the API boundary, not written and then discovered
   * at the next reload — by which point the operator who wrote it is gone and the policy silently
   * stops loading.
   */
  async upsert(definition: PolicyDefinition): Promise<void> {
    for (const rule of definition.rules) {
      this.factory.build(definition.id, rule);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO policies (id, name, description, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
            SET name = EXCLUDED.name,
                description = EXCLUDED.description,
                enabled = EXCLUDED.enabled,
                updated_at = now()`,
        [definition.id, definition.name, definition.description ?? null, definition.enabled],
      );

      await client.query("DELETE FROM policy_rules WHERE policy_id = $1", [definition.id]);

      for (const [ordinal, rule] of definition.rules.entries()) {
        await client.query(
          `INSERT INTO policy_rules (policy_id, ordinal, rule_type, config) VALUES ($1, $2, $3, $4::jsonb)`,
          [definition.id, ordinal, rule.ruleType, JSON.stringify(rule.config ?? {})],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Deletes a policy. Rules cascade; keys do not.
   *
   * A policy still pinned by an API key fails on the foreign key, deliberately. See the migration:
   * silently unpinning those keys would let them fall back to naming any policy they like.
   */
  async delete(id: string): Promise<boolean> {
    const {rowCount} = await this.pool.query("DELETE FROM policies WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }
}

interface PolicyRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  rules: {ruleType: string; config: unknown}[];
}

function toStored(row: PolicyRow): StoredPolicy {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled,
    rules: row.rules,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
