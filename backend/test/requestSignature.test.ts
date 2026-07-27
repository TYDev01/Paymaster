import {describe, expect, it} from "vitest";

import {RequestSignatureVerifier, type SignedRequest} from "../src/security/requestSignature.js";

const SECRET = "x".repeat(40);
const NOW = 1_700_000_000;

function verifier(maxSkewSeconds = 300): RequestSignatureVerifier {
  return new RequestSignatureVerifier(SECRET, {maxSkewSeconds});
}

function signed(over: Partial<SignedRequest> = {}): SignedRequest {
  const v = verifier();
  const base = {method: "POST", path: "/paymaster/sponsor", timestamp: String(NOW), body: '{"chainId":8453}'};
  const merged = {...base, ...over};
  return {...merged, signature: over.signature ?? v.sign(merged)};
}

describe("RequestSignatureVerifier", () => {
  it("accepts a correctly signed request", () => {
    expect(verifier().verify(signed(), NOW)).toEqual({ok: true});
  });

  it("rejects a tampered body", () => {
    const req = signed();
    expect(verifier().verify({...req, body: '{"chainId":1}'}, NOW)).toEqual({ok: false, reason: "bad-signature"});
  });

  it("rejects a tampered method or path", () => {
    const req = signed();
    expect(verifier().verify({...req, method: "GET"}, NOW)).toEqual({ok: false, reason: "bad-signature"});
    expect(verifier().verify({...req, path: "/admin/keys"}, NOW)).toEqual({ok: false, reason: "bad-signature"});
  });

  it("rejects a signature from a different secret", () => {
    const other = new RequestSignatureVerifier("y".repeat(40), {maxSkewSeconds: 300});
    const req = signed({signature: "placeholder"});
    const forged = {...req, signature: other.sign(req)};
    expect(verifier().verify(forged, NOW)).toEqual({ok: false, reason: "bad-signature"});
  });

  it("rejects a stale timestamp (replay window)", () => {
    expect(verifier(300).verify(signed({timestamp: String(NOW - 301)}), NOW)).toEqual({ok: false, reason: "stale"});
  });

  it("rejects a timestamp too far in the future", () => {
    expect(verifier(300).verify(signed({timestamp: String(NOW + 600)}), NOW)).toEqual({ok: false, reason: "stale"});
  });

  it("accepts within the skew window", () => {
    expect(verifier(300).verify(signed({timestamp: String(NOW - 299)}), NOW).ok).toBe(true);
  });

  it("reports missing headers distinctly from a bad signature", () => {
    expect(verifier().verify({...signed(), signature: ""}, NOW)).toEqual({ok: false, reason: "missing"});
    expect(verifier().verify({...signed(), timestamp: ""}, NOW)).toEqual({ok: false, reason: "missing"});
  });

  it("rejects a malformed timestamp", () => {
    expect(verifier().verify(signed({timestamp: "not-a-number"}), NOW)).toEqual({
      ok: false,
      reason: "malformed-timestamp",
    });
  });

  it("does not throw on a non-hex signature", () => {
    expect(verifier().verify({...signed(), signature: "zzzz"}, NOW)).toEqual({ok: false, reason: "bad-signature"});
  });

  it("requires a sufficiently long secret", () => {
    expect(() => new RequestSignatureVerifier("short", {maxSkewSeconds: 300})).toThrow(/32/);
  });
});
