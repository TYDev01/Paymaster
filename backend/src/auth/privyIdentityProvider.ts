import {createPublicKey, verify as verifySignature, type KeyObject} from "node:crypto";

import type {IdentityProvider, IdentityResult, VerifiedIdentity} from "./identity.js";

/**
 * Verifies a Privy access token.
 *
 * Privy issues an ES256 JWT signed with a key published in the app's JWKS. Verification is
 * therefore standard: fetch the JWKS, find the key the token's `kid` names, check the signature,
 * then check the claims. That is done here directly rather than through a JWT library, for the same
 * reason the operator session JWT is hand-rolled — this is the code that decides who someone is, in
 * a service that spends money, and it is worth being able to read all of it.
 *
 * Two details that are easy to get wrong and are the reason this file exists at all:
 *
 *   * **ES256 signatures in a JWS are raw `r || s`**, not the DER encoding OpenSSL produces by
 *     default. Node needs `dsaEncoding: "ieee-p1363"` to check them. Without it every valid token is
 *     rejected — which fails safe, but fails.
 *   * **The `kid` must select the key.** Trying every key in the set until one verifies would still
 *     be sound, but honouring `kid` keeps rotation cheap and makes an unknown key a distinct,
 *     loggable outcome rather than a generic signature failure.
 *
 * The JWKS is cached, because fetching it on every dashboard request would put an external service
 * on the critical path of every page load. A `kid` that is not in the cache forces one refresh —
 * that is how key rotation is picked up without restarting — and the refresh is rate-limited so an
 * attacker cannot turn unknown-kid tokens into a request amplifier against the provider.
 */
export interface PrivyOptions {
  /** The Privy app id. Tokens are checked to have been issued FOR this application. */
  readonly appId: string;
  /** JWKS endpoint. Defaults to Privy's for the app id. */
  readonly jwksUrl?: string | undefined;
  /** Expected `iss`. Configurable so a test — or a future provider change — need not be rewritten. */
  readonly issuer?: string | undefined;
  readonly cacheTtlMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

/** The slice of a JWKS this needs. Extra members are ignored. */
export interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

export type JwksFetcher = () => Promise<{keys: Jwk[]}>;

const DEFAULT_ISSUER = "privy.io";
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Floor between refreshes forced by an unknown `kid`.
 *
 * Two seconds is a deliberate balance. It has to exist at all, or an attacker sending tokens with
 * random `kid`s turns this service into a request amplifier against the provider. It has to be
 * SHORT, because the same path is how a legitimate key rotation is picked up — a long floor means
 * every customer is locked out of their dashboard for that long after the provider rotates. Two
 * seconds collapses a flood to roughly one fetch per two seconds while making rotation recovery
 * imperceptible.
 */
const MIN_REFRESH_INTERVAL_MS = 2_000;

export class PrivyIdentityProvider implements IdentityProvider {
  readonly #options: Required<Pick<PrivyOptions, "appId">> & {
    jwksUrl: string;
    issuer: string;
    cacheTtlMs: number;
    timeoutMs: number;
  };
  readonly #fetchJwks: JwksFetcher;
  readonly #now: () => number;
  readonly #nowMs: () => number;

  #keys = new Map<string, KeyObject>();
  #fetchedAt = 0;
  #inFlight: Promise<void> | undefined;

  constructor(options: PrivyOptions, deps: {fetchJwks?: JwksFetcher; now?: () => number; nowMs?: () => number} = {}) {
    this.#options = {
      appId: options.appId,
      jwksUrl: options.jwksUrl ?? `https://auth.privy.io/api/v1/apps/${options.appId}/jwks.json`,
      issuer: options.issuer ?? DEFAULT_ISSUER,
      cacheTtlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      timeoutMs: options.timeoutMs ?? 5_000,
    };
    this.#fetchJwks = deps.fetchJwks ?? (() => this.#defaultFetch());
    this.#now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    // Separate from `now` because one measures token expiry in seconds and the other measures cache
    // age in milliseconds. Injectable so a test can advance the cache clock without waiting.
    this.#nowMs = deps.nowMs ?? (() => Date.now());
  }

  async verify(token: string): Promise<IdentityResult> {
    const parts = token.split(".");
    if (parts.length !== 3) return {ok: false, reason: "malformed"};
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const header = decodeJson(headerB64);
    if (header === undefined) return {ok: false, reason: "malformed"};
    // The algorithm is REQUIRED to be ES256, never read from the token and trusted. This is where
    // `alg: none` and algorithm-confusion attacks are refused.
    if (header["alg"] !== "ES256" || typeof header["kid"] !== "string") {
      return {ok: false, reason: "malformed"};
    }

    const key = await this.#keyFor(header["kid"]);
    if (key === undefined) return {ok: false, reason: "unknown-key"};

    const signature = Buffer.from(signatureB64, "base64url");
    const signed = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");

    let valid: boolean;
    try {
      // ieee-p1363: a JWS carries the raw r||s pair, not DER. See the note at the top.
      valid = verifySignature("sha256", signed, {key, dsaEncoding: "ieee-p1363"}, signature);
    } catch {
      return {ok: false, reason: "bad-signature"};
    }
    // Claims are read only AFTER the signature holds. Reading them first would mean acting on
    // attacker-controlled values.
    if (!valid) return {ok: false, reason: "bad-signature"};

    const payload = decodeJson(payloadB64);
    if (payload === undefined) return {ok: false, reason: "malformed"};

    const {iss, aud, sub, exp} = payload as Record<string, unknown>;
    if (iss !== this.#options.issuer) return {ok: false, reason: "wrong-issuer"};
    // A token minted for another Privy application is signed by a key we might legitimately trust,
    // so the audience check is what stops it authenticating here.
    if (!audienceMatches(aud, this.#options.appId)) return {ok: false, reason: "wrong-audience"};
    if (typeof sub !== "string" || sub === "") return {ok: false, reason: "malformed"};
    if (typeof exp !== "number" || exp <= this.#now()) return {ok: false, reason: "expired"};

    const identity: VerifiedIdentity = {
      subject: sub,
      email: typeof payload["email"] === "string" ? payload["email"] : undefined,
      expiresAt: exp,
    };
    return {ok: true, identity};
  }

  /**
   * The key for a `kid`, refreshing the set once if it is unknown or stale.
   *
   * Concurrent refreshes are collapsed into one in-flight request: a burst of dashboard loads after
   * a key rotation would otherwise each fetch the JWKS.
   */
  async #keyFor(kid: string): Promise<KeyObject | undefined> {
    const age = this.#nowMs() - this.#fetchedAt;
    const stale = age > this.#options.cacheTtlMs;
    const known = this.#keys.has(kid);

    if (!known || stale) {
      const canRefresh = known ? stale : age > MIN_REFRESH_INTERVAL_MS || this.#fetchedAt === 0;
      if (canRefresh) await this.#refresh();
    }
    return this.#keys.get(kid);
  }

  async #refresh(): Promise<void> {
    this.#inFlight ??= (async () => {
      try {
        const jwks = await this.#fetchJwks();
        const keys = new Map<string, KeyObject>();
        for (const jwk of jwks.keys ?? []) {
          // Only P-256 EC keys are usable for ES256. Anything else in the set is skipped rather
          // than imported and later failing in a less obvious place.
          if (jwk.kid === undefined || jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
          try {
            keys.set(jwk.kid, createPublicKey({key: jwk as never, format: "jwk"}));
          } catch {
            // A malformed key in the set must not discard the good ones alongside it.
          }
        }
        // Replaced wholesale rather than merged: a key REMOVED from the published set has been
        // retired, and merging would keep honouring it indefinitely.
        if (keys.size > 0) {
          this.#keys = keys;
          this.#fetchedAt = this.#nowMs();
        }
      } catch {
        // Leaves the previous cache in place. An unreachable provider degrades to "tokens signed
        // with keys we already know still work", which is strictly better than rejecting everyone.
      } finally {
        this.#inFlight = undefined;
      }
    })();
    await this.#inFlight;
  }

  async #defaultFetch(): Promise<{keys: Jwk[]}> {
    const response = await fetch(this.#options.jwksUrl, {
      signal: AbortSignal.timeout(this.#options.timeoutMs),
    });
    if (!response.ok) throw new Error(`jwks endpoint returned ${response.status}`);
    return (await response.json()) as {keys: Jwk[]};
  }
}

/** `aud` may be a string or an array of strings, per the JWT specification. */
function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

function decodeJson(segment: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
