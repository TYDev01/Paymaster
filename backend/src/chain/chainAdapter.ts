import {createPublicClient, fallback, http, parseAbi, type Address, type Hex, type PublicClient} from "viem";

import type {ChainConfig} from "./chainConfig.js";
import {CircuitBreaker, type CircuitBreakerOptions, type CircuitStateChange} from "../security/circuitBreaker.js";

/** Defaults for the per-chain RPC circuit breaker; overridable via `ChainAdapter.create`. */
const DEFAULT_BREAKER: CircuitBreakerOptions = {failureThreshold: 5, openMs: 30_000, halfOpenMaxCalls: 1};

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

/**
 * `balanceOf(address)` is identical across ERC-20 and ERC-721 — both return a `uint256` (a token
 * amount for ERC-20, a holding count for ERC-721). One ABI entry therefore serves the
 * token-ownership policy rule for either standard, and the rule decides how to interpret the number.
 */
const TOKEN_BALANCE_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

/** `TenantPaymaster.balanceOf`. Same name as the ERC-20 one above, but keyed by tenant, not holder. */
const TENANT_BALANCE_ABI = parseAbi(["function balanceOf(bytes32 tenant) view returns (uint256)"]);

/**
 * The EntryPoint event the reconciler reads. `sender` and `paymaster` are indexed, so a log filter
 * on our paymaster address is served from the node's index rather than by scanning every op.
 * `actualGasCost` is what the paymaster actually paid — the number spend caps are trued up against.
 */
const USER_OPERATION_EVENT = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
])[0];

/** One settled UserOperationEvent for our paymaster. */
export interface UserOperationEventLog {
  readonly sender: Address;
  readonly nonce: bigint;
  readonly actualGasCostWei: bigint;
  readonly success: boolean;
  readonly blockNumber: bigint;
}

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
export interface ChainAdapterOptions {
  /** Overrides the default RPC circuit-breaker thresholds. */
  readonly breaker?: CircuitBreakerOptions;
  /** Notified when this chain's breaker opens/closes, for alerting and metrics. */
  readonly onCircuitChange?: (change: CircuitStateChange) => void;
}

export class ChainAdapter {
  readonly config: ChainConfig;
  readonly #client: PublicClient;
  /**
   * Per-chain circuit breaker over RPC reads. When an endpoint fails repeatedly it trips and every
   * read fails fast with `CircuitOpenError` until a cooldown lets a trial through — so a dead chain
   * costs a rejected call instead of a timeout, and a struggling endpoint is not hammered. `health`
   * surfaces the open breaker as unhealthy without making a call, which is what feeds readiness.
   */
  readonly #breaker: CircuitBreaker;

  private constructor(config: ChainConfig, client: PublicClient, breaker: CircuitBreaker) {
    this.config = config;
    this.#client = client;
    this.#breaker = breaker;
  }

  static create(config: ChainConfig, options: ChainAdapterOptions = {}): ChainAdapter {
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

    const breaker = new CircuitBreaker(`rpc:${config.chainId}`, options.breaker ?? DEFAULT_BREAKER, {
      ...(options.onCircuitChange === undefined ? {} : {onStateChange: options.onCircuitChange}),
    });

    return new ChainAdapter(config, client, breaker);
  }

  get chainId(): number {
    return this.config.chainId;
  }

  /** Current breaker state, for health/metrics without probing the RPC. */
  get circuitState(): "closed" | "open" | "half-open" {
    return this.#breaker.state;
  }

  /** Routes an RPC read through the breaker so repeated failures trip fast-fail. */
  #call<T>(fn: () => Promise<T>): Promise<T> {
    return this.#breaker.execute(fn);
  }

  /**
   * Asserts the RPC actually serves the chain the config claims.
   *
   * A copy-pasted config pointing Base's entry at an Arbitrum RPC is an easy mistake and a
   * catastrophic one: signatures are bound to chainId, so every sponsorship would fail, and the
   * deposit monitor would report the wrong chain's balance. Checked once at startup.
   */
  async verifyChainId(): Promise<void> {
    const actual = await this.#call(() => this.#client.getChainId());
    if (actual !== this.config.chainId) {
      throw new Error(
        `RPC for chain ${this.config.chainId} (${this.config.name}) reports chainId ${actual}; ` +
          `the configured RPC serves a different chain`,
      );
    }
  }

  /** Deposit and stake for our paymaster, read from the EntryPoint in one call. */
  async getDepositInfo(): Promise<DepositInfo> {
    const info = await this.#call(() =>
      this.#client.readContract({
        address: this.config.entryPoint,
        abi: ENTRYPOINT_ABI,
        functionName: "getDepositInfo",
        args: [this.config.paymaster],
      }),
    );

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
    return this.#call(() => this.#client.getBalance({address}));
  }

  /** Current head block. Used by the reconciler to bound its scan behind the confirmation depth. */
  async blockNumber(): Promise<bigint> {
    return this.#call(() => this.#client.getBlockNumber({cacheTime: 0}));
  }

  /**
   * Settled UserOperationEvents for OUR paymaster in `[fromBlock, toBlock]`.
   *
   * Filtered on the indexed `paymaster` topic at the EntryPoint address, so a busy chain does not
   * return every op — only the ones we paid for. The block range is the caller's to bound; some RPCs
   * cap `eth_getLogs` spans, so the reconciler scans in windows rather than from genesis.
   */
  async getUserOperationEvents(fromBlock: bigint, toBlock: bigint): Promise<readonly UserOperationEventLog[]> {
    const logs = await this.#call(() =>
      this.#client.getLogs({
        address: this.config.entryPoint,
        event: USER_OPERATION_EVENT,
        args: {paymaster: this.config.paymaster},
        fromBlock,
        toBlock,
      }),
    );

    return logs.map((log) => ({
      sender: log.args.sender!,
      nonce: log.args.nonce!,
      actualGasCostWei: log.args.actualGasCost!,
      success: log.args.success!,
      blockNumber: log.blockNumber ?? 0n,
    }));
  }

  /**
   * `balanceOf` for an ERC-20 or ERC-721 at `token`, held by `account`.
   *
   * Used by the token-ownership policy rule to gate sponsorship on a holding. The call is `view`,
   * so it costs nothing and cannot mutate state; a revert (e.g. `token` is not a token contract)
   * propagates so the rule can fail closed rather than treat an unreadable balance as zero or full.
   */
  async getTokenBalance(token: Address, account: Address): Promise<bigint> {
    return this.#call(() =>
      this.#client.readContract({
        address: token,
        abi: TOKEN_BALANCE_ABI,
        functionName: "balanceOf",
        args: [account],
      }),
    );
  }

  /**
   * What a tenant has left to spend on this chain, in wei.
   *
   * Only meaningful where `paymasterKind` is `tenant` — the single-tenant contract has one shared
   * deposit and no such mapping — so calling it elsewhere is a programming error rather than a
   * condition to handle at runtime.
   */
  async getTenantBalance(tenant: Hex): Promise<bigint> {
    if (this.config.paymasterKind !== "tenant") {
      throw new Error(
        `chain ${this.config.chainId} (${this.config.name}) runs a ${this.config.paymasterKind} ` +
          "paymaster, which has no per-tenant balances",
      );
    }
    return this.#call(() =>
      this.#client.readContract({
        address: this.config.paymaster,
        abi: TENANT_BALANCE_ABI,
        functionName: "balanceOf",
        args: [tenant],
      }),
    );
  }

  /**
   * Liveness probe. Never throws: a health check that throws cannot report unhealthy, and this
   * feeds both the readiness endpoint and the RPC-failure alert.
   */
  async health(): Promise<ChainHealth> {
    const started = performance.now();
    try {
      // Through the breaker: when it is open this returns CircuitOpenError immediately, so a dead
      // chain reports unhealthy for readiness without waiting on another doomed RPC round-trip.
      const blockNumber = await this.#call(() => this.#client.getBlockNumber({cacheTime: 0}));
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
