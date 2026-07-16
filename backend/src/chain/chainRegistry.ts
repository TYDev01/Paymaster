import {ChainAdapter} from "./chainAdapter.js";
import {validateChainConfigs, type ChainConfig, type ChainConfigWarning} from "./chainConfig.js";

export class UnknownChainError extends Error {
  constructor(chainId: number) {
    super(`chain ${chainId} is not configured`);
    this.name = "UnknownChainError";
  }
}

export class ChainDisabledError extends Error {
  constructor(chainId: number) {
    super(`chain ${chainId} is configured but disabled`);
    this.name = "ChainDisabledError";
  }
}

/**
 * The set of chains this instance serves, built from configuration alone.
 *
 * This is what td.md's "adding a chain requires no code changes" resolves to: the registry takes
 * `ChainConfig[]`, and nothing downstream knows which chains exist.
 */
export class ChainRegistry {
  readonly #adapters: ReadonlyMap<number, ChainAdapter>;
  readonly warnings: readonly ChainConfigWarning[];

  private constructor(adapters: ReadonlyMap<number, ChainAdapter>, warnings: readonly ChainConfigWarning[]) {
    this.#adapters = adapters;
    this.warnings = warnings;
  }

  /** Validates configs and builds adapters. Throws on the first invalid config. */
  static fromConfigs(configs: readonly ChainConfig[]): ChainRegistry {
    const {configs: validated, warnings} = validateChainConfigs(configs);
    const adapters = new Map<number, ChainAdapter>();
    for (const config of validated) {
      adapters.set(config.chainId, ChainAdapter.create(config));
    }
    return new ChainRegistry(adapters, warnings);
  }

  /**
   * Asserts every configured RPC serves the chain it claims.
   *
   * Separate from construction because it does network I/O: construction stays synchronous and
   * total, and the operator chooses when to pay for verification (startup, not first request).
   * Checks all chains before throwing so one bad config does not hide the others.
   */
  async verifyAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#adapters.values()].map((a) => a.verifyChainId()));
    const failures = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));
    if (failures.length > 0) {
      throw new Error(`chain verification failed:\n${failures.join("\n")}`);
    }
  }

  /**
   * The adapter for a chain we will actually serve.
   *
   * Distinguishes "not configured" from "disabled" because they mean different things to a caller:
   * one is a client error that will never succeed, the other is a temporary operational state.
   */
  get(chainId: number): ChainAdapter {
    const adapter = this.#adapters.get(chainId);
    if (adapter === undefined) throw new UnknownChainError(chainId);
    if (!adapter.config.enabled) throw new ChainDisabledError(chainId);
    return adapter;
  }

  /** Includes disabled chains. For the admin API and the deposit monitor, which must still see them. */
  getEvenIfDisabled(chainId: number): ChainAdapter {
    const adapter = this.#adapters.get(chainId);
    if (adapter === undefined) throw new UnknownChainError(chainId);
    return adapter;
  }

  has(chainId: number): boolean {
    return this.#adapters.has(chainId);
  }

  get enabledChainIds(): readonly number[] {
    return [...this.#adapters.values()].filter((a) => a.config.enabled).map((a) => a.chainId);
  }

  get allChainIds(): readonly number[] {
    return [...this.#adapters.keys()];
  }

  get adapters(): readonly ChainAdapter[] {
    return [...this.#adapters.values()];
  }
}
