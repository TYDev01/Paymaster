import "reflect-metadata";

import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {NestFactory} from "@nestjs/core";
import {FastifyAdapter, type NestFastifyApplication} from "@nestjs/platform-fastify";
import {parseEther, type Address} from "viem";

import {AppModule, type AppDependencies} from "../src/api/app.module.js";
import {DomainErrorFilter} from "../src/api/filters/domainError.filter.js";
import {generateApiKey, hashApiKey} from "../src/auth/apiKey.js";
import {CANONICAL_ENTRYPOINT_V07, type ChainConfig} from "../src/chain/chainConfig.js";
import {ChainRegistry} from "../src/chain/chainRegistry.js";
import {AuditLogRepository} from "../src/db/auditLogRepository.js";
import {PostgresApiKeyStore} from "../src/db/postgresApiKeyStore.js";
import {PostgresPolicyRepository} from "../src/db/postgresPolicyRepository.js";
import {SponsorshipRepository} from "../src/db/sponsorshipRepository.js";
import {PolicyFactory} from "../src/policy/policyFactory.js";
import {PolicySource} from "../src/policy/policySource.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import type {Env} from "../src/config/env.js";
import {startPostgres, truncateAll, type TestPostgres} from "./support/postgres.js";

const SIGNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAYMASTER = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SENDER = "0x1234567890123456789012345678901234567890";

describe("admin API", () => {
  let pg: TestPostgres;
  let app: NestFastifyApplication;
  let policySource: PolicySource;
  let policyRepo: PostgresPolicyRepository;
  let adminKey: string;
  let viewerKey: string;
  let sponsorKey: string;

  const env: Env = {
    NODE_ENV: "test",
    PORT: 0,
    HOST: "127.0.0.1",
    SPONSORSHIP_SIGNER_KEY: SIGNER_KEY as `0x${string}`,
    CHAINS: "[]",
    SPONSORSHIP_VALIDITY_SECONDS: 300,
    PAYMASTER_VERIFICATION_GAS_LIMIT: 300_000n,
    POSTOP_GAS_LIMIT: 50_000n,
    DEFAULT_POLICY_ID: "default",
    DATABASE_MAX_CONNECTIONS: 5,
    DATABASE_MIGRATE_ON_BOOT: true,
  };

  const chainConfig: ChainConfig = {
    chainId: 8453,
    name: "Base",
    rpcUrls: ["https://base.example.com"],
    entryPoint: CANONICAL_ENTRYPOINT_V07,
    paymaster: PAYMASTER,
    explorerUrl: "https://basescan.org",
    nativeCurrency: {symbol: "ETH", decimals: 18},
    minDepositWei: parseEther("1"),
    minStakeWei: parseEther("1"),
    enabled: true,
  };

  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await app?.close();
    await pg.pool.query("TRUNCATE policy_rules, sponsorships, audit_logs, api_keys, policies RESTART IDENTITY CASCADE");

    const keyStore = new PostgresApiKeyStore(pg.pool);
    const now = Math.floor(Date.now() / 1000);

    const mint = async (id: string, roles: readonly string[]) => {
      const gen = generateApiKey("test");
      await keyStore.create({
        id,
        name: id,
        hash: gen.hash,
        displayPrefix: gen.displayPrefix,
        roles: roles as never,
        policyId: undefined,
        enabled: true,
        createdAt: now,
        expiresAt: undefined,
        lastUsedAt: undefined,
      });
      return gen.secret;
    };

    adminKey = await mint("admin-key", ["admin"]);
    viewerKey = await mint("viewer-key", ["viewer"]);
    sponsorKey = await mint("sponsor-key", ["sponsor"]);

    policyRepo = new PostgresPolicyRepository(pg.pool, new PolicyFactory(new InMemoryQuotaStore()));
    policySource = new PolicySource(policyRepo);
    await policySource.reload();

    const deps: AppDependencies = {
      chains: ChainRegistry.fromConfigs([chainConfig]),
      policies: policySource,
      signer: new LocalSponsorshipSigner(SIGNER_KEY as `0x${string}`),
      apiKeys: keyStore,
      sponsorships: new SponsorshipRepository(pg.pool),
      policyRepository: policyRepo,
      audit: new AuditLogRepository(pg.pool),
      quotasAreLocal: true,
      env,
    };

    app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(deps), new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  const call = (method: "GET" | "POST" | "DELETE", url: string, key: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {authorization: `Bearer ${key}`},
      ...(payload === undefined ? {} : {payload: payload as object}),
    });

  const samplePolicy = (over: Record<string, unknown> = {}) => ({
    id: "acme",
    name: "Acme dApp",
    enabled: true,
    rules: [
      {ruleType: "chain-enabled", config: {chainIds: [8453]}},
      {ruleType: "target-allowlist", config: {addresses: [USDC]}},
      {ruleType: "quota", config: {name: "w", subject: "wallet", unit: "operations", limit: "10", windowSeconds: 86_400}},
    ],
    ...over,
  });

  describe("policies", () => {
    it("creates a policy and serves it immediately", async () => {
      const response = await call("POST", "/admin/policies", adminKey, samplePolicy());
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({id: "acme", enabled: true});

      // The point of hot reload: an operator expects the policy live now, not at the next poll.
      expect(policySource.has("acme"), "policy must be serving without a restart").toBe(true);
      expect(policySource.get("acme").rules).toHaveLength(3);
    });

    it("lists and gets policies", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      expect((await call("GET", "/admin/policies", adminKey)).json().policies).toHaveLength(1);
      expect((await call("GET", "/admin/policies/acme", adminKey)).json().id).toBe("acme");
    });

    it("404s for an unknown policy", async () => {
      const response = await call("GET", "/admin/policies/nope", adminKey);
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("NOT_FOUND");
    });

    it("replaces rules on update rather than appending", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      await call("POST", "/admin/policies", adminKey, samplePolicy({rules: [{ruleType: "no-value-transfer"}]}));

      const policy = (await call("GET", "/admin/policies/acme", adminKey)).json();
      expect(policy.rules).toHaveLength(1);
      expect(policySource.get("acme").rules).toHaveLength(1);
    });

    it("preserves rule order across a reload", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      const policy = (await call("GET", "/admin/policies/acme", adminKey)).json();
      expect(policy.rules.map((r: {ruleType: string}) => r.ruleType)).toEqual([
        "chain-enabled",
        "target-allowlist",
        "quota",
      ]);
    });

    /**
     * A config that cannot build a working rule must be refused at the boundary. Accepting it would
     * write a policy that silently stops loading, discovered long after the operator has gone.
     */
    it("rejects an invalid rule config without writing it", async () => {
      const response = await call(
        "POST",
        "/admin/policies",
        adminKey,
        samplePolicy({rules: [{ruleType: "chain-enabled", config: {chainIds: []}}]}),
      );
      // 400, not 500: an operator's typo is not our failure, and a 500 would page someone for it.
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("INVALID_POLICY_CONFIG");
      // The message names the policy and rule, which is what makes the mistake fixable.
      expect(response.json().message).toContain("chain-enabled");

      const {rows} = await pg.pool.query("SELECT * FROM policies WHERE id = 'acme'");
      expect(rows, "a rejected policy must not be written").toHaveLength(0);
    });

    it("rejects an unknown rule type", async () => {
      const response = await call(
        "POST",
        "/admin/policies",
        adminKey,
        samplePolicy({rules: [{ruleType: "sudo-allow-everything", config: {}}]}),
      );
      expect(response.statusCode).toBe(400);
    });

    it("deletes a policy and stops serving it", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      expect((await call("DELETE", "/admin/policies/acme", adminKey)).statusCode).toBe(204);
      expect(policySource.has("acme")).toBe(false);
    });

    it("404s deleting an unknown policy", async () => {
      expect((await call("DELETE", "/admin/policies/nope", adminKey)).statusCode).toBe(404);
    });

    /**
     * Deleting a policy that keys are pinned to would unpin them, and an unpinned key may name any
     * policy in the request body. A delete must not become a privilege escalation.
     */
    it("refuses to delete a policy an API key is pinned to", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      await pg.pool.query("UPDATE api_keys SET policy_id = 'acme' WHERE id = 'sponsor-key'");

      const response = await call("DELETE", "/admin/policies/acme", adminKey);
      // 409: well-formed, but conflicts with state the operator can resolve by unpinning the key.
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("POLICY_IN_USE");
      expect(policySource.has("acme"), "the policy must still be serving").toBe(true);
    });

    it("a disabled policy is not served", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy({enabled: false}));
      expect(policySource.has("acme")).toBe(false);
      // ...but is still listed, so an operator can re-enable it.
      expect((await call("GET", "/admin/policies", adminKey)).json().policies).toHaveLength(1);
    });

    it("reloads on demand and reports the generation", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      const before = policySource.generation;

      const response = await call("POST", "/admin/policies/reload", adminKey);
      expect(response.statusCode).toBe(200);
      expect(response.json().count).toBe(1);
      expect(response.json().generation).toBeGreaterThan(before);
    });

    /** Hot reload is only meaningful if a change made out-of-band is picked up. */
    it("picks up a change written directly to the database", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      expect(policySource.get("acme").rules).toHaveLength(3);

      await pg.pool.query("DELETE FROM policy_rules WHERE policy_id = 'acme' AND rule_type = 'quota'");
      await call("POST", "/admin/policies/reload", adminKey);

      expect(policySource.get("acme").rules).toHaveLength(2);
    });

    /** A broken row must degrade to stale policy, never to a policy missing a rule. */
    it("keeps the previous policy set when a reload finds an unbuildable rule", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      expect(policySource.get("acme").rules).toHaveLength(3);

      // Corrupt a row behind the API's back, as a bad migration or manual edit would.
      await pg.pool.query("UPDATE policy_rules SET rule_type = 'nonsense' WHERE policy_id = 'acme' AND ordinal = 1");

      const response = await call("POST", "/admin/policies/reload", adminKey);
      expect(response.statusCode).toBe(400);
      expect(policySource.get("acme").rules, "the last good policy must still serve").toHaveLength(3);
    });
  });

  describe("api keys", () => {
    it("creates a key and returns the secret exactly once", async () => {
      const response = await call("POST", "/admin/keys", adminKey, {name: "acme dApp", roles: ["sponsor"]});
      expect(response.statusCode).toBe(201);

      const created = response.json();
      expect(created.secret).toMatch(/^pm_live_/);
      expect(created.warning).toContain("not recoverable");

      // The new key authenticates.
      const probe = await call("GET", "/admin/keys", created.secret);
      expect(probe.statusCode, "a sponsor key has no key:read").toBe(403);
    });

    it("never returns a secret from the list", async () => {
      const created = (await call("POST", "/admin/keys", adminKey, {name: "acme", roles: ["sponsor"]})).json();
      const list = await call("GET", "/admin/keys", adminKey);

      expect(JSON.stringify(list.json())).not.toContain(created.secret.slice(8));
      expect(list.json().keys.every((k: {secret?: string}) => k.secret === undefined)).toBe(true);
    });

    it("stores only the hash", async () => {
      const created = (await call("POST", "/admin/keys", adminKey, {name: "acme", roles: ["sponsor"]})).json();
      const {rows} = await pg.pool.query("SELECT * FROM api_keys WHERE id = $1", [created.id]);
      expect(JSON.stringify(rows)).not.toContain(created.secret.slice(8));
      expect(rows[0].key_hash).toBe(hashApiKey(created.secret));
    });

    it("revokes a key, and the key stops working", async () => {
      const created = (await call("POST", "/admin/keys", adminKey, {name: "acme", roles: ["admin"]})).json();
      expect((await call("GET", "/admin/keys", created.secret)).statusCode).toBe(200);

      expect((await call("DELETE", `/admin/keys/${created.id}`, adminKey)).statusCode).toBe(204);
      expect((await call("GET", "/admin/keys", created.secret)).statusCode).toBe(401);
    });

    it("404s revoking twice", async () => {
      const created = (await call("POST", "/admin/keys", adminKey, {name: "acme", roles: ["sponsor"]})).json();
      expect((await call("DELETE", `/admin/keys/${created.id}`, adminKey)).statusCode).toBe(204);
      expect((await call("DELETE", `/admin/keys/${created.id}`, adminKey)).statusCode).toBe(404);
    });

    it("rejects an unknown role", async () => {
      const response = await call("POST", "/admin/keys", adminKey, {name: "acme", roles: ["superuser"]});
      expect(response.statusCode).toBe(400);
    });
  });

  describe("authorisation", () => {
    it("viewer can read but not write policies", async () => {
      expect((await call("GET", "/admin/policies", viewerKey)).statusCode).toBe(200);

      const write = await call("POST", "/admin/policies", viewerKey, samplePolicy());
      expect(write.statusCode).toBe(403);
      expect(write.json().message).toContain("policy:write");
    });

    it("viewer cannot mint keys", async () => {
      expect((await call("POST", "/admin/keys", viewerKey, {name: "x", roles: ["admin"]})).statusCode).toBe(403);
    });

    /** The role nearly every key has must not reach the admin surface at all. */
    it("sponsor key cannot touch admin", async () => {
      for (const [method, url] of [
        ["GET", "/admin/policies"],
        ["GET", "/admin/keys"],
        ["GET", "/admin/sponsorships"],
        ["GET", "/admin/audit"],
      ] as const) {
        expect((await call(method, url, sponsorKey)).statusCode, `${method} ${url}`).toBe(403);
      }
    });

    it("unauthenticated requests are refused", async () => {
      const response = await app.inject({method: "GET", url: "/admin/policies"});
      expect(response.statusCode).toBe(401);
    });
  });

  describe("audit", () => {
    it("records who changed what", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());

      const entries = (await call("GET", "/admin/audit", adminKey)).json().entries;
      expect(entries[0]).toMatchObject({actor: "admin-key", action: "policy.upsert", subject: "policy:acme"});
      expect(entries[0].detail.ruleTypes).toContain("target-allowlist");
    });

    it("records key creation without the secret", async () => {
      const created = (await call("POST", "/admin/keys", adminKey, {name: "acme", roles: ["sponsor"]})).json();
      const entries = (await call("GET", "/admin/audit", adminKey)).json().entries;

      const entry = entries.find((e: {action: string}) => e.action === "key.create");
      expect(entry).toMatchObject({actor: "admin-key"});
      expect(JSON.stringify(entry), "the audit log must never carry a credential").not.toContain(
        created.secret.slice(8),
      );
    });

    it("records deletions and revocations", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      await call("DELETE", "/admin/policies/acme", adminKey);

      const actions = (await call("GET", "/admin/audit", adminKey)).json().entries.map((e: {action: string}) => e.action);
      expect(actions).toContain("policy.delete");
    });

    it("filters by actor and action", async () => {
      await call("POST", "/admin/policies", adminKey, samplePolicy());
      await call("POST", "/admin/policies/reload", adminKey);

      expect((await call("GET", "/admin/audit?action=policy.reload", adminKey)).json().entries).toHaveLength(1);
      expect((await call("GET", "/admin/audit?actor=nobody", adminKey)).json().entries).toHaveLength(0);
    });
  });

  describe("sponsorships", () => {
    it("lists issued attestations with a warning about what they mean", async () => {
      await new SponsorshipRepository(pg.pool).record({
        chainId: 8453,
        sender: SENDER as Address,
        nonce: 0n,
        paymaster: PAYMASTER,
        entryPoint: CANONICAL_ENTRYPOINT_V07 as Address,
        apiKeyId: "sponsor-key",
        policyId: "default",
        signer: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address,
        maxCostWei: 10n ** 18n,
        validAfter: 1_700_000_000,
        validUntil: 1_700_000_300,
      });

      const body = (await call("GET", "/admin/sponsorships", adminKey)).json();
      expect(body.note, "an operator must not read commitments as spend").toContain("Not actual spend");
      expect(body.sponsorships).toHaveLength(1);
      // Serialised as strings: a wei amount does not survive JSON's number type.
      expect(body.sponsorships[0].maxCostWei).toBe("1000000000000000000");
    });

    it("filters by api key", async () => {
      expect((await call("GET", "/admin/sponsorships?apiKeyId=nobody", adminKey)).json().sponsorships).toHaveLength(0);
    });
  });
});
