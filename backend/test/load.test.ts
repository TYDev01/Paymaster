import "reflect-metadata";

import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {NestFactory} from "@nestjs/core";
import {FastifyAdapter, type NestFastifyApplication} from "@nestjs/platform-fastify";
import {encodeFunctionData, parseAbi, parseEther, toHex, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {AppModule, type AppDependencies} from "../src/api/app.module.js";
import {DomainErrorFilter} from "../src/api/filters/domainError.filter.js";
import type {ChainConfig} from "../src/chain/chainConfig.js";
import {ChainRegistry} from "../src/chain/chainRegistry.js";
import {generateApiKey} from "../src/auth/apiKey.js";
import {InMemoryApiKeyStore} from "../src/auth/inMemoryApiKeyStore.js";
import type {Policy} from "../src/policy/engine.js";
import {PolicySource} from "../src/policy/policySource.js";
import {RedisQuotaStore} from "../src/policy/quota/redisQuotaStore.js";
import {ChainEnabledRule} from "../src/policy/rules/accessLists.js";
import {QuotaRule} from "../src/policy/rules/quotaRules.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";
import {startRedis, type TestRedis} from "./support/redis.js";
import {testEnv} from "./support/env.js";

/**
 * Load and concurrency behaviour of the sponsorship path — td.md's "load testing".
 *
 * What this asserts is deliberately not a throughput number. A requests-per-second figure measured
 * on whatever machine CI happens to allocate is either so loose it catches nothing or so tight it
 * fails on a noisy runner, and either way it does not describe the property that actually matters.
 * What matters under load is that CORRECTNESS DOES NOT DEGRADE:
 *
 *   1. A quota of N grants exactly N sponsorships when 200 requests arrive at once. Concurrency is
 *      where a check-then-increment quota gives the last unit of budget to every request that read
 *      before any of them wrote — the exact bug `RedisQuotaStore`'s Lua script exists to prevent,
 *      asserted here against a real Redis under real contention rather than argued from the code.
 *   2. Refused requests are refused cleanly. Under load a denial must stay a 429, never a 500: an
 *      error means the caller does not know whether they were charged.
 *   3. Nothing leaks budget. Requests that fail after reserving must release, or a burst
 *      permanently shrinks a caller's quota.
 *
 * Throughput IS measured and printed, as an observation rather than an assertion, so a change that
 * makes the path an order of magnitude slower is visible to whoever reads the output. For real
 * load testing against a deployed instance — connection limits, TLS, the database under sustained
 * write — use deploy/load/k6-sponsor.js, which is the tool for that job.
 */
describe("sponsorship under concurrent load", () => {
  let anvil: AnvilInstance;
  let redisServer: TestRedis;
  let app: NestFastifyApplication;
  let account: Address;
  let chainId: number;
  let apiKey: string;

  const CONCURRENCY = 200;
  const QUOTA = 50n;

  const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const accountOwner = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

  beforeAll(async () => {
    anvil = await startAnvil();
    redisServer = await startRedis();
    chainId = await anvil.publicClient.getChainId();

    const entryPoint = await deploy(anvil, loadArtifact("EntryPoint.sol", "EntryPoint"));
    const factory = await deploy(anvil, loadArtifact("SimpleAccountFactory.sol", "SimpleAccountFactory"), [entryPoint]);
    const factoryAbi = parseAbi([
      "function createAccount(address owner, uint256 salt) returns (address)",
      "function getAddress(address owner, uint256 salt) view returns (address)",
    ]);
    account = (await anvil.publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getAddress",
      args: [accountOwner.address, 0n],
    })) as Address;

    const paymasterArtifact = loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster");
    const paymaster = await deploy(anvil, paymasterArtifact, [
      entryPoint,
      anvil.deployer,
      privateKeyToAccount(signerKey).address,
    ]);

    const chainConfig: ChainConfig = {
      chainId,
      name: "Anvil",
      rpcUrls: [anvil.rpcUrl],
      entryPoint,
      paymaster,
      explorerUrl: "https://example.invalid",
      nativeCurrency: {symbol: "ETH", decimals: 18},
      minDepositWei: parseEther("1"),
      minStakeWei: parseEther("1"),
      enabled: true,
    };

    // A REAL Redis quota store: the whole point is the atomicity of the Lua script under contention,
    // which an in-memory store running on one event loop cannot exercise.
    const quotas = new RedisQuotaStore(redisServer.redis);
    const policies: readonly Policy[] = [
      {
        id: "default",
        rules: [
          new ChainEnabledRule([chainId]),
          new QuotaRule(quotas, {
            name: `load-${Math.random()}`,
            subject: "wallet",
            unit: "operations",
            limit: QUOTA,
            windowSeconds: 86_400,
          }),
        ],
      },
    ];
    const policySource = new PolicySource({load: async () => policies});
    await policySource.reload();

    const generated = generateApiKey("test");
    apiKey = generated.secret;

    const deps: AppDependencies = {
      chains: ChainRegistry.fromConfigs([chainConfig]),
      policies: policySource,
      signer: new LocalSponsorshipSigner(signerKey),
      quotasAreLocal: false,
      apiKeys: new InMemoryApiKeyStore([
        {
          id: "load",
          name: "load",
          hash: generated.hash,
          displayPrefix: generated.displayPrefix,
          roles: ["sponsor"],
          policyId: undefined,
          enabled: true,
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: undefined,
          lastUsedAt: undefined,
        },
      ]),
      env: testEnv(),
    };

    app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(deps), new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await redisServer?.stop();
    anvil?.stop();
  });

  const CALL_DATA = encodeFunctionData({
    abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
    functionName: "execute",
    args: ["0x000000000000000000000000000000000000dEaD", 0n, "0x"],
  });

  function body(nonce: number): Record<string, unknown> {
    return {
      chainId,
      userOperation: {
        sender: account,
        // A distinct nonce per request: identical operations would be a less demanding test, since
        // they would collide on nothing but the quota counter.
        nonce: toHex(nonce),
        callData: CALL_DATA,
        callGasLimit: toHex(200_000n),
        verificationGasLimit: toHex(500_000n),
        preVerificationGas: toHex(100_000n),
        maxFeePerGas: toHex(20_000_000_000n),
        maxPriorityFeePerGas: toHex(1_000_000_000n),
      },
    };
  }

  it("grants exactly the quota when the whole burst arrives at once", async () => {
    const started = performance.now();

    const responses = await Promise.all(
      Array.from({length: CONCURRENCY}, (_, i) =>
        app.inject({
          method: "POST",
          url: "/paymaster/sponsor",
          payload: body(i) as object,
          headers: {authorization: `Bearer ${apiKey}`},
        }),
      ),
    );

    const elapsedMs = performance.now() - started;
    const statuses = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.statusCode] = (acc[r.statusCode] ?? 0) + 1;
      return acc;
    }, {});

    // Observation, not an assertion: a throughput target measured on a CI runner is either
    // meaningless or flaky, but a reader should be able to see the order of magnitude.
    console.log(
      `[load] ${CONCURRENCY} concurrent requests in ${elapsedMs.toFixed(0)}ms ` +
        `(${((CONCURRENCY / elapsedMs) * 1000).toFixed(0)} req/s in-process), statuses: ${JSON.stringify(statuses)}`,
    );

    // The property this test exists for. Anything above 50 means the quota over-granted under
    // contention, which is money spent that policy refused.
    // 201 is the created sponsorship; 429 is the quota refusing one, which is the correct code for
    // "your budget for this window is spent" and is what the SDK retries against.
    expect(statuses[201] ?? 0, `expected exactly ${QUOTA} sponsorships, got ${statuses[201] ?? 0}`).toBe(Number(QUOTA));
    expect(statuses[429] ?? 0, "every request over the quota must be a clean denial").toBe(CONCURRENCY - Number(QUOTA));
    // Not one 5xx: under load a caller must never be left unsure whether they were charged.
    expect(
      Object.keys(statuses)
        .map(Number)
        .filter((s) => s >= 500),
    ).toEqual([]);
  }, 120_000);

  it("does not leak budget: the quota stays exhausted, and not more than exhausted", async () => {
    // The first burst consumed the whole window. Anything granted now would mean a reservation was
    // released that should not have been; a 500 would mean the counter itself was corrupted.
    const after = await app.inject({
      method: "POST",
      url: "/paymaster/sponsor",
      payload: body(9_999) as object,
      headers: {authorization: `Bearer ${apiKey}`},
    });

    expect(after.statusCode).toBe(429);
    expect(JSON.parse(after.body)).toMatchObject({error: expect.any(String)});
  });
});
