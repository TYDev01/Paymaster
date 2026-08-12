import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";

import type {IdentityProvider, IdentityResult} from "../src/auth/identity.js";
import {JwtService} from "../src/auth/jwt.js";
import {rolesFor, TenantSessionService} from "../src/auth/tenantSession.js";
import {migrate} from "../src/db/migrate.js";
import {TenantRepository} from "../src/db/tenantRepository.js";
import {tenantId} from "../src/db/scope.js";
import {startPostgres, type TestPostgres} from "./support/postgres.js";

/**
 * Exchanging a person's identity for a tenant-scoped session.
 *
 * The identity provider is a stub here on purpose — its own verification is tested against real
 * ES256 signatures in `privyIdentity.test.ts`, and what matters at THIS layer is the step after
 * verification: that a verified person only ever gets a session for a tenant they are actually a
 * member of. The provider says who someone is; `tenant_members` says what they may touch, and no
 * token can assert the second.
 */
const ALICE = "did:privy:alice";
const BOB = "did:privy:bob";

function stubProvider(subject: string | undefined): IdentityProvider {
  return {
    verify: async (): Promise<IdentityResult> =>
      subject === undefined
        ? {ok: false, reason: "bad-signature"}
        : {ok: true, identity: {subject, email: undefined, expiresAt: 2_000_000_000}},
  };
}

describe("tenant sessions", () => {
  let pg: TestPostgres;
  let tenants: TenantRepository;
  const jwt = new JwtService("x".repeat(32), {issuer: "paymaster", audience: "paymaster-admin", ttlSeconds: 900});

  beforeAll(async () => {
    pg = await startPostgres();
    await migrate(pg.pool);
    tenants = new TenantRepository(pg.pool);
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.pool.query("DELETE FROM tenant_members");
    await pg.pool.query("DELETE FROM tenants WHERE id <> 'default'");
  });

  function service(subject: string | undefined, allowSelfSignup = false, newTenantId?: () => string) {
    return new TenantSessionService(stubProvider(subject), tenants, jwt, {
      allowSelfSignup,
      ...(newTenantId === undefined ? {} : {newTenantId}),
    });
  }

  it("issues a session scoped to the caller's only tenant", async () => {
    const acme = await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});

    const result = await service(ALICE).issue("provider-token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.membership.tenant.id).toBe(acme.id);

    // The session's tenant is inside the SIGNED claims, so it cannot be swapped by editing a header.
    const verified = jwt.verify(result.token);
    expect(verified.ok && verified.claims.tenantId).toBe("t_acme");
    expect(verified.ok && verified.claims.sub).toBe(ALICE);
  });

  it("refuses a tenant the caller is not a member of", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});

    // Bob is verified — he is genuinely who he says. That grants nothing here: naming a tenant is a
    // request, never a grant, and membership is ours to assert rather than the provider's.
    const result = await service(BOB).issue("provider-token", "t_acme");
    expect(result).toEqual({ok: false, reason: "not-a-member"});
  });

  it("refuses to guess when the caller belongs to several tenants", async () => {
    await tenants.createWithOwner({id: tenantId("t_one"), name: "One", subject: ALICE});
    await tenants.createWithOwner({id: tenantId("t_two"), name: "Two", subject: ALICE});

    const result = await service(ALICE).issue("provider-token");

    // Picking one silently would let an operator act on the wrong customer's configuration without
    // noticing which — the dashboard has to ask.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous-tenant");
    if (result.reason !== "ambiguous-tenant") return;
    expect(result.memberships.map((m) => m.tenant.id).sort()).toEqual(["t_one", "t_two"]);
  });

  it("issues for a named tenant when the caller is a member of several", async () => {
    await tenants.createWithOwner({id: tenantId("t_one"), name: "One", subject: ALICE});
    await tenants.createWithOwner({id: tenantId("t_two"), name: "Two", subject: ALICE});

    const result = await service(ALICE).issue("provider-token", "t_two");
    expect(result.ok && result.membership.tenant.id).toBe("t_two");
  });

  it("refuses an unverifiable identity", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    expect(await service(undefined).issue("nonsense")).toEqual({ok: false, reason: "invalid-identity"});
  });

  it("reports no membership rather than inventing one", async () => {
    // A real person with no organisation yet. The dashboard offers signup; it does not get a
    // session for a tenant that does not exist.
    expect(await service(ALICE).issue("provider-token")).toEqual({ok: false, reason: "no-membership"});
  });

  it("refuses a session for a suspended tenant, without destroying anything", async () => {
    await tenants.createWithOwner({id: tenantId("t_acme"), name: "Acme", subject: ALICE});
    await tenants.setStatus(tenantId("t_acme"), "suspended");

    expect(await service(ALICE).issue("provider-token")).toEqual({ok: false, reason: "tenant-suspended"});

    // This is where an unpaid subscription lands: the data, the keys and the balance are all still
    // there, and paying restores access. Suspension is never deletion.
    expect(await tenants.get(tenantId("t_acme"))).toMatchObject({status: "suspended"});
    expect(await tenants.membershipsFor(ALICE)).toHaveLength(1);
  });

  describe("signup", () => {
    it("is refused unless the deployment enables it", async () => {
      expect(await service(ALICE).signUp("provider-token", "Acme")).toEqual({ok: false, reason: "signup-disabled"});
    });

    it("creates a tenant with the caller as owner and returns a session", async () => {
      const result = await service(ALICE, true, () => "t_generated").signUp("provider-token", "Acme");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.membership.role).toBe("owner");
      expect(result.membership.tenant.name).toBe("Acme");

      const memberships = await tenants.membershipsFor(ALICE);
      expect(memberships.map((m) => m.tenant.id)).toEqual(["t_generated"]);
    });

    it("generates the tenant id rather than taking it from the caller", async () => {
      // A caller-chosen id could claim `default` — the tenant every existing single-tenant
      // deployment's data was backfilled to. The signup API has no parameter for it at all.
      const result = await service(ALICE, true).signUp("provider-token", "Acme");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.membership.tenant.id).not.toBe("default");
      expect(result.membership.tenant.id).toMatch(/^t_[0-9a-z]+$/);
    });

    it("leaves nothing behind when the tenant cannot be created", async () => {
      const svc = service(ALICE, true, () => "t_dup");
      expect((await svc.signUp("provider-token", "First")).ok).toBe(true);

      // Same generated id twice: the insert fails on the primary key.
      await expect(svc.signUp("provider-token", "Second")).rejects.toThrow();

      // The first tenant is intact and no orphan membership was written for the second attempt.
      const memberships = await tenants.membershipsFor(ALICE);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]!.tenant.name).toBe("First");
    });
  });

  describe("what a human session may do", () => {
    it("never grants sponsor, at any tenant role", () => {
      // A dashboard login must not be able to spend the tenant's balance. That is what an API key
      // is for, held by their server — so a stolen session can read and configure, never drain.
      for (const role of ["owner", "admin", "member"] as const) {
        expect(rolesFor(role), `${role} must not be able to sponsor`).not.toContain("sponsor");
      }
    });

    it("maps owner and admin to admin, and member to read-only", () => {
      expect(rolesFor("owner")).toEqual(["admin"]);
      expect(rolesFor("admin")).toEqual(["admin"]);
      expect(rolesFor("member")).toEqual(["viewer"]);
    });
  });

  describe("membership lookup", () => {
    it("returns only the caller's own tenants", async () => {
      await tenants.createWithOwner({id: tenantId("t_alice"), name: "Alice Co", subject: ALICE});
      await tenants.createWithOwner({id: tenantId("t_bob"), name: "Bob Co", subject: BOB});

      const alice = await service(ALICE).membershipsFor("provider-token");
      expect(alice?.memberships.map((m) => m.tenant.id)).toEqual(["t_alice"]);
    });

    it("carries the role, since the same person may own one tenant and only read another", async () => {
      await tenants.createWithOwner({id: tenantId("t_alice"), name: "Alice Co", subject: ALICE});
      await tenants.createWithOwner({id: tenantId("t_bob"), name: "Bob Co", subject: BOB});
      await tenants.addMember(tenantId("t_bob"), ALICE, "member");

      const alice = await service(ALICE).membershipsFor("provider-token");
      const byId = Object.fromEntries((alice?.memberships ?? []).map((m) => [m.tenant.id, m.role]));
      expect(byId).toEqual({t_alice: "owner", t_bob: "member"});
    });
  });
});
