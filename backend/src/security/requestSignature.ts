import {createHmac, timingSafeEqual} from "node:crypto";

/**
 * HMAC request signing — integrity and authenticity over the request body, td.md's "request signing".
 *
 * A bearer token proves *who* is calling; it does not prove the body was not altered in transit by
 * anything that holds the token (a logging proxy, a compromised gateway). An HMAC over the body,
 * bound to the method, path, and a timestamp, does: only a holder of the shared secret can produce
 * it, and it covers exactly the bytes the server will act on.
 *
 * The signed payload is a canonical, unambiguous string — `timestamp\nMETHOD\npath\nbody` — so the
 * client and server hash identical bytes. Signing the raw body (not a re-serialisation) is essential:
 * two JSON encodings of the same object differ, and a signature over one would not verify the other.
 *
 * Replay is bounded by a freshness window on the timestamp: a captured request is only replayable for
 * `maxSkewSeconds`. That is a window, not elimination — full elimination needs a single-use nonce
 * store, which is a heavier mechanism than most deployments need; the short window is the usual,
 * proportionate defence and is documented as such.
 */
export interface SignedRequest {
  readonly method: string;
  readonly path: string;
  /** Value of the timestamp header, unix seconds as a string. */
  readonly timestamp: string;
  /** The raw request body bytes, exactly as received. */
  readonly body: string;
  /** Value of the signature header: lowercase hex of the HMAC-SHA256. */
  readonly signature: string;
}

export type SignatureVerifyReason = "missing" | "malformed-timestamp" | "stale" | "bad-signature";
export type SignatureResult = {ok: true} | {ok: false; reason: SignatureVerifyReason};

export class RequestSignatureVerifier {
  readonly #secret: Buffer;
  readonly #maxSkewSeconds: number;

  constructor(secret: string, options: {maxSkewSeconds: number}) {
    if (secret.length < 32) throw new Error("request signing secret must be at least 32 characters");
    this.#secret = Buffer.from(secret, "utf8");
    this.#maxSkewSeconds = options.maxSkewSeconds;
  }

  verify(request: SignedRequest, now: number): SignatureResult {
    if (request.signature === "" || request.timestamp === "") return {ok: false, reason: "missing"};

    const ts = Number(request.timestamp);
    if (!Number.isFinite(ts) || !Number.isInteger(ts)) return {ok: false, reason: "malformed-timestamp"};
    // Reject both a stale timestamp (replay) and one implausibly far in the future (clock games).
    if (Math.abs(now - ts) > this.#maxSkewSeconds) return {ok: false, reason: "stale"};

    const expected = this.sign(request);
    return constantTimeEqualHex(request.signature, expected) ? {ok: true} : {ok: false, reason: "bad-signature"};
  }

  /** Computes the expected signature. Exposed so a client (or a test) signs identically to verify. */
  sign(request: Pick<SignedRequest, "method" | "path" | "timestamp" | "body">): string {
    const canonical = `${request.timestamp}\n${request.method.toUpperCase()}\n${request.path}\n${request.body}`;
    return createHmac("sha256", this.#secret).update(canonical, "utf8").digest("hex");
  }
}

/** Constant-time hex comparison; a length mismatch is a definite non-match and safe to short-circuit. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    // `a` was not valid hex (odd length or non-hex chars): not a signature we produced.
    return false;
  }
}
