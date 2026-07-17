import {createHash, randomBytes, timingSafeEqual} from "node:crypto";

/**
 * API key generation and verification.
 *
 * # Why SHA-256 and not bcrypt/argon2
 *
 * Slow password hashes exist to defend LOW-ENTROPY secrets against offline brute force: a human
 * password has maybe 30 bits, so you make each guess expensive. An API key here is 256 bits from a
 * CSPRNG. There is no dictionary and no brute force to slow down — an attacker with the hash
 * database gains nothing from a fast hash, because 2^256 guesses at any speed is 2^256 guesses.
 *
 * Meanwhile bcrypt on the request path would be a self-inflicted denial of service: td.md targets
 * thousands of operations per minute, and a deliberately-slow hash per request is a CPU bill and a
 * latency floor bought for a threat that does not apply. Fast hashing of a high-entropy secret is
 * the correct choice, not a shortcut.
 *
 * The property that actually matters is that the RAW KEY IS NEVER STORED. We store its SHA-256 and
 * look up by that hash, so a database dump yields no usable credential.
 */

/** Distinguishes real keys from test keys at a glance, and makes secret scanners able to spot them. */
export type KeyEnvironment = "live" | "test";

const PREFIX = "pm";
const SECRET_BYTES = 32;

/** Characters shown to identify a key without revealing it, e.g. in an admin list. */
const DISPLAY_PREFIX_LENGTH = 16;

export interface GeneratedApiKey {
  /**
   * The full key. Returned exactly once, at creation, and never recoverable afterwards — we keep
   * only its hash. An operator who loses it must issue a new one.
   */
  readonly secret: string;
  readonly hash: string;
  /** A non-secret fragment for display and support ("which key is failing?"). */
  readonly displayPrefix: string;
}

export function generateApiKey(environment: KeyEnvironment = "live"): GeneratedApiKey {
  // base64url: URL-safe, header-safe, and no padding to be mangled in transit.
  const secret = `${PREFIX}_${environment}_${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return {
    secret,
    hash: hashApiKey(secret),
    displayPrefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

const KEY_PATTERN = new RegExp(`^${PREFIX}_(live|test)_[A-Za-z0-9_-]{40,}$`);

/**
 * Cheap shape check before hashing and hitting the store.
 *
 * Rejecting obvious junk early keeps a flood of malformed headers from turning into store lookups,
 * and it is safe to do without constant time: the key's shape is not the secret.
 */
export function isWellFormedApiKey(candidate: string): boolean {
  return KEY_PATTERN.test(candidate);
}

/**
 * Constant-time hash comparison.
 *
 * Store lookups are by exact hash match and do the comparison themselves, so this is for
 * implementations that must compare in application code. Included because the obvious `===` on a
 * hash is a timing oracle, and the next person to write a store adapter should have this to hand
 * rather than reach for the obvious thing.
 */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself be a length oracle.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
