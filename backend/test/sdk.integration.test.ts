import "reflect-metadata";

import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {NestFactory} from "@nestjs/core";
import {FastifyAdapter, type NestFastifyApplication} from "@nestjs/platform-fastify";
import {encodeFunctionData, parseAbi, parseEther, toHex, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {
  getUserOperationHash,
  SponsoredBundlerClient,
  PaymasterClient,
  BundlerClient,
  type UserOperation,
} from "@paymaster/sdk";

import {AppModule, type AppDependencies} from "../src/api/app.module.js";
import {DomainErrorFilter} from "../src/api/filters/domainError.filter.js";
import {generateApiKey} from "../src/auth/apiKey.js";
import {InMemoryApiKeyStore} from "../src/auth/inMemoryApiKeyStore.js";
import type {ChainConfig} from "../src/chain/chainConfig.js";
import {ChainRegistry} from "../src/chain/chainRegistry.js";
import {PolicySource} from "../src/policy/policySource.js";
import {ChainEnabledRule} from "../src/policy/rules/accessLists.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";
import type {Env} from "../src/config/env.js";
import {packUint128Pair, type PackedUserOperation} from "../src/domain/userOperation.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";
import {rundlerAvailable, startBundler, type BundlerInstance} from "./support/bundler.js";

/**
 * The SDK against the WHOLE platform: SDK -> real backend (sponsor) -> real bundler (send) ->
 * on-chain. This is the claim td2.md makes — "the frontend SDK should automatically interact with
 * both the bundler and paymaster" — turned into something executable.
 *
 * Two levels run here:
 *   - the SDK's local getUserOperationHash, asserted equal to the deployed EntryPoint's own
 *     getUserOpHash. If those disagree, the wallet signs the wrong hash and every operation the
 *     SDK builds is rejected with an opaque error.
 *   - the full send, which needs the rundler binary and so skips when it is absent.
 */
const describeBundler = rundlerAvailable() ? describe : describe.skip;

describe("SDK userOpHash <-> EntryPoint (differential)", () => {
  let anvil: AnvilInstance;
  let entryPoint: Address;
  let entryPointAbi: ReturnType<typeof loadArtifact>["abi"];
  let chainId: number;

  const SENDER = "0x1234567890123456789012345678901234567890" as Address;
  const PAYMASTER = "0x1111111111111111111111111111111111111111" as Address;

  beforeAll(async () => {
    anvil = await startAnvil();
    chainId = await anvil.publicClient.getChainId();
    const artifact = loadArtifact("EntryPoint.sol", "EntryPoint");
    entryPointAbi = artifact.abi;
    entryPoint = await deploy(anvil, artifact);
  }, 60_000);

  afterAll(() => anvil?.stop());

  function sdkOp(over: Partial<UserOperation> = {}): UserOperation {
    return {
      sender: SENDER,
      nonce: 0n,
      callData: "0xdeadbeef",
      callGasLimit: 200_000n,
      verificationGasLimit: 500_000n,
      preVerificationGas: 100_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      signature: "0x",
      ...over,
    };
  }

  /** The same operation in the packed on-chain shape, for EntryPoint.getUserOpHash. */
  function packed(op: UserOperation): PackedUserOperation {
    const paymasterAndData =
      op.paymaster === undefined
        ? "0x"
        : (`${op.paymaster}${toHex(op.paymasterVerificationGasLimit ?? 0n, {size: 16}).slice(2)}${toHex(op.paymasterPostOpGasLimit ?? 0n, {size: 16}).slice(2)}${(op.paymasterData ?? "0x").slice(2)}` as Hex);
    return {
      sender: op.sender,
      nonce: op.nonce,
      initCode: op.factory === undefined ? "0x" : (`${op.factory}${(op.factoryData ?? "0x").slice(2)}` as Hex),
      callData: op.callData,
      accountGasLimits: toHex(packUint128Pair(op.verificationGasLimit, op.callGasLimit), {size: 32}),
      preVerificationGas: op.preVerificationGas,
      gasFees: toHex(packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas), {size: 32}),
      paymasterAndData,
      signature: "0x",
    };
  }

  async function onChainHash(op: UserOperation): Promise<Hex> {
    return anvil.publicClient.readContract({
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "getUserOpHash",
      args: [packed(op)],
    }) as Promise<Hex>;
  }

  it("matches the contract for a bare operation", async () => {
    const op = sdkOp();
    expect(getUserOperationHash(op, entryPoint, chainId)).toBe(await onChainHash(op));
  });

  it("matches across varied fields", async () => {
    const cases: UserOperation[] = [
      sdkOp({callData: "0x"}),
      sdkOp({nonce: 2n ** 200n}),
      sdkOp({callData: `0x${"ab".repeat(500)}`}),
      sdkOp({factory: PAYMASTER, factoryData: "0xabcdef"}),
      sdkOp({paymaster: PAYMASTER, paymasterVerificationGasLimit: 300_000n, paymasterPostOpGasLimit: 50_000n, paymasterData: "0xcafe"}),
      sdkOp({preVerificationGas: 2n ** 100n}),
    ];
    for (const op of cases) {
      const label = JSON.stringify(op, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(getUserOperationHash(op, entryPoint, chainId), label).toBe(await onChainHash(op));
    }
  });
});

describeBundler("SDK drives the whole platform (SDK -> backend -> bundler -> chain)", () => {
  let anvil: AnvilInstance;
  let bundler: BundlerInstance;
  let app: NestFastifyApplication;
  let backendUrl: string;
  let entryPoint: Address;
  let paymaster: Address;
  let account: Address;
  let chainId: number;
  let apiKey: string;

  const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const signer = privateKeyToAccount(signerKey);
  const accountOwnerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
  const accountOwner = privateKeyToAccount(accountOwnerKey);
  const builderKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

  beforeAll(async () => {
    anvil = await startAnvil();
    chainId = await anvil.publicClient.getChainId();

    const code = await fetchMulticall3Code();
    await anvil.publicClient.request({method: "anvil_setCode" as never, params: [MULTICALL3, code] as never});

    const epArtifact = loadArtifact("EntryPoint.sol", "EntryPoint");
    entryPoint = await deploy(anvil, epArtifact);

    const factory = await deploy(anvil, loadArtifact("SimpleAccountFactory.sol", "SimpleAccountFactory"), [entryPoint]);
    const factoryAbi = parseAbi([
      "function createAccount(address owner, uint256 salt) returns (address)",
      "function getAddress(address owner, uint256 salt) view returns (address)",
    ]);
    account = await anvil.publicClient.readContract({address: factory, abi: factoryAbi, functionName: "getAddress", args: [accountOwner.address, 0n]});
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({address: factory, abi: factoryAbi, functionName: "createAccount", args: [accountOwner.address, 0n], account: anvil.walletClient.account!, chain: anvil.walletClient.chain!}),
    });

    const pmArtifact = loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster");
    paymaster = await deploy(anvil, pmArtifact, [entryPoint, anvil.deployer, signer.address]);
    const send = async (fn: string, args: unknown[], value: bigint) => {
      // await the write BEFORE awaiting the receipt: passing the pending promise as `hash` sends
      // eth_getTransactionByHash a `{}` and fails with an opaque "expected 32 bytes" error.
      const hash = await anvil.walletClient.writeContract({
        address: paymaster,
        abi: pmArtifact.abi,
        functionName: fn,
        args: args as never,
        value,
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      });
      await anvil.publicClient.waitForTransactionReceipt({hash});
    };
    await send("deposit", [], parseEther("10"));
    await send("addStake", [86_400], parseEther("1"));

    // The real backend, listening on a real port so the SDK talks to it over HTTP.
    const keyGen = generateApiKey("test");
    apiKey = keyGen.secret;
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
    const policySource = new PolicySource({load: async () => [{id: "default", rules: [new ChainEnabledRule([chainId])]}]});
    await policySource.reload();

    const env: Env = {
      NODE_ENV: "test", PORT: 0, HOST: "127.0.0.1",
      SPONSORSHIP_SIGNER_KEY: signerKey, CHAINS: "[]",
      SPONSORSHIP_VALIDITY_SECONDS: 300, PAYMASTER_VERIFICATION_GAS_LIMIT: 300_000n,
      POSTOP_GAS_LIMIT: 50_000n, DEFAULT_POLICY_ID: "default",
      DATABASE_MAX_CONNECTIONS: 5, DATABASE_MIGRATE_ON_BOOT: true,
    };
    const deps: AppDependencies = {
      chains: ChainRegistry.fromConfigs([chainConfig]),
      policies: policySource,
      signer: new LocalSponsorshipSigner(signerKey),
      apiKeys: new InMemoryApiKeyStore([
        {id: "k", name: "sdk", hash: keyGen.hash, displayPrefix: keyGen.displayPrefix, roles: ["sponsor"], policyId: undefined, enabled: true, createdAt: 0, expiresAt: undefined, lastUsedAt: undefined},
      ]),
      quotasAreLocal: true,
      env,
    };
    app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(deps), new FastifyAdapter(), {logger: false});
    app.useGlobalFilters(new DomainErrorFilter());
    await app.listen({port: 0, host: "127.0.0.1"});
    const address = app.getHttpServer().address();
    backendUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    bundler = await startBundler({nodeHttp: anvil.rpcUrl, entryPoint, chainId, builderKey});
  }, 180_000);

  afterAll(async () => {
    bundler?.stop();
    await app?.close();
    anvil?.stop();
  });

  function client(): SponsoredBundlerClient {
    return new SponsoredBundlerClient({
      entryPoint,
      chainId,
      bundler: {endpoint: bundler.rpcUrl},
      paymaster: {endpoint: backendUrl, apiKey},
    });
  }

  async function currentNonce(): Promise<bigint> {
    return anvil.publicClient.readContract({
      address: entryPoint,
      abi: loadArtifact("EntryPoint.sol", "EntryPoint").abi,
      functionName: "getNonce",
      args: [account, 0n],
    }) as Promise<bigint>;
  }

  async function viableMaxFee(): Promise<bigint> {
    const block = await anvil.publicClient.getBlock();
    return (block.baseFeePerGas ?? 1_000_000_000n) * 2n + 1_000_000_000n;
  }

  const callData = encodeFunctionData({
    abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
    functionName: "execute",
    args: ["0x000000000000000000000000000000000000dEaD", 0n, "0x"],
  });

  /** The td.md example, made real: one call sponsors and sends, account pays nothing. */
  it("sponsors and sends a UserOperation, account pays nothing", async () => {
    const balanceBefore = await anvil.publicClient.getBalance({address: account});
    expect(balanceBefore).toBe(0n);

    const receipt = await client().sendUserOperation(
      {sender: account, nonce: await currentNonce(), callData},
      {
        maxFeePerGas: await viableMaxFee(),
        maxPriorityFeePerGas: 1_000_000_000n,
        // SimpleAccount verifies an EIP-191 personal-signed hash.
        signUserOperationHash: (hash) => accountOwner.signMessage({message: {raw: hash}}),
        waitTimeoutMs: 60_000,
      },
    );

    expect(receipt.success).toBe(true);
    expect(receipt.actualGasCost).toBeGreaterThan(0n);
    expect(await anvil.publicClient.getBalance({address: account}), "the account must still hold nothing").toBe(0n);
  }, 120_000);

  it("prepareUserOperation produces a submittable, sponsored, signed op", async () => {
    const op = await client().prepareUserOperation(
      {sender: account, nonce: await currentNonce(), callData},
      {maxFeePerGas: await viableMaxFee(), maxPriorityFeePerGas: 1_000_000_000n, signUserOperationHash: (h) => accountOwner.signMessage({message: {raw: h}})},
    );

    expect(op.paymaster?.toLowerCase()).toBe(paymaster.toLowerCase());
    expect(op.signature).not.toBe("0x");
    // Gas limits came back from the bundler's estimate, not the placeholder.
    expect(op.verificationGasLimit).toBeGreaterThan(0n);
  }, 90_000);

  it("the low-level clients interoperate too", async () => {
    const bundlerClient = new BundlerClient({endpoint: bundler.rpcUrl});
    const paymasterClient = new PaymasterClient({endpoint: backendUrl, chainId, apiKey});

    expect((await bundlerClient.supportedEntryPoints()).map((e) => e.toLowerCase())).toContain(entryPoint.toLowerCase());
    expect(await bundlerClient.chainId()).toBe(chainId);

    // PaymasterClient alone still returns a usable sponsorship.
    const sponsorship = await paymasterClient.sponsor({
      sender: account, nonce: await currentNonce(), callData,
      callGasLimit: 200_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n,
      maxFeePerGas: await viableMaxFee(), maxPriorityFeePerGas: 1_000_000_000n, signature: "0x",
    });
    expect(sponsorship.paymaster.toLowerCase()).toBe(paymaster.toLowerCase());
  }, 90_000);
});

async function fetchMulticall3Code(): Promise<Hex> {
  const {readFile, writeFile, mkdir} = await import("node:fs/promises");
  const {dirname, resolve} = await import("node:path");
  const {fileURLToPath} = await import("node:url");
  const cache = resolve(dirname(fileURLToPath(import.meta.url)), "../.bundler/multicall3.hex");
  try {
    return (await readFile(cache, "utf8")).trim() as Hex;
  } catch {
    const res = await fetch("https://ethereum-rpc.publicnode.com", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [MULTICALL3_ADDR, "latest"]}),
    });
    const {result} = (await res.json()) as {result: Hex};
    await mkdir(dirname(cache), {recursive: true});
    await writeFile(cache, result);
    return result;
  }
}

const MULTICALL3_ADDR = "0xcA11bde05977b3631167028862bE2a173976CA11";
