import type {Policy} from "./engine.js";

/** Where policy definitions come from. The database adapter implements this. */
export interface PolicyRepository {
  /** Loads the full policy set. Called on every reload, so it must be cheap enough to poll. */
  load(): Promise<readonly Policy[]>;
}

export class UnknownPolicyError extends Error {
  constructor(id: string) {
    super(`no policy with id ${id}`);
    this.name = "UnknownPolicyError";
  }
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

  async reload(now: number = Math.floor(Date.now() / 1000)): Promise<PolicyReloadResult> {
    const loaded = await this.repository.load();

    const next = new Map<string, Policy>();
    for (const policy of loaded) {
      if (next.has(policy.id)) {
        // Ambiguous config: which duplicate wins would decide who gets sponsored.
        throw new Error(`duplicate policy id in policy set: ${policy.id}`);
      }
      next.set(policy.id, policy);
    }

    // Single assignment: readers see either the whole old set or the whole new one.
    this.#policies = next;
    this.#loadedAt = now;
    this.#generation++;

    return {count: next.size, generation: this.#generation, loadedAt: now};
  }

  get(id: string): Policy {
    const policy = this.#policies.get(id);
    if (policy === undefined) throw new UnknownPolicyError(id);
    return policy;
  }

  has(id: string): boolean {
    return this.#policies.has(id);
  }

  /** A snapshot reference. Safe to hold across awaits; a concurrent reload will not mutate it. */
  snapshot(): ReadonlyMap<string, Policy> {
    return this.#policies;
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
