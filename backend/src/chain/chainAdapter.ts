import {createPublicClient, fallback, http, parseAbi, type Address, type PublicClient} from "viem";

import type {ChainConfig} from "./chainConfig.js";

/**
 * The slice of the EntryPoint we read. Declared here rather than imported from a generated
 * artifact because these five functions are the stable, specified surface of ERC-4337's
 * StakeManager — pulling in the full EntryPoint ABI would couple the backend's build to the
 * contracts' build for no benefit.
 */
const ENTRYPOINT_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function getDepositInfo(address account) view returns ((uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime))",
]);

export interface DepositInfo {
  readonly deposit: bigint;
  readonly staked: boolean;
  readonly stake: bigint;
  readonly unstakeDelaySec: number;
  readonly withdrawTime: number;
}

export interface ChainHealth {
  readonly chainId: number;
  readonly healthy: boolean;
  readonly blockNumber: bigint | undefined;
  readonly latencyMs: number;
  readonly error: string | undefined;
}

export interface PaymasterFunding {
  readonly chainId: number;
  readonly deposit: bigint;
  readonly stake: bigint;
  readonly staked: boolean;
  readonly unstakeDelaySec: number;
  /** True when the deposit has fallen below the configured threshold. */
  readonly depositBelowThreshold: boolean;
  readonly stakeBelowThreshold: boolean;
}

/**
 * Everything the backend does against one chain.
 *
 * One adapter per configured chain; adapters are constructed from `ChainConfig` alone, which is
 * what makes td.md's config-only chain onboarding real — there is no per-chain branching here.
 *
 * RPC failover uses viem's `fallback` transport rather than a hand-rolled retry loop. It ranks
 * endpoints, retries idempotent reads, and fails over on transport errors. Reimplementing that
 * would mean reimplementing its subtleties (which errors are retryable, how not to hammer a
 * degraded endpoint) with less scrutiny than the library's.
 */
export class ChainAdapter {
  readonly config: ChainConfig;
  readonly #client: PublicClient;

  private constructor(config: ChainConfig, client: PublicClient) {
    this.config = config;
    this.#client = client;
  }

  static create(config: ChainConfig): ChainAdapter {
    const transports = config.rpcUrls.map((url) =>
      http(url, {
        // Retries are per-endpoint; failover to the next endpoint is the fallback transport's job.
        retryCount: 2,
        retryDelay: 150,
        timeout: 10_000,
      }),
    );

    const client = createPublicClient({
      transport:
        transports.length === 1
          ? transports[0]!
          : fallback(transports, {
              // Rank by observed latency and stability so a degraded-but-responding endpoint is
              // demoted instead of being retried into the ground.
              rank: {interval: 30_000, sampleCount: 5},
              retryCount: 1,
            }),
      // The EntryPoint is at the same address everywhere and we only make raw calls, so viem's
      // chain metadata is not needed; chainId is asserted against the RPC in `verifyChainId`.
      batch: {multicall: false},
    });

    return new ChainAdapter(config, client);
  }

  get chainId(): number {
    return this.config.chainId;
  }

  /**
   * Asserts the RPC actually serves the chain the config claims.
   *
   * A copy-pasted config pointing Base's entry at an Arbitrum RPC is an easy mistake and a
   * catastrophic one: signatures are bound to chainId, so every sponsorship would fail, and the
   * deposit monitor would report the wrong chain's balance. Checked once at startup.
   */
  async verifyChainId(): Promise<void> {
    const actual = await this.#client.getChainId();
    if (actual !== this.config.chainId) {
      throw new Error(
        `RPC for chain ${this.config.chainId} (${this.config.name}) reports chainId ${actual}; ` +
          `the configured RPC serves a different chain`,
      );
    }
  }

  /** Deposit and stake for our paymaster, read from the EntryPoint in one call. */
  async getDepositInfo(): Promise<DepositInfo> {
    const info = await this.#client.readContract({
      address: this.config.entryPoint,
      abi: ENTRYPOINT_ABI,
      functionName: "getDepositInfo",
      args: [this.config.paymaster],
    });

    return {
      deposit: info.deposit,
      staked: info.staked,
      stake: info.stake,
      unstakeDelaySec: info.unstakeDelaySec,
      withdrawTime: info.withdrawTime,
    };
  }

  /** Deposit and stake, evaluated against the configured thresholds. */
  async getPaymasterFunding(): Promise<PaymasterFunding> {
    const info = await this.getDepositInfo();
    return {
      chainId: this.config.chainId,
      deposit: info.deposit,
      stake: info.stake,
      staked: info.staked,
      unstakeDelaySec: info.unstakeDelaySec,
      depositBelowThreshold: info.deposit < this.config.minDepositWei,
      stakeBelowThreshold: info.stake < this.config.minStakeWei,
    };
  }

  async getNativeBalance(address: Address): Promise<bigint> {
    return this.#client.getBalance({address});
  }

  /**
   * Liveness probe. Never throws: a health check that throws cannot report unhealthy, and this
   * feeds both the readiness endpoint and the RPC-failure alert.
   */
  async health(): Promise<ChainHealth> {
    const started = performance.now();
    try {
      const blockNumber = await this.#client.getBlockNumber({cacheTime: 0});
      return {
        chainId: this.config.chainId,
        healthy: true,
        blockNumber,
        latencyMs: performance.now() - started,
        error: undefined,
      };
    } catch (error) {
      return {
        chainId: this.config.chainId,
        healthy: false,
        blockNumber: undefined,
        latencyMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Escape hatch for reads this adapter does not model. Prefer adding a method over using this. */
  get client(): PublicClient {
    return this.#client;
  }
}
