import type {Role} from "./permissions.js";
import type {Scope, TenantId} from "../db/scope.js";

/**
 * A key as stored. Contains no recoverable credential — only the hash.
 */
export interface ApiKeyRecord {
  readonly id: string;
  /**
   * The tenant this key belongs to. Established when the key is looked up, and carried into the
   * principal — this is the point where an anonymous HTTP request becomes attributable to a
   * customer, so everything downstream can be scoped from it.
   */
  readonly tenantId: TenantId;
  /** Human label, for the admin list. Not used in authorisation. */
  readonly name: string;
  readonly hash: string;
  readonly displayPrefix: string;
  readonly roles: readonly Role[];
  /** Which policy this key's sponsorships are evaluated against. */
  readonly policyId: string | undefined;
  readonly enabled: boolean;
  readonly createdAt: number;
  /** Unix seconds. Undefined means no expiry — discouraged, but some integrations need it. */
  readonly expiresAt: number | undefined;
  readonly lastUsedAt: number | undefined;
}

export interface ApiKeyStore {
  /**
   * Looks a key up by the hash of the presented secret.
   *
   * By hash, never by id-then-compare: an exact-match index lookup performs the comparison inside
   * the store and never brings a stored hash into application code where someone might `===` it.
   */
  findByHash(hash: string): Promise<ApiKeyRecord | undefined>;

  /**
   * Administrative reads and writes, always scoped.
   *
   * `findByHash` above is deliberately NOT scoped: it is the request path, and at that moment the
   * caller's tenant is unknown — the key is what establishes it. These, by contrast, are called
   * from an already-authenticated context, so the scope is known and must be applied, or one
   * tenant can list and revoke another's credentials.
   */
  create(scope: Scope, record: Omit<ApiKeyRecord, "tenantId">): Promise<void>;
  revoke(scope: Scope, id: string, now: number): Promise<boolean>;
  list(scope: Scope): Promise<readonly ApiKeyRecord[]>;

  /**
   * Records that a key was used.
   *
   * Called on the request path, so implementations MUST be cheap and MUST NOT be awaited by the
   * caller in a way that adds latency. A naive implementation writes to the database on every
   * request, turning a read-only auth check into a write amplification of one row per sponsorship.
   * See `ThrottledLastUsedTracker`.
   */
  touch(id: string, now: number): Promise<void>;
}

/**
 * Collapses `lastUsedAt` writes so a hot key does not produce a write per request.
 *
 * `lastUsedAt` exists to answer "is this key still in use?" before revoking it. That question does
 * not need second-level precision, so writes are throttled to at most one per key per interval.
 * At thousands of operations per minute the naive version would be one of the heaviest write loads
 * in the system, in service of a field nobody reads in real time.
 */
export class ThrottledLastUsedTracker {
  readonly #lastWritten = new Map<string, number>();

  constructor(
    private readonly store: Pick<ApiKeyStore, "touch">,
    private readonly intervalSeconds = 60,
  ) {}

  /**
   * Fire-and-forget. Never rejects: a failed bookkeeping write must not fail an otherwise valid
   * request, and must not surface as an unhandled rejection either.
   */
  record(id: string, now: number): void {
    const last = this.#lastWritten.get(id);
    if (last !== undefined && now - last < this.intervalSeconds) return;

    this.#lastWritten.set(id, now);
    void this.store.touch(id, now).catch(() => {
      // Allow a retry on the next request rather than suppressing writes for a whole interval.
      this.#lastWritten.delete(id);
    });
  }
}
