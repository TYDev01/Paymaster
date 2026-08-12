import {generateKeyPairSync, sign as signPayload, type KeyObject} from "node:crypto";
import {describe, expect, it} from "vitest";

import {PrivyIdentityProvider, type Jwk} from "../src/auth/privyIdentityProvider.js";

/**
 * Token verification, against real ES256 signatures.
 *
 * The keys are generated here rather than mocked, and the tokens are genuinely signed, because the
 * thing most likely to be wrong is the cryptography — specifically the P1363/DER encoding of an
 * ECDSA signature, which a mock would paper over completely. A test that stubs the verification
 * proves only that the surrounding `if` statements are arranged correctly.
 */
const APP_ID = "test-app-id";
const NOW = 1_700_000_000;

function keypair(kid: string) {
  const {publicKey, privateKey} = generateKeyPairSync("ec", {namedCurve: "P-256"});
  const jwk = publicKey.export({format: "jwk"}) as Jwk;
  return {kid, privateKey, jwk: {...jwk, kid, alg: "ES256", use: "sig"}};
}

function token(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const head = base64url({alg: "ES256", typ: "JWT", kid, ...header});
  const body = base64url(claims);
  // ieee-p1363 is what a JWS carries; signing with the default DER here would produce a token no
  // conforming verifier accepts, so the test would pass against a broken implementation.
  const signature = signPayload("sha256", Buffer.from(`${head}.${body}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${signature.toString("base64url")}`;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {iss: "privy.io", aud: APP_ID, sub: "did:privy:abc123", exp: NOW + 3600, iat: NOW, ...over};
}

function provider(jwks: {keys: Jwk[]}, options: {onFetch?: () => void} = {}) {
  let fetches = 0;
  // The cache clock is separate and injected, so a test can move past the unknown-kid refresh
  // floor without sleeping through it.
  let clockMs = 1_000_000;
  const instance = new PrivyIdentityProvider(
    {appId: APP_ID, jwksUrl: "https://example.invalid/jwks.json"},
    {
      fetchJwks: async () => {
        fetches += 1;
        options.onFetch?.();
        return jwks;
      },
      now: () => NOW,
      nowMs: () => clockMs,
    },
  );
  return {
    provider: instance,
    fetches: () => fetches,
    advanceMs: (ms: number) => {
      clockMs += ms;
    },
  };
}

describe("PrivyIdentityProvider", () => {
  it("accepts a correctly signed token and returns the subject", async () => {
    const key = keypair("k1");
    const {provider: p} = provider({keys: [key.jwk]});

    const result = await p.verify(token(key.privateKey, "k1", claims({email: "a@example.com"})));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.subject).toBe("did:privy:abc123");
      expect(result.identity.email).toBe("a@example.com");
      expect(result.identity.expiresAt).toBe(NOW + 3600);
    }
  });

  it("rejects a token signed by a key that is not in the published set", async () => {
    const published = keypair("k1");
    const attacker = keypair("k1"); // same kid, different key
    const {provider: p} = provider({keys: [published.jwk]});

    const result = await p.verify(token(attacker.privateKey, "k1", claims()));
    expect(result).toEqual({ok: false, reason: "bad-signature"});
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const key = keypair("k1");
    const {provider: p} = provider({keys: [key.jwk]});

    const original = token(key.privateKey, "k1", claims());
    const [head, , signature] = original.split(".") as [string, string, string];
    // Swapping in a different subject is the attack: impersonation of another person.
    const tampered = `${head}.${base64url(claims({sub: "did:privy:someone-else"}))}.${signature}`;

    expect(await p.verify(tampered)).toEqual({ok: false, reason: "bad-signature"});
  });

  it("refuses the alg:none downgrade", async () => {
    const key = keypair("k1");
    const {provider: p} = provider({keys: [key.jwk]});

    const head = base64url({alg: "none", typ: "JWT", kid: "k1"});
    const unsigned = `${head}.${base64url(claims())}.`;

    // The algorithm is required to equal ES256, never read from the token and trusted.
    expect(await p.verify(unsigned)).toEqual({ok: false, reason: "malformed"});
  });

  it("rejects a token minted for a different Privy application", async () => {
    const key = keypair("k1");
    const {provider: p} = provider({keys: [key.jwk]});

    // Correctly signed by a key we trust — the audience check is the only thing standing between
    // another application's users and this one.
    const result = await p.verify(token(key.privateKey, "k1", claims({aud: "someone-elses-app"})));
    expect(result).toEqual({ok: false, reason: "wrong-audience"});
  });

  it("accepts an audience array containing our app id", async () => {
    const key = keypair("k1");
    const {provider: p} = provider({keys: [key.jwk]});
    const result = await p.verify(token(key.privateKey, "k1", claims({aud: ["other", APP_ID]})));
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong issuer and an expired token", async () => {
    const key = keypair("k1");
    const {provider: p} = provider({keys: [key.jwk]});

    expect(await p.verify(token(key.privateKey, "k1", claims({iss: "evil.example"})))).toEqual({
      ok: false,
      reason: "wrong-issuer",
    });
    expect(await p.verify(token(key.privateKey, "k1", claims({exp: NOW - 1})))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a malformed token without throwing", async () => {
    const key = keypair("k1");
    const {provider: p} = provider({keys: [key.jwk]});

    // Caller-supplied input: none of these may produce an exception.
    for (const bad of ["", "not-a-token", "a.b", "a.b.c.d", "...", "%%%.%%%.%%%"]) {
      const result = await p.verify(bad);
      expect(result.ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("caches the key set instead of fetching on every verification", async () => {
    const key = keypair("k1");
    const {provider: p, fetches} = provider({keys: [key.jwk]});

    for (let i = 0; i < 5; i++) await p.verify(token(key.privateKey, "k1", claims()));

    // An external service on the critical path of every dashboard request would be a bad trade.
    expect(fetches()).toBe(1);
  });

  it("picks up a rotated key, and stops honouring one that was withdrawn", async () => {
    const oldKey = keypair("old");
    const newKey = keypair("new");
    const jwks = {keys: [oldKey.jwk]};
    const {provider: p, advanceMs} = provider(jwks);

    expect((await p.verify(token(oldKey.privateKey, "old", claims()))).ok).toBe(true);

    // The provider rotates: the old key is withdrawn from the published set.
    jwks.keys = [newKey.jwk];

    // Past the refresh floor. Rotation recovery is bounded by that floor, not by the cache TTL.
    advanceMs(3_000);

    // An unknown kid forces one refresh, which is how rotation is picked up without a restart.
    expect((await p.verify(token(newKey.privateKey, "new", claims()))).ok).toBe(true);
    // And the retired key is no longer accepted — the set is replaced, not merged.
    expect(await p.verify(token(oldKey.privateKey, "old", claims()))).toEqual({
      ok: false,
      reason: "unknown-key",
    });
  });

  it("keeps working on cached keys when the provider is unreachable", async () => {
    const key = keypair("k1");
    let failing = false;
    const p = new PrivyIdentityProvider(
      {appId: APP_ID},
      {
        fetchJwks: async () => {
          if (failing) throw new Error("provider down");
          return {keys: [key.jwk]};
        },
        now: () => NOW,
      },
    );

    expect((await p.verify(token(key.privateKey, "k1", claims()))).ok).toBe(true);

    failing = true;
    // Degrading to "tokens signed with keys we already know still work" beats locking every
    // customer out of their dashboard because a third party had an outage.
    expect((await p.verify(token(key.privateKey, "k1", claims()))).ok).toBe(true);
  });

  it("ignores keys in the set that cannot sign ES256", async () => {
    const usable = keypair("k1");
    const jwks = {keys: [{kid: "rsa", kty: "RSA", n: "x", e: "AQAB"} as Jwk, usable.jwk]};
    const {provider: p} = provider(jwks);

    // A key of the wrong type must be skipped, not imported and then failing somewhere less obvious.
    expect((await p.verify(token(usable.privateKey, "k1", claims()))).ok).toBe(true);
  });
});

describe("PrivyIdentityProvider refresh floor", () => {
  it("does not refetch for every unknown kid, so it cannot be used to hammer the provider", async () => {
    const key = keypair("k1");
    const {provider: p, fetches} = provider({keys: [key.jwk]});

    // One legitimate verification populates the cache.
    await p.verify(token(key.privateKey, "k1", claims()));
    const afterFirst = fetches();

    // Then a flood of tokens naming keys that do not exist. Without the floor this is one outbound
    // request per inbound token — an amplifier pointed at the identity provider.
    for (let i = 0; i < 50; i++) {
      const bogus = token(key.privateKey, `made-up-${i}`, claims());
      expect((await p.verify(bogus)).ok).toBe(false);
    }

    expect(fetches(), "unknown kids must not each trigger a fetch").toBe(afterFirst);
  });
});
