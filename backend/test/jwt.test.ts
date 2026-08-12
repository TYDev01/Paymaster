import "reflect-metadata";

import {createHmac} from "node:crypto";
import {describe, expect, it} from "vitest";
import {Reflector} from "@nestjs/core";
import {ForbiddenException, UnauthorizedException, type ExecutionContext} from "@nestjs/common";

import {JwtService, type JwtOptions} from "../src/auth/jwt.js";
import {ApiKeyGuard, RequirePermissions} from "../src/api/guards/apiKey.guard.js";
import type {ApiKeyAuthenticator, AuthResult, Principal} from "../src/auth/authenticator.js";
import {permissionsFor} from "../src/auth/permissions.js";
import {ACME} from "./support/tenants.js";

const SECRET = "a".repeat(40);
const OPTS: JwtOptions = {issuer: "paymaster", audience: "paymaster-admin", ttlSeconds: 900};
const NOW = 1_700_000_000;

function service(over: Partial<JwtOptions> = {}): JwtService {
  return new JwtService(SECRET, {...OPTS, ...over});
}

describe("JwtService", () => {
  it("round-trips a token and its claims", () => {
    const jwt = service();
    const {token, expiresAt} = jwt.sign({tenantId: ACME, sub: "key-1", name: "op", roles: ["admin"]}, NOW);
    expect(expiresAt).toBe(NOW + 900);

    const result = jwt.verify(token, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toMatchObject({tenantId: ACME, sub: "key-1", name: "op", roles: ["admin"], exp: NOW + 900});
    }
  });

  it("carries a pinned policy id through", () => {
    const jwt = service();
    const {token} = jwt.sign({tenantId: ACME, sub: "k", name: "n", roles: ["sponsor"], policyId: "acme"}, NOW);
    const result = jwt.verify(token, NOW);
    expect(result.ok && result.claims.policyId).toBe("acme");
  });

  it("rejects a tampered payload", () => {
    const jwt = service();
    const {token} = jwt.sign({tenantId: ACME, sub: "k", name: "n", roles: ["sponsor"]}, NOW);
    const [h, , s] = token.split(".");
    // Swap in an admin-role payload while keeping the signature: must fail signature verification.
    const forged = Buffer.from(
      JSON.stringify({
        iss: "paymaster",
        aud: "paymaster-admin",
        tenantId: ACME,
        sub: "k",
        name: "n",
        roles: ["admin"],
        iat: NOW,
        exp: NOW + 900,
      }),
      "utf8",
    ).toString("base64url");
    const result = jwt.verify(`${h}.${forged}.${s}`, NOW);
    expect(result).toEqual({ok: false, reason: "bad-signature"});
  });

  it("rejects an expired token", () => {
    const jwt = service();
    const {token} = jwt.sign({tenantId: ACME, sub: "k", name: "n", roles: ["admin"]}, NOW);
    expect(jwt.verify(token, NOW + 901)).toEqual({ok: false, reason: "expired"});
  });

  it("rejects a token signed with a different secret", () => {
    const {token} = new JwtService("b".repeat(40), OPTS).sign(
      {tenantId: ACME, sub: "k", name: "n", roles: ["admin"]},
      NOW,
    );
    expect(service().verify(token, NOW)).toEqual({ok: false, reason: "bad-signature"});
  });

  it("rejects a wrong issuer or audience", () => {
    const {token} = service({issuer: "evil"}).sign({tenantId: ACME, sub: "k", name: "n", roles: ["admin"]}, NOW);
    expect(service().verify(token, NOW)).toEqual({ok: false, reason: "wrong-issuer"});

    const {token: t2} = service({audience: "someone-else"}).sign(
      {tenantId: ACME, sub: "k", name: "n", roles: ["admin"]},
      NOW,
    );
    expect(service().verify(t2, NOW)).toEqual({ok: false, reason: "wrong-audience"});
  });

  it("refuses the alg:none downgrade", () => {
    const jwt = service();
    const header = Buffer.from(JSON.stringify({alg: "none", typ: "JWT"}), "utf8").toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "paymaster",
        aud: "paymaster-admin",
        tenantId: ACME,
        sub: "k",
        name: "n",
        roles: ["admin"],
        iat: NOW,
        exp: NOW + 900,
      }),
      "utf8",
    ).toString("base64url");
    // No signature at all — the classic alg:none forgery. Rejected at the header, before any
    // signature check, because the algorithm is required to equal ours rather than read from the token.
    expect(jwt.verify(`${header}.${payload}.`, NOW)).toEqual({ok: false, reason: "malformed"});
  });

  it("rejects a token carrying an unknown role", () => {
    // Forge with the real secret so the signature is valid; the role set is what must be rejected.
    const jwt = service();
    const signingInput = `${Buffer.from(JSON.stringify({alg: "HS256", typ: "JWT"})).toString("base64url")}.${Buffer.from(JSON.stringify({iss: "paymaster", aud: "paymaster-admin", sub: "k", name: "n", roles: ["superuser"], iat: NOW, exp: NOW + 900})).toString("base64url")}`;
    const sig = createHmac("sha256", SECRET).update(signingInput).digest("base64url");
    expect(jwt.verify(`${signingInput}.${sig}`, NOW)).toEqual({ok: false, reason: "bad-claims"});
  });

  it("rejects a malformed token", () => {
    expect(service().verify("not-a-jwt", NOW)).toEqual({ok: false, reason: "malformed"});
    expect(service().verify("a.b", NOW)).toEqual({ok: false, reason: "malformed"});
  });

  it("requires a secret of at least 32 characters", () => {
    expect(() => new JwtService("short", OPTS)).toThrow(/32/);
  });
});

// A fake ExecutionContext carrying the given headers, enough for ApiKeyGuard.
function context(headers: Record<string, string>): ExecutionContext {
  const request = {headers};
  return {
    switchToHttp: () => ({getRequest: () => request}),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function keyAuthenticator(principal: Principal | undefined): ApiKeyAuthenticator {
  return {
    authenticate: async (): Promise<AuthResult> =>
      principal === undefined ? {ok: false, reason: "unknown"} : {ok: true, principal},
  } as unknown as ApiKeyAuthenticator;
}

function principal(over: Partial<Principal> = {}): Principal {
  const roles = over.roles ?? (["admin"] as const);
  return {
    tenantId: ACME,
    apiKeyId: "key-1",
    name: "op",
    roles,
    permissions: permissionsFor(roles),
    policyId: undefined,
    ...over,
  };
}

describe("ApiKeyGuard with JWT", () => {
  it("authenticates a valid session token without touching the key store", async () => {
    const jwt = service();
    const {token} = jwt.sign({tenantId: ACME, sub: "op-1", name: "operator", roles: ["admin"]});
    // Key store would throw if consulted — proving the JWT path is taken for a non-key credential.
    const guard = new ApiKeyGuard(keyAuthenticator(undefined), new Reflector(), jwt);

    await expect(guard.canActivate(context({authorization: `Bearer ${token}`}))).resolves.toBe(true);
  });

  it("still authenticates an API key when a JWT verifier is present", async () => {
    const jwt = service();
    const guard = new ApiKeyGuard(keyAuthenticator(principal()), new Reflector(), jwt);
    await expect(guard.canActivate(context({authorization: "Bearer pm_test_" + "x".repeat(40)}))).resolves.toBe(true);
  });

  it("rejects an invalid session token with 401", async () => {
    const guard = new ApiKeyGuard(keyAuthenticator(undefined), new Reflector(), service());
    await expect(guard.canActivate(context({authorization: "Bearer a.b.c"}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("enforces permissions carried by the token's roles", async () => {
    const jwt = service();
    // A viewer session must not pass a handler that requires key:write.
    const {token} = jwt.sign({tenantId: ACME, sub: "v", name: "viewer", roles: ["viewer"]});
    const reflector = new Reflector();
    const guard = new ApiKeyGuard(keyAuthenticator(undefined), reflector, jwt);

    // Attach the required permission to the fake handler via the same decorator the controller uses.
    const handler = function h() {};
    RequirePermissions("key:write")(handler);
    const ctx = {
      switchToHttp: () => ({getRequest: () => ({headers: {authorization: `Bearer ${token}`}})}),
      getHandler: () => handler,
      getClass: () => class C {},
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
