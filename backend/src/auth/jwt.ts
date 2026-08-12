import {createHmac, timingSafeEqual} from "node:crypto";

import {isRole, type Role} from "./permissions.js";
import {TENANT_ID_PATTERN} from "../db/scope.js";

/**
 * Short-lived operator session tokens (HS256 JWTs).
 *
 * td.md lists "JWT admin auth" as distinct from the long-lived API keys: an operator exchanges their
 * key once for a session token that expires in minutes, so the key itself is not sent on every admin
 * request and a leaked session is self-limiting. The token is symmetric (HMAC-SHA256) because the
 * same service signs and verifies it — there is no third party to hand a public key to, so the
 * operational cost of asymmetric keys buys nothing here.
 *
 * Implemented over `node:crypto` rather than a JWT library on purpose: the surface used is tiny
 * (one alg, a handful of claims), and the security-critical parts — rejecting `alg: none`, verifying
 * the signature in constant time, enforcing expiry — are exactly the parts worth being able to read
 * in full. The claim set is deliberately minimal; a session token is not a place to accumulate data.
 */
export interface JwtClaims {
  /** Subject: the api key id this session was minted for. Becomes `Principal.apiKeyId`. */
  readonly sub: string;
  /**
   * The tenant the session acts within, copied from the key it was exchanged for.
   *
   * In the claims rather than looked up on each request, so a session cannot outlive its tenant
   * association — and so a token minted for one tenant can never be replayed against another, since
   * the tenant is inside the signed payload.
   */
  readonly tenantId: string;
  readonly name: string;
  readonly roles: readonly Role[];
  /** The policy the caller's key pins, if any. Carried through so a session behaves like the key. */
  readonly policyId?: string | undefined;
}

export interface VerifiedJwt extends JwtClaims {
  readonly iat: number;
  readonly exp: number;
}

export type JwtVerifyReason =
  "malformed" | "bad-signature" | "expired" | "not-yet-valid" | "wrong-issuer" | "wrong-audience" | "bad-claims";

export type JwtVerifyResult = {ok: true; claims: VerifiedJwt} | {ok: false; reason: JwtVerifyReason};

export interface JwtOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
}

export class JwtService {
  readonly #secret: Buffer;
  readonly #options: JwtOptions;

  constructor(secret: string, options: JwtOptions) {
    // A short HMAC secret is a weak HMAC secret; the env schema enforces a floor, and this is the
    // second line of that defence so a JwtService built directly in a test cannot be trivially weak.
    if (secret.length < 32) throw new Error("JWT secret must be at least 32 characters");
    this.#secret = Buffer.from(secret, "utf8");
    this.#options = options;
  }

  /** Mints a token valid for `ttlSeconds` from `now` (Unix seconds). */
  sign(claims: JwtClaims, now: number = Math.floor(Date.now() / 1000)): {token: string; expiresAt: number} {
    const exp = now + this.#options.ttlSeconds;
    const payload = {
      iss: this.#options.issuer,
      aud: this.#options.audience,
      sub: claims.sub,
      tenantId: claims.tenantId,
      name: claims.name,
      roles: claims.roles,
      ...(claims.policyId === undefined ? {} : {policyId: claims.policyId}),
      iat: now,
      exp,
    };

    const signingInput = `${encode(JWT_HEADER)}.${encode(payload)}`;
    return {token: `${signingInput}.${this.#sign(signingInput)}`, expiresAt: exp};
  }

  verify(token: string, now: number = Math.floor(Date.now() / 1000)): JwtVerifyResult {
    const parts = token.split(".");
    if (parts.length !== 3) return fail("malformed");
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const header = decode(headerB64);
    // Reject anything but our exact header. This is where `alg: none` and algorithm-confusion attacks
    // are stopped: the algorithm is not read from the token and trusted, it is required to equal ours.
    // Bracket access throughout: the decoded object has an index signature (it is untrusted JSON), and
    // `noPropertyAccessFromIndexSignature` rightly forbids dotting into it as if the keys were known.
    if (header === undefined || header["alg"] !== "HS256" || header["typ"] !== "JWT") return fail("malformed");

    // Verify the signature BEFORE trusting any claim in the payload.
    const expected = this.#sign(`${headerB64}.${payloadB64}`);
    if (!constantTimeEqual(signatureB64, expected)) return fail("bad-signature");

    const payload = decode(payloadB64);
    if (payload === undefined) return fail("malformed");

    const iss = payload["iss"];
    const aud = payload["aud"];
    const exp = payload["exp"];
    const iat = payload["iat"];
    const sub = payload["sub"];
    const name = payload["name"];
    const roles = payload["roles"];
    const policyId = payload["policyId"];
    const claimedTenant = payload["tenantId"];

    if (iss !== this.#options.issuer) return fail("wrong-issuer");
    if (aud !== this.#options.audience) return fail("wrong-audience");
    if (typeof exp !== "number" || exp <= now) return fail("expired");
    if (typeof iat === "number" && iat > now + CLOCK_SKEW_SECONDS) return fail("not-yet-valid");

    if (typeof sub !== "string" || typeof name !== "string" || !Array.isArray(roles)) {
      return fail("bad-claims");
    }
    // A token without a tenant is rejected rather than defaulted. Defaulting would silently give an
    // old session — one minted before tenants existed — access to the default tenant's data.
    if (typeof claimedTenant !== "string" || !TENANT_ID_PATTERN.test(claimedTenant)) return fail("bad-claims");
    // Every role must be known: an unknown role in a token must not silently grant nothing (which
    // could bypass a check that expects a role) nor be trusted. Reject the token outright.
    if (!roles.every((r: unknown): r is Role => typeof r === "string" && isRole(r))) return fail("bad-claims");

    return {
      ok: true,
      claims: {
        sub,
        tenantId: claimedTenant,
        name,
        roles: roles as Role[],
        policyId: typeof policyId === "string" ? policyId : undefined,
        iat: typeof iat === "number" ? iat : now,
        exp,
      },
    };
  }

  #sign(signingInput: string): string {
    return createHmac("sha256", this.#secret).update(signingInput).digest("base64url");
  }
}

const JWT_HEADER = {alg: "HS256", typ: "JWT"} as const;
/** Tolerance for a token whose `iat` is slightly ahead of us due to clock drift between hosts. */
const CLOCK_SKEW_SECONDS = 60;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(b64: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Compares two base64url strings without leaking length or content through timing. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; a length check first is not a timing leak because the
  // length of an HMAC-SHA256 digest is fixed, so a wrong length only ever means a malformed token.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function fail(reason: JwtVerifyReason): JwtVerifyResult {
  return {ok: false, reason};
}
