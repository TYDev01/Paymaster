import type {Policy} from "./engine.js";
import {PLATFORM_SCOPE, type Scope, type TenantId} from "../db/scope.js";

/** Where policy definitions come from. The database adapter implements this. */
export interface PolicyRepository {
  /** Loads the full policy set. Called on every reload, so it must be cheap enough to poll. */
  load(scope: Scope): Promise<readonly Policy[]>;
}

export class UnknownPolicyError extends Error {
  constructor(id: string) {
    super(`no policy with id ${id}`);
    this.name = "UnknownPolicyError";
  }
}

/**
 * The in-memory key.
 *
 * Composite because a policy id is unique per tenant, not globally: two tenants both calling their
 * policy "default" is the expected case, not a collision. Keying by id alone would silently let
 * whichever loaded last serve BOTH tenants — a cross-tenant authorisation bug with no error
 * anywhere, which is exactly the failure this key shape makes unrepresentable.
 */
function keyOf(tenantId: TenantId, policyId: string): string {
  return `${tenantId}\u0000${policyId}`;
}

/**
 * Holds the active policy set and swaps it atomically on reload — td.md's "hot reloadable".
 *
 * Reload replaces one immutable Map with another in a single assignment. There is no window during
 * which the set is partially updated, and an evaluation already in flight keeps the snapshot it
 * started with. That last part matters: a policy that changed underneath a request could approve
 * against one rule set and reserve budget against another.
 *
 * A failed reload leaves the previous set in place. Serving a slightly stale policy is strictly
 * better than a paymaster that stops sponsoring because the policy database blipped — but note the
 * asymmetry, because it cuts the other way for revocation: a blocklist addition does not take
 * effect until a reload succeeds. Operators revoking access urgently should pause the paymaster
 * on-chain, which is immediate, rather than rely on policy propagation.
 */
export class PolicySource {
  #policies: ReadonlyMap<string, Policy> = new Map();
  #loadedAt = 0;
  #generation = 0;

  constructor(private readonly repository: PolicyRepository) {}

  /**
   * Loads every tenant's policies.
   *
   * Platform scope, deliberately: this is the process-wide cache that serves every request, and a
   * per-tenant reload would mean a query per tenant per interval. Requests are scoped when they
   * READ from it — see `get`.
   */
  async reload(now: number = Math.floor(Date.now() / 1000)): Promise<PolicyReloadResult> {
    const loaded = await this.repository.load(PLATFORM_SCOPE);

    const next = new Map<string, Policy>();
    for (const policy of loaded) {
      const key = keyOf(policy.tenantId, policy.id);
      if (next.has(key)) {
        // Ambiguous config: which duplicate wins would decide who gets sponsored.
        throw new Error(`duplicate policy id in policy set: ${policy.tenantId}/${policy.id}`);
      }
      next.set(key, policy);
    }

    // Single assignment: readers see either the whole old set or the whole new one.
    this.#policies = next;
    this.#loadedAt = now;
    this.#generation++;

    return {count: next.size, generation: this.#generation, loadedAt: now};
  }

  /**
   * One tenant's policy.
   *
   * The tenant is required, not optional with a fallback: an optional tenant would make "any
   * tenant's policy called X" reachable by omitting an argument, which is the bug this whole slice
   * exists to prevent. A policy belonging to another tenant is reported as UNKNOWN rather than
   * forbidden — the caller learns nothing about what other tenants have configured.
   */
  get(tenantId: TenantId, id: string): Policy {
    const policy = this.#policies.get(keyOf(tenantId, id));
    if (policy === undefined) throw new UnknownPolicyError(id);
    return policy;
  }

  has(tenantId: TenantId, id: string): boolean {
    return this.#policies.has(keyOf(tenantId, id));
  }

  /**
   * A snapshot of the loaded set. Safe to hold across awaits; a concurrent reload swaps the map
   * rather than mutating it, so a holder keeps the set it started with.
   *
   * Returns policies rather than the internal map: the map's keys are a composite encoding of
   * (tenant, id), and a caller that indexed into it would depend on that encoding — which is an
   * implementation detail, and one that has already changed once.
   */
  snapshot(): readonly Policy[] {
    return [...this.#policies.values()];
  }

  get generation(): number {
    return this.#generation;
  }

  get loadedAt(): number {
    return this.#loadedAt;
  }
}

export interface PolicyReloadResult {
  readonly count: number;
  readonly generation: number;
  readonly loadedAt: number;
}
