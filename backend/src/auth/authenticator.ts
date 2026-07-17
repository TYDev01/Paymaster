import {hashApiKey, isWellFormedApiKey} from "./apiKey.js";
import {ThrottledLastUsedTracker, type ApiKeyStore} from "./apiKeyStore.js";
import {permissionsFor, type Permission, type Role} from "./permissions.js";

/** An authenticated caller. Everything downstream reads identity from here, never from headers. */
export interface Principal {
  readonly apiKeyId: string;
  readonly name: string;
  readonly roles: readonly Role[];
  readonly permissions: ReadonlySet<Permission>;
  /** The policy this caller's sponsorships are evaluated against, if the key pins one. */
  readonly policyId: string | undefined;
}

export type AuthFailureReason = "missing" | "malformed" | "unknown" | "revoked" | "expired";

export type AuthResult = {ok: true; principal: Principal} | {ok: false; reason: AuthFailureReason};

/** Emitted for every attempt. Failed auth at volume is an attack signal, which td.md asks for. */
export interface AuthObserver {
  onAuthFailure(reason: AuthFailureReason, displayPrefix: string | undefined): void;
  onAuthSuccess(principal: Principal): void;
}

/**
 * Turns a presented credential into a principal.
 *
 * Framework-free, like the rest of the domain: the Nest guard is a thin adapter over this, so the
 * authentication decision is testable without an HTTP server.
 *
 * On failure it reports a coarse reason internally but callers must not return that reason to the
 * client — see `ApiKeyGuard`. "Revoked" versus "unknown" tells an attacker whether a key they hold
 * was ever real.
 */
export class ApiKeyAuthenticator {
  readonly #tracker: ThrottledLastUsedTracker;

  constructor(
    private readonly store: ApiKeyStore,
    private readonly observer?: AuthObserver,
  ) {
    this.#tracker = new ThrottledLastUsedTracker(store);
  }

  async authenticate(presented: string | undefined, now: number): Promise<AuthResult> {
    if (presented === undefined || presented === "") return this.#fail("missing", undefined);

    // Shape-check before hashing: keeps malformed floods off the store.
    if (!isWellFormedApiKey(presented)) return this.#fail("malformed", undefined);

    const record = await this.store.findByHash(hashApiKey(presented));
    if (record === undefined) return this.#fail("unknown", presented.slice(0, 16));

    if (!record.enabled) return this.#fail("revoked", record.displayPrefix);
    if (record.expiresAt !== undefined && record.expiresAt <= now) {
      return this.#fail("expired", record.displayPrefix);
    }

    const principal: Principal = {
      apiKeyId: record.id,
      name: record.name,
      roles: record.roles,
      permissions: permissionsFor(record.roles),
      policyId: record.policyId,
    };

    // Bookkeeping, deliberately not awaited: it must not add latency to the request path.
    this.#tracker.record(record.id, now);
    this.observer?.onAuthSuccess(principal);

    return {ok: true, principal};
  }

  #fail(reason: AuthFailureReason, displayPrefix: string | undefined): AuthResult {
    this.observer?.onAuthFailure(reason, displayPrefix);
    return {ok: false, reason};
  }
}

/**
 * Extracts a credential from request headers.
 *
 * Accepts `Authorization: Bearer <key>` and `X-API-Key: <key>`. Bearer is the convention; the
 * dedicated header exists because some proxies strip or rewrite Authorization.
 */
export function extractApiKey(headers: Readonly<Record<string, string | string[] | undefined>>): string | undefined {
  const authorization = headerValue(headers["authorization"]);
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return headerValue(headers["x-api-key"])?.trim();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
