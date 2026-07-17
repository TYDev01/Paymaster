import type {ApiKeyRecord, ApiKeyStore} from "./apiKeyStore.js";

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

  async create(record: ApiKeyRecord): Promise<void> {
    if (this.#byId.has(record.id)) throw new Error(`api key ${record.id} already exists`);
    // A hash collision here means the same secret was issued twice, which a CSPRNG makes
    // impossible — but if it ever happened, silently overwriting would orphan the first key.
    if (this.#byHash.has(record.hash)) throw new Error("api key hash collision");
    this.#index(record);
  }

  async revoke(id: string, _now: number): Promise<boolean> {
    const record = this.#byId.get(id);
    if (record === undefined || !record.enabled) return false;
    this.#index({...record, enabled: false});
    return true;
  }

  async list(): Promise<readonly ApiKeyRecord[]> {
    return [...this.#byId.values()];
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
