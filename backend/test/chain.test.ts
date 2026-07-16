import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {parseEther, type Address} from "viem";

import {
  CANONICAL_ENTRYPOINT_V07,
  InvalidChainConfigError,
  validateChainConfig,
  validateChainConfigs,
  type ChainConfig,
} from "../src/chain/chainConfig.js";
import {ChainRegistry, ChainDisabledError, UnknownChainError} from "../src/chain/chainRegistry.js";
import {ChainAdapter} from "../src/chain/chainAdapter.js";
import {deploy, loadArtifact, startAnvil, type AnvilInstance} from "./support/anvil.js";

const PAYMASTER = "0x1111111111111111111111111111111111111111" as Address;

function config(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId: 8453,
    name: "Base",
    rpcUrls: ["https://base.example.com"],
    entryPoint: CANONICAL_ENTRYPOINT_V07,
    paymaster: PAYMASTER,
    explorerUrl: "https://basescan.org",
    nativeCurrency: {symbol: "ETH", decimals: 18},
    minDepositWei: parseEther("0.5"),
    minStakeWei: parseEther("1"),
    enabled: true,
    ...overrides,
  };
}

describe("validateChainConfig", () => {
  it("accepts a well-formed config with no warnings", () => {
    const {config: validated, warnings} = validateChainConfig(config());
    expect(validated.chainId).toBe(8453);
    expect(warnings).toHaveLength(0);
  });

  it("normalises addresses to checksummed form", () => {
    const {config: validated} = validateChainConfig(config({paymaster: PAYMASTER.toLowerCase() as Address}));
    expect(validated.paymaster).toBe("0x1111111111111111111111111111111111111111");
  });

  it("rejects an invalid chainId", () => {
    expect(() => validateChainConfig(config({chainId: 0}))).toThrow(InvalidChainConfigError);
    expect(() => validateChainConfig(config({chainId: -1}))).toThrow(InvalidChainConfigError);
    expect(() => validateChainConfig(config({chainId: 1.5}))).toThrow(InvalidChainConfigError);
  });

  it("rejects an empty name", () => {
    expect(() => validateChainConfig(config({name: "   "}))).toThrow(InvalidChainConfigError);
  });

  it("requires at least one RPC URL", () => {
    expect(() => validateChainConfig(config({rpcUrls: []}))).toThrow(/at least one RPC/);
  });

  it("rejects malformed RPC URLs", () => {
    expect(() => validateChainConfig(config({rpcUrls: ["not a url"]}))).toThrow(/not a valid URL/);
    expect(() => validateChainConfig(config({rpcUrls: ["ws://base.example.com"]}))).toThrow(/must be http/);
  });

  it("warns about plaintext http to a remote host but allows localhost", () => {
    expect(validateChainConfig(config({rpcUrls: ["http://remote.example.com"]})).warnings).toHaveLength(1);
    expect(validateChainConfig(config({rpcUrls: ["http://localhost:8545"]})).warnings).toHaveLength(0);
  });

  it("rejects malformed addresses", () => {
    expect(() => validateChainConfig(config({paymaster: "0xnope" as Address}))).toThrow(/not a valid address/);
    expect(() => validateChainConfig(config({entryPoint: "0x123" as Address}))).toThrow(/not a valid address/);
  });

  /** A config where these collide is nonsense that would otherwise surface as bizarre reverts. */
  it("rejects entryPoint == paymaster", () => {
    expect(() => validateChainConfig(config({paymaster: CANONICAL_ENTRYPOINT_V07}))).toThrow(/must not be the same/);
  });

  it("warns when the entryPoint is not the canonical v0.7 address", () => {
    const {warnings} = validateChainConfig(config({entryPoint: "0x2222222222222222222222222222222222222222"}));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("canonical");
  });

  it("rejects negative thresholds", () => {
    expect(() => validateChainConfig(config({minDepositWei: -1n}))).toThrow(/must not be negative/);
  });

  it("rejects implausible native decimals", () => {
    expect(() => validateChainConfig(config({nativeCurrency: {symbol: "X", decimals: -1}}))).toThrow(/decimals/);
    expect(() => validateChainConfig(config({nativeCurrency: {symbol: "X", decimals: 99}}))).toThrow(/decimals/);
  });
});

describe("validateChainConfigs", () => {
  it("accepts a multi-chain set", () => {
    const {configs} = validateChainConfigs([config(), config({chainId: 42_161, name: "Arbitrum"})]);
    expect(configs).toHaveLength(2);
  });

  it("rejects duplicate chain ids rather than silently picking one", () => {
    expect(() => validateChainConfigs([config(), config()])).toThrow(/duplicate chain id/);
  });

  it("collects warnings across the set", () => {
    const {warnings} = validateChainConfigs([
      config({rpcUrls: ["http://a.example.com"]}),
      config({chainId: 1, rpcUrls: ["http://b.example.com"]}),
    ]);
    expect(warnings).toHaveLength(2);
  });
});

describe("ChainRegistry", () => {
  it("serves configured, enabled chains", () => {
    const registry = ChainRegistry.fromConfigs([config()]);
    expect(registry.get(8453).chainId).toBe(8453);
    expect(registry.enabledChainIds).toEqual([8453]);
  });

  /** "Not configured" and "disabled" mean different things to a caller and must not be conflated. */
  it("distinguishes unknown from disabled", () => {
    const registry = ChainRegistry.fromConfigs([config({enabled: false})]);
    expect(() => registry.get(8453)).toThrow(ChainDisabledError);
    expect(() => registry.get(999)).toThrow(UnknownChainError);
  });

  it("exposes disabled chains to the admin path", () => {
    const registry = ChainRegistry.fromConfigs([config({enabled: false})]);
    expect(registry.getEvenIfDisabled(8453).chainId).toBe(8453);
    expect(registry.enabledChainIds).toEqual([]);
    expect(registry.allChainIds).toEqual([8453]);
  });

  it("fails construction on an invalid config", () => {
    expect(() => ChainRegistry.fromConfigs([config({rpcUrls: []})])).toThrow(InvalidChainConfigError);
  });

  it("adding a chain requires only configuration", () => {
    // The point of td.md's chain-management requirement: no code path here knows about Optimism.
    const registry = ChainRegistry.fromConfigs([
      config(),
      config({chainId: 10, name: "Optimism", rpcUrls: ["https://op.example.com"]}),
    ]);
    expect(registry.enabledChainIds).toEqual([8453, 10]);
  });
});

describe("ChainAdapter against a live node", () => {
  let anvil: AnvilInstance;
  let entryPoint: Address;
  let paymaster: Address;
  let adapter: ChainAdapter;

  beforeAll(async () => {
    anvil = await startAnvil();
    entryPoint = await deploy(anvil, loadArtifact("EntryPoint.sol", "EntryPoint"));
    paymaster = await deploy(anvil, loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster"), [
      entryPoint,
      anvil.deployer,
      anvil.deployer,
    ]);

    adapter = ChainAdapter.create(
      config({
        chainId: 31_337,
        name: "Anvil",
        rpcUrls: [anvil.rpcUrl],
        entryPoint,
        paymaster,
        minDepositWei: parseEther("1"),
        minStakeWei: parseEther("1"),
      }),
    );
  }, 60_000);

  afterAll(() => anvil?.stop());

  it("reports healthy against a live node", async () => {
    const health = await adapter.health();
    expect(health.healthy).toBe(true);
    expect(health.blockNumber).toBeGreaterThanOrEqual(0n);
  });

  /** A health check must never throw; it has to be able to report unhealthy. */
  it("reports unhealthy instead of throwing when the RPC is unreachable", async () => {
    const dead = ChainAdapter.create(config({rpcUrls: ["http://127.0.0.1:1"]}));
    const health = await dead.health();
    expect(health.healthy).toBe(false);
    expect(health.error).toBeDefined();
  });

  it("reads deposit and stake from the EntryPoint", async () => {
    expect((await adapter.getDepositInfo()).deposit).toBe(0n);

    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: paymaster,
        abi: loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster").abi,
        functionName: "deposit",
        value: parseEther("2"),
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      }),
    });

    const info = await adapter.getDepositInfo();
    expect(info.deposit).toBe(parseEther("2"));
    expect(info.staked).toBe(false);
  });

  it("flags funding below the configured thresholds", async () => {
    const funding = await adapter.getPaymasterFunding();
    expect(funding.deposit).toBe(parseEther("2"));
    expect(funding.depositBelowThreshold, "2 ETH is above the 1 ETH deposit threshold").toBe(false);
    expect(funding.stakeBelowThreshold, "no stake is below the 1 ETH stake threshold").toBe(true);
  });

  it("sees stake once it is added", async () => {
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: paymaster,
        abi: loadArtifact("VerifyingPaymaster.sol", "VerifyingPaymaster").abi,
        functionName: "addStake",
        args: [86_400],
        value: parseEther("3"),
        account: anvil.walletClient.account!,
        chain: anvil.walletClient.chain!,
      }),
    });

    const funding = await adapter.getPaymasterFunding();
    expect(funding.staked).toBe(true);
    expect(funding.stake).toBe(parseEther("3"));
    expect(funding.unstakeDelaySec).toBe(86_400);
    expect(funding.stakeBelowThreshold).toBe(false);
  });

  it("accepts an RPC that serves the configured chain", async () => {
    await expect(adapter.verifyChainId()).resolves.toBeUndefined();
  });

  /**
   * The misconfiguration this catches: pointing one chain's config at another chain's RPC. Every
   * signature would be bound to the wrong chainId and every sponsorship would fail with AA34.
   */
  it("rejects an RPC that serves a different chain", async () => {
    const wrong = ChainAdapter.create(config({chainId: 8453, rpcUrls: [anvil.rpcUrl]}));
    await expect(wrong.verifyChainId()).rejects.toThrow(/reports chainId 31337/);
  });

  it("reads native balances", async () => {
    expect(await adapter.getNativeBalance(anvil.deployer)).toBeGreaterThan(0n);
  });
});
