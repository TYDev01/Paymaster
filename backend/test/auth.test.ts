import {describe, expect, it, vi} from "vitest";

import {generateApiKey, hashApiKey, hashesEqual, isWellFormedApiKey} from "../src/auth/apiKey.js";
import {ThrottledLastUsedTracker, type ApiKeyRecord} from "../src/auth/apiKeyStore.js";
import {ApiKeyAuthenticator, extractApiKey, type AuthObserver} from "../src/auth/authenticator.js";
import {InMemoryApiKeyStore} from "../src/auth/inMemoryApiKeyStore.js";
import {permissionsFor, ROLES, isRole} from "../src/auth/permissions.js";

const NOW = 1_700_000_000;

function record(over: Partial<ApiKeyRecord> = {}): {record: ApiKeyRecord; secret: string} {
  const generated = generateApiKey("test");
  return {
    secret: generated.secret,
    record: {
      id: "k1",
      name: "test key",
      hash: generated.hash,
      displayPrefix: generated.displayPrefix,
      roles: ["sponsor"],
      policyId: undefined,
      enabled: true,
      createdAt: NOW - 100,
      expiresAt: undefined,
      lastUsedAt: undefined,
      ...over,
    },
  };
}

describe("generateApiKey", () => {
  it("produces a well-formed, environment-tagged key", () => {
    expect(isWellFormedApiKey(generateApiKey("live").secret)).toBe(true);
    expect(generateApiKey("live").secret.startsWith("pm_live_")).toBe(true);
    expect(generateApiKey("test").secret.startsWith("pm_test_")).toBe(true);
  });

  it("produces at least 256 bits of entropy", () => {
    // base64url of 32 bytes is ~43 chars. This is what makes fast hashing safe.
    const random = generateApiKey("live").secret.replace("pm_live_", "");
    expect(random.length).toBeGreaterThanOrEqual(43);
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({length: 1_000}, () => generateApiKey("live").secret));
    expect(keys.size).toBe(1_000);
  });

  it("returns a hash that matches hashApiKey", () => {
    const generated = generateApiKey("live");
    expect(generated.hash).toBe(hashApiKey(generated.secret));
  });

  /** The display prefix identifies a key in a list; it must not be enough to authenticate. */
  it("has a display prefix that is not the key", () => {
    const generated = generateApiKey("live");
    expect(generated.displayPrefix.length).toBeLessThan(generated.secret.length);
    expect(isWellFormedApiKey(generated.displayPrefix)).toBe(false);
  });
});

describe("isWellFormedApiKey", () => {
  it("rejects junk without hashing it", () => {
    for (const bad of ["", "garbage", "pm_live_", "pm_prod_abc", "Bearer pm_live_x", `pm_live_${"a".repeat(10)}`]) {
      expect(isWellFormedApiKey(bad), bad).toBe(false);
    }
  });
});

describe("hashesEqual", () => {
  it("compares equal and unequal hashes", () => {
    expect(hashesEqual("abc", "abc")).toBe(true);
    expect(hashesEqual("abc", "abd")).toBe(false);
  });

  /** timingSafeEqual throws on length mismatch, which would itself leak length. */
  it("returns false rather than throwing on a length mismatch", () => {
    expect(() => hashesEqual("a", "abcdef")).not.toThrow();
    expect(hashesEqual("a", "abcdef")).toBe(false);
  });
});

describe("permissions", () => {
  it("flattens roles to their union", () => {
    expect(permissionsFor(["sponsor"])).toEqual(new Set(["sponsor:create"]));
    expect(permissionsFor(["sponsor", "viewer"]).has("policy:read")).toBe(true);
    expect(permissionsFor(["sponsor", "viewer"]).has("sponsor:create")).toBe(true);
  });

  it("gives the sponsor role nothing but sponsor:create", () => {
    // The role nearly every key has: it can spend the deposit within policy, and nothing else.
    expect(ROLES.sponsor).toEqual(["sponsor:create"]);
  });

  it("does not let viewer create sponsorships", () => {
    expect(permissionsFor(["viewer"]).has("sponsor:create")).toBe(false);
  });

  it("does not let viewer write anything", () => {
    const granted = permissionsFor(["viewer"]);
    for (const permission of granted) expect(permission.endsWith(":write")).toBe(false);
  });

  it("recognises valid role names", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("superuser")).toBe(false);
  });

  it("empty roles grant nothing", () => {
    expect(permissionsFor([]).size).toBe(0);
  });
});

describe("ApiKeyAuthenticator", () => {
  it("authenticates a valid key", async () => {
    const {record: r, secret} = record();
    const auth = new ApiKeyAuthenticator(new InMemoryApiKeyStore([r]));

    const result = await auth.authenticate(secret, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.apiKeyId).toBe("k1");
    expect(result.principal.permissions.has("sponsor:create")).toBe(true);
  });

  it("rejects a missing credential", async () => {
    const auth = new ApiKeyAuthenticator(new InMemoryApiKeyStore([]));
    expect(await auth.authenticate(undefined, NOW)).toEqual({ok: false, reason: "missing"});
    expect(await auth.authenticate("", NOW)).toEqual({ok: false, reason: "missing"});
  });

  it("rejects a malformed credential without touching the store", async () => {
    const store = new InMemoryApiKeyStore([]);
    const spy = vi.spyOn(store, "findByHash");
    const auth = new ApiKeyAuthenticator(store);

    expect(await auth.authenticate("garbage", NOW)).toEqual({ok: false, reason: "malformed"});
    expect(spy, "malformed input must not reach the store").not.toHaveBeenCalled();
  });

  it("rejects an unknown key", async () => {
    const auth = new ApiKeyAuthenticator(new InMemoryApiKeyStore([]));
    expect(await auth.authenticate(generateApiKey("test").secret, NOW)).toEqual({ok: false, reason: "unknown"});
  });

  it("rejects a revoked key", async () => {
    const {record: r, secret} = record({enabled: false});
    const auth = new ApiKeyAuthenticator(new InMemoryApiKeyStore([r]));
    expect(await auth.authenticate(secret, NOW)).toEqual({ok: false, reason: "revoked"});
  });

  it("rejects an expired key at the moment it expires", async () => {
    const {record: r, secret} = record({expiresAt: NOW});
    const auth = new ApiKeyAuthenticator(new InMemoryApiKeyStore([r]));

    expect(await auth.authenticate(secret, NOW - 1)).toMatchObject({ok: true});
    expect(await auth.authenticate(secret, NOW), "expiry must be inclusive").toEqual({ok: false, reason: "expired"});
  });

  it("carries the key's pinned policy onto the principal", async () => {
    const {record: r, secret} = record({policyId: "restricted"});
    const auth = new ApiKeyAuthenticator(new InMemoryApiKeyStore([r]));

    const result = await auth.authenticate(secret, NOW);
    expect(result.ok && result.principal.policyId).toBe("restricted");
  });

  it("reports failures to the observer for attack detection", async () => {
    const failures: string[] = [];
    const observer: AuthObserver = {
      onAuthFailure: (reason) => failures.push(reason),
      onAuthSuccess: () => undefined,
    };
    const auth = new ApiKeyAuthenticator(new InMemoryApiKeyStore([]), observer);

    await auth.authenticate("garbage", NOW);
    await auth.authenticate(generateApiKey("test").secret, NOW);
    expect(failures).toEqual(["malformed", "unknown"]);
  });

  it("records last use without blocking the request", async () => {
    const {record: r, secret} = record();
    const store = new InMemoryApiKeyStore([r]);
    const auth = new ApiKeyAuthenticator(store);

    await auth.authenticate(secret, NOW);
    await vi.waitFor(async () => {
      expect((await store.list())[0]!.lastUsedAt).toBe(NOW);
    });
  });

  /** A bookkeeping failure must not fail an otherwise valid request. */
  it("authenticates even if recording last use fails", async () => {
    const {record: r, secret} = record();
    const store = new InMemoryApiKeyStore([r]);
    store.touch = async () => {
      throw new Error("store down");
    };
    const auth = new ApiKeyAuthenticator(store);

    expect((await auth.authenticate(secret, NOW)).ok).toBe(true);
  });
});

describe("ThrottledLastUsedTracker", () => {
  /**
   * Why this exists: at thousands of operations per minute, a write per request in service of a
   * field nobody reads in real time would be one of the heaviest write loads in the system.
   */
  it("collapses repeated use into one write per interval", async () => {
    let writes = 0;
    const tracker = new ThrottledLastUsedTracker({touch: async () => void writes++}, 60);

    // 60 requests spread across a single 60s window: one write, not sixty.
    for (let i = 0; i < 60; i++) tracker.record("k1", NOW + i);
    await vi.waitFor(() => expect(writes).toBe(1));
  });

  it("writes again once the interval has passed", async () => {
    let writes = 0;
    const tracker = new ThrottledLastUsedTracker({touch: async () => void writes++}, 60);

    tracker.record("k1", NOW);
    tracker.record("k1", NOW + 61);
    await vi.waitFor(() => expect(writes).toBe(2));
  });

  it("throttles each key independently", async () => {
    const seen: string[] = [];
    const tracker = new ThrottledLastUsedTracker({touch: async (id) => void seen.push(id)}, 60);

    tracker.record("k1", NOW);
    tracker.record("k2", NOW);
    await vi.waitFor(() => expect(seen.sort()).toEqual(["k1", "k2"]));
  });

  it("retries on the next request after a failed write", async () => {
    let attempts = 0;
    const tracker = new ThrottledLastUsedTracker(
      {
        touch: async () => {
          attempts++;
          throw new Error("store down");
        },
      },
      60,
    );

    tracker.record("k1", NOW);
    await vi.waitFor(() => expect(attempts).toBe(1));
    // Same interval, but the previous write failed, so it must not be suppressed.
    tracker.record("k1", NOW + 1);
    await vi.waitFor(() => expect(attempts).toBe(2));
  });
});

describe("InMemoryApiKeyStore", () => {
  it("finds by hash and revokes", async () => {
    const {record: r, secret} = record();
    const store = new InMemoryApiKeyStore([r]);

    expect(await store.findByHash(hashApiKey(secret))).toMatchObject({id: "k1"});
    expect(await store.revoke("k1", NOW)).toBe(true);
    expect((await store.findByHash(hashApiKey(secret)))!.enabled).toBe(false);
  });

  it("revoking twice reports no change the second time", async () => {
    const {record: r} = record();
    const store = new InMemoryApiKeyStore([r]);
    expect(await store.revoke("k1", NOW)).toBe(true);
    expect(await store.revoke("k1", NOW)).toBe(false);
  });

  it("rejects a duplicate id", async () => {
    const {record: r} = record();
    const store = new InMemoryApiKeyStore([r]);
    await expect(store.create({...r, hash: "other"})).rejects.toThrow(/already exists/);
  });

  it("stores no recoverable credential", async () => {
    const {record: r, secret} = record();
    const store = new InMemoryApiKeyStore([r]);
    // A dump of everything the store holds must not contain the key.
    expect(JSON.stringify(await store.list())).not.toContain(secret.slice(8));
  });
});

describe("extractApiKey", () => {
  it("reads a Bearer token", () => {
    expect(extractApiKey({authorization: "Bearer pm_live_abc"})).toBe("pm_live_abc");
    expect(extractApiKey({authorization: "bearer pm_live_abc"})).toBe("pm_live_abc");
  });

  it("reads X-API-Key", () => {
    expect(extractApiKey({"x-api-key": "pm_live_abc"})).toBe("pm_live_abc");
  });

  it("prefers Authorization when both are present", () => {
    expect(extractApiKey({authorization: "Bearer pm_live_a", "x-api-key": "pm_live_b"})).toBe("pm_live_a");
  });

  it("returns undefined when absent or unparseable", () => {
    expect(extractApiKey({})).toBeUndefined();
    expect(extractApiKey({authorization: "Basic dXNlcjpwYXNz"})).toBeUndefined();
  });

  it("tolerates a repeated header", () => {
    expect(extractApiKey({"x-api-key": ["pm_live_a", "pm_live_b"]})).toBe("pm_live_a");
  });
});
