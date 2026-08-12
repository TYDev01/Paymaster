import type {ApiKeyRecord, ApiKeyStore} from "./apiKeyStore.js";
import {isPlatform, writingTenant, type Scope} from "../db/scope.js";

/**
 * API key store held in process memory.
 *
 * Real and correct for a single process; the PostgreSQL adapter will implement the same port.
 * Keys are indexed by hash, which is exactly how the SQL version should be indexed too — the
 * lookup on the request path must be a single exact-match index hit, never a scan.
 */
export class InMemoryApiKeyStore implements ApiKeyStore {
  readonly #byHash = new Map<string, ApiKeyRecord>();
  readonly #byId = new Map<string, ApiKeyRecord>();

  constructor(seed: readonly ApiKeyRecord[] = []) {
    for (const record of seed) this.#index(record);
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    return this.#byHash.get(hash);
  }

  async create(scope: Scope, input: Omit<ApiKeyRecord, "tenantId">): Promise<void> {
    // The tenant comes from the scope, exactly as in the SQL store — the two implementations must
    // agree on this or the in-memory deployment would have a weaker boundary than the real one.
    const record: ApiKeyRecord = {...input, tenantId: writingTenant(scope, "create an api key")};
    if (this.#byId.has(record.id)) throw new Error(`api key ${record.id} already exists`);
    // A hash collision here means the same secret was issued twice, which a CSPRNG makes
    // impossible — but if it ever happened, silently overwriting would orphan the first key.
    if (this.#byHash.has(record.hash)) throw new Error("api key hash collision");
    this.#index(record);
  }

  async revoke(scope: Scope, id: string, _now: number): Promise<boolean> {
    const record = this.#byId.get(id);
    if (record === undefined || !record.enabled) return false;
    // Indistinguishable from "already revoked", for the same reason as the SQL store: a different
    // answer for another tenant's id would let one tenant probe for another's key ids.
    if (!this.#inScope(scope, record)) return false;
    this.#index({...record, enabled: false});
    return true;
  }

  async list(scope: Scope): Promise<readonly ApiKeyRecord[]> {
    return [...this.#byId.values()].filter((record) => this.#inScope(scope, record));
  }

  #inScope(scope: Scope, record: ApiKeyRecord): boolean {
    return isPlatform(scope) || record.tenantId === scope.tenantId;
  }

  async touch(id: string, now: number): Promise<void> {
    const record = this.#byId.get(id);
    if (record === undefined) return;
    this.#index({...record, lastUsedAt: now});
  }

  #index(record: ApiKeyRecord): void {
    this.#byHash.set(record.hash, record);
    this.#byId.set(record.id, record);
  }
}
