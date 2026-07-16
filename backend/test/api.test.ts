import "reflect-metadata";

import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {NestFactory} from "@nestjs/core";
import {FastifyAdapter, type NestFastifyApplication} from "@nestjs/platform-fastify";
import {encodeFunctionData, parseAbi, parseEther, toHex, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {AppModule, type AppDependencies} from "../src/api/app.module.js";
import {DomainErrorFilter} from "../src/api/filters/domainError.filter.js";
import {CANONICAL_ENTRYPOINT_V07, type ChainConfig} from "../src/chain/chainConfig.js";
import {ChainRegistry} from "../src/chain/chainRegistry.js";
import type {Policy} from "../src/policy/engine.js";
import {PolicySource} from "../src/policy/policySource.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {ChainEnabledRule, SenderBlocklistRule} from "../src/policy/rules/accessLists.js";
import {QuotaRule} from "../src/policy/rules/quotaRules.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import type {Env} from "../src/config/env.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";

/**
 * The full vertical slice: an HTTP request in, a sponsorship out, and the sponsorship actually
 * executed by a real EntryPoint.
 *
 * Everything below the controller is the real component — real policy engine, real signature
 * engine, real contracts on a real node. The only thing constructed for the test is the chain
 * config pointing at anvil.
 */
describe("POST /paymaster/sponsor", () => {
  let anvil: AnvilInstance;
  let app: NestFastifyApplication;
  let entryPoint: Address;
  let paymaster: Address;
  let account: Address;
  let entryPointAbi: ReturnType<typeof loadArtifact>["abi"];
  let chainId: number;
  let blockedPolicyId: string;

  const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const signer = privateKeyToAccount(signerKey);
  const accountOwnerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
  const accountOwner = privateKeyToAccount(accountOwnerKey);

  const env: Env = {
    NODE_ENV: "test",
    PORT: 0,
    HOST: "127.0.0.1",
    SPONSORSHIP_SIGNER_KEY: signerKey,
    CHAINS: "[]",
    SPONSORSHIP_VALIDITY_SECONDS: 300,
    PAYMASTER_VERIFICATION_GAS_LIMIT: 300_000n,
    POSTOP_GAS_LIMIT: 50_000n,
    DEFAULT_POLICY_ID: "default",
  };

  beforeAll(async () => {
    anvil = await startAnvil();
    chainId = await anvil.publicClient.getChainId();

    const entryPointArtifact = loadArtifact("EntryPoint.sol", "EntryPoint");
    entryPointAbi = entryPointArtifact.abi;
    entryPoint = await deploy(anvil, entryPointArtifact);

    const factory = await deploy(anvil, loadArtifact("SimpleAccountFactory.sol", "SimpleAccountFactory"), [entryPoint]);
    const factoryAbi = parseAbi([
      "function createAccount(address owner, uint256 salt) returns (address)",
      "function getAddress(address owner, uint256 salt) view returns (address)",
    ]);
    account = await anvil.publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getAddress",
      args: [accountOwner.address, 0n],
    });
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: "createAccount",
        args: [accountOwner.address, 0n],
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      }),
    });

    const paymasterArtifact = loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster");
    paymaster = await deploy(anvil, paymasterArtifact, [entryPoint, anvil.deployer, signer.address]);

    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: paymaster,
        abi: paymasterArtifact.abi,
        functionName: "deposit",
        value: parseEther("10"),
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      }),
    });
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: paymaster,
        abi: paymasterArtifact.abi,
        functionName: "addStake",
        args: [86_400],
        value: parseEther("1"),
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      }),
    });

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

    const store = new InMemoryQuotaStore();
    blockedPolicyId = "blocked";
    const policies: readonly Policy[] = [
      {
        id: "default",
        rules: [
          new ChainEnabledRule([chainId]),
          new QuotaRule(store, {
            name: "wallet-daily",
            subject: "wallet",
            unit: "operations",
            limit: 1_000n,
            windowSeconds: 86_400,
          }),
        ],
      },
      {id: blockedPolicyId, rules: [new SenderBlocklistRule([account])]},
      {
        id: "tiny-quota",
        rules: [
          new QuotaRule(store, {
            name: "tiny",
            subject: "wallet",
            unit: "operations",
            limit: 1n,
            windowSeconds: 86_400,
          }),
        ],
      },
    ];

    const policySource = new PolicySource({load: async () => policies});
    await policySource.reload();

    const deps: AppDependencies = {
      chains: ChainRegistry.fromConfigs([chainConfig, {...chainConfig, chainId: 999_999, enabled: false}]),
      policies: policySource,
      signer: new LocalSponsorshipSigner(signerKey),
      env,
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
    anvil?.stop();
  });

  const CALL_GAS = 200_000n;
  const VERIFICATION_GAS = 500_000n;
  const PRE_VERIFICATION_GAS = 100_000n;
  const MAX_FEE = 20_000_000_000n;
  const MAX_PRIORITY_FEE = 1_000_000_000n;

  const CALL_DATA = encodeFunctionData({
    abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
    functionName: "execute",
    args: ["0x000000000000000000000000000000000000dEaD", 0n, "0x"],
  });

  interface BodyOverrides {
    chainId?: number;
    policyId?: string;
    userOperation?: Record<string, unknown>;
  }

  function requestBody(overrides: BodyOverrides = {}): Record<string, unknown> {
    const {userOperation, ...rest} = overrides;
    return {
      chainId,
      ...rest,
      userOperation: {
        sender: account,
        nonce: "0x0",
        callData: CALL_DATA,
        callGasLimit: toHex(CALL_GAS),
        verificationGasLimit: toHex(VERIFICATION_GAS),
        preVerificationGas: toHex(PRE_VERIFICATION_GAS),
        maxFeePerGas: toHex(MAX_FEE),
        maxPriorityFeePerGas: toHex(MAX_PRIORITY_FEE),
        ...userOperation,
      },
    };
  }

  async function post(url: string, payload: unknown) {
    return app.inject({method: "POST", url, payload: payload as object});
  }

  it("returns a sponsorship for a valid request", async () => {
    const response = await post("/paymaster/sponsor", requestBody());
    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.paymaster.toLowerCase()).toBe(paymaster.toLowerCase());
    expect(body.paymasterAndData).toMatch(/^0x[0-9a-f]+$/i);
    expect(body.metadata.signer).toBe(signer.address);
    expect(body.metadata.chainId).toBe(chainId);
    expect(BigInt(body.metadata.maxCost)).toBeGreaterThan(0n);
    expect(body.validUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(new Date(body.expiresAt).getTime()).toBe(body.validUntil * 1000);
  });

  /** The v0.7 unpacked fields and paymasterAndData must describe the same bytes. */
  it("returns unpacked paymaster fields consistent with paymasterAndData", async () => {
    const body = (await post("/paymaster/sponsor", requestBody())).json();

    const rebuilt =
      body.paymaster.toLowerCase() +
      BigInt(body.paymasterVerificationGasLimit).toString(16).padStart(32, "0") +
      BigInt(body.paymasterPostOpGasLimit).toString(16).padStart(32, "0") +
      body.paymasterData.slice(2);

    expect(body.paymasterAndData.toLowerCase()).toBe(rebuilt.toLowerCase());
  });

  /**
   * The claim the whole service exists to make: what this endpoint returns gets an operation
   * sponsored by a real EntryPoint, with the account paying nothing.
   */
  it("returns a sponsorship a real EntryPoint accepts", async () => {
    const nonce = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "getNonce",
      args: [account, 0n],
    })) as bigint;

    const body = (await post("/paymaster/sponsor", requestBody({userOperation: {nonce: toHex(nonce)}}))).json();

    // Reassemble the op exactly as a client would: the same fields we sent, plus the
    // paymasterAndData the endpoint handed back.
    const packed = {
      sender: account,
      nonce,
      initCode: "0x" as Hex,
      callData: CALL_DATA,
      accountGasLimits: toHex((VERIFICATION_GAS << 128n) | CALL_GAS, {size: 32}),
      preVerificationGas: PRE_VERIFICATION_GAS,
      gasFees: toHex((MAX_PRIORITY_FEE << 128n) | MAX_FEE, {size: 32}),
      paymasterAndData: body.paymasterAndData as Hex,
      signature: "0x" as Hex,
    };

    const userOpHash = (await anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "getUserOpHash",
      args: [packed],
    })) as Hex;
    const signed = {...packed, signature: await accountOwner.signMessage({message: {raw: userOpHash}})};

    const balanceBefore = await anvil.publicClient.getBalance({address: account});
    const receipt = await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: entryPoint,
        abi: entryPointAbi,
        functionName: "handleOps",
        args: [[signed], anvil.deployer],
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      }),
    });

    expect(receipt.status).toBe("success");
    expect(await anvil.publicClient.getBalance({address: account})).toBe(balanceBefore);
    expect(balanceBefore).toBe(0n);
  });

  describe("validation", () => {
    it("rejects a malformed address", async () => {
      const response = await post("/paymaster/sponsor", requestBody({userOperation: {sender: "0xnope"}}));
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("VALIDATION_FAILED");
    });

    it("rejects a missing field", async () => {
      const body = requestBody() as {userOperation: Record<string, unknown>};
      delete body.userOperation["callData"];
      expect((await post("/paymaster/sponsor", body)).statusCode).toBe(400);
    });

    /** Numbers would lose precision above 2^53; fee fields routinely exceed it. */
    it("rejects JSON numbers for quantities", async () => {
      const response = await post("/paymaster/sponsor", requestBody({userOperation: {maxFeePerGas: 20000000000}}));
      expect(response.statusCode).toBe(400);
    });

    it("rejects maxPriorityFeePerGas above maxFeePerGas", async () => {
      const response = await post(
        "/paymaster/sponsor",
        requestBody({userOperation: {maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x2"}}),
      );
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).toContain("maxPriorityFeePerGas");
    });

    it("rejects factory without factoryData", async () => {
      const response = await post(
        "/paymaster/sponsor",
        requestBody({userOperation: {factory: "0x1111111111111111111111111111111111111111"}}),
      );
      expect(response.statusCode).toBe(400);
    });

    it("rejects a value that does not fit uint128", async () => {
      const response = await post("/paymaster/sponsor", requestBody({userOperation: {callGasLimit: toHex(2n ** 128n)}}));
      expect(response.statusCode).toBe(400);
    });

    it("never echoes the request body back in the error", async () => {
      const response = await post("/paymaster/sponsor", requestBody({userOperation: {sender: "0xdeadbeefcafe"}}));
      expect(JSON.stringify(response.json())).not.toContain("deadbeefcafe");
    });
  });

  describe("errors", () => {
    it("400s for an unconfigured chain", async () => {
      const response = await post("/paymaster/sponsor", requestBody({chainId: 123_456}));
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("NOT_CONFIGURED");
    });

    /** Disabled is 503, not 400: the request is fine and may succeed later. */
    it("503s for a configured-but-disabled chain", async () => {
      const response = await post("/paymaster/sponsor", requestBody({chainId: 999_999}));
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("CHAIN_DISABLED");
    });

    it("400s for an unknown policy", async () => {
      const response = await post("/paymaster/sponsor", requestBody({policyId: "does-not-exist"}));
      expect(response.statusCode).toBe(400);
    });

    it("403s when policy denies", async () => {
      const response = await post("/paymaster/sponsor", requestBody({policyId: blockedPolicyId}));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({error: "SPONSORSHIP_DENIED", code: "SENDER_BLOCKED"});
    });

    /** 429, not 403: a quota denial is retryable and clients should back off. */
    it("429s when a quota is exhausted", async () => {
      const first = await post("/paymaster/sponsor", requestBody({policyId: "tiny-quota"}));
      expect(first.statusCode).toBe(201);

      const second = await post("/paymaster/sponsor", requestBody({policyId: "tiny-quota"}));
      expect(second.statusCode).toBe(429);
      expect(second.json().code).toBe("QUOTA_EXCEEDED");
    });

    /** The denial code is safe to return; the reason names rules and thresholds and must not be. */
    it("does not leak the denial reason to the caller", async () => {
      const response = await post("/paymaster/sponsor", requestBody({policyId: blockedPolicyId}));
      const text = JSON.stringify(response.json());
      expect(text).not.toContain("sender-blocklist");
      expect(text).not.toContain("is blocked");
    });
  });

  describe("health", () => {
    it("live returns ok without touching the chain", async () => {
      const response = await app.inject({method: "GET", url: "/health/live"});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({status: "ok"});
    });

    it("ready reports per-chain detail", async () => {
      const response = await app.inject({method: "GET", url: "/health/ready"});
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.status).toBe("ready");
      expect(body.policies.loaded).toBe(true);
      expect(body.chains.find((c: {chainId: number}) => c.chainId === chainId).healthy).toBe(true);
    });
  });
});
