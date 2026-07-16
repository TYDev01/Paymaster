import {getAddress, isAddress, type Address} from "viem";

/**
 * Everything needed to serve a chain. td.md requires that adding a chain be configuration only —
 * no code changes — so this is the complete set of per-chain knowledge in the system. Anything a
 * chain needs that is not expressible here is a design bug.
 */
export interface ChainConfig {
  readonly chainId: number;
  readonly name: string;
  /**
   * RPC endpoints in preference order. More than one enables failover; a single-element list is
   * accepted but means an RPC outage is a chain outage.
   */
  readonly rpcUrls: readonly string[];
  readonly entryPoint: Address;
  readonly paymaster: Address;
  readonly explorerUrl: string;
  readonly nativeCurrency: NativeCurrency;

  /** Operational thresholds for the deposit monitor, in wei. */
  readonly minDepositWei: bigint;
  readonly minStakeWei: bigint;

  /** Whether this chain currently serves sponsorships. Distinct from the on-chain pause. */
  readonly enabled: boolean;
}

export interface NativeCurrency {
  readonly symbol: string;
  readonly decimals: number;
}

export class InvalidChainConfigError extends Error {
  constructor(chainId: number | string, message: string) {
    super(`invalid config for chain ${chainId}: ${message}`);
    this.name = "InvalidChainConfigError";
  }
}

/**
 * The canonical EntryPoint v0.7 address, identical on every chain that has one.
 *
 * Deployed via a deterministic deployer, which is what makes config-only onboarding realistic: a
 * new EVM chain almost always has the EntryPoint at this address. It is not hardcoded as a
 * default — configs must state their EntryPoint explicitly — but a config that disagrees with it
 * is worth an operator's attention, so `validateChainConfig` warns.
 */
export const CANONICAL_ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

export interface ChainConfigWarning {
  readonly chainId: number;
  readonly message: string;
}

/**
 * Validates a config and normalises its addresses.
 *
 * Fails loudly at startup rather than at the first request. A chain misconfigured with the wrong
 * paymaster address would otherwise produce signatures bound to a contract that does not exist,
 * and every sponsorship on that chain would fail with an opaque AA34 at runtime.
 */
export function validateChainConfig(config: ChainConfig): {config: ChainConfig; warnings: readonly ChainConfigWarning[]} {
  const {chainId} = config;
  const warnings: ChainConfigWarning[] = [];

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new InvalidChainConfigError(chainId, "chainId must be a positive integer");
  }
  if (config.name.trim() === "") {
    throw new InvalidChainConfigError(chainId, "name must not be empty");
  }
  if (config.rpcUrls.length === 0) {
    throw new InvalidChainConfigError(chainId, "at least one RPC URL is required");
  }
  for (const url of config.rpcUrls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new InvalidChainConfigError(chainId, `RPC URL is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new InvalidChainConfigError(chainId, `RPC URL must be http(s): ${url}`);
    }
    // An RPC URL commonly carries an API key in its path. Warn rather than reject: some providers
    // legitimately use path-based keys, but the operator should know it will appear in config.
    if (parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      warnings.push({chainId, message: `RPC URL ${parsed.host} uses plaintext http`});
    }
  }

  for (const [field, value] of [
    ["entryPoint", config.entryPoint],
    ["paymaster", config.paymaster],
  ] as const) {
    if (!isAddress(value)) {
      throw new InvalidChainConfigError(chainId, `${field} is not a valid address: ${value}`);
    }
  }
  if (getAddress(config.entryPoint) !== CANONICAL_ENTRYPOINT_V07) {
    warnings.push({
      chainId,
      message:
        `entryPoint ${config.entryPoint} is not the canonical v0.7 address ` +
        `(${CANONICAL_ENTRYPOINT_V07}); verify this is intentional`,
    });
  }
  if (getAddress(config.entryPoint) === getAddress(config.paymaster)) {
    throw new InvalidChainConfigError(chainId, "entryPoint and paymaster must not be the same address");
  }

  if (config.minDepositWei < 0n || config.minStakeWei < 0n) {
    throw new InvalidChainConfigError(chainId, "deposit and stake thresholds must not be negative");
  }
  if (config.nativeCurrency.decimals < 0 || config.nativeCurrency.decimals > 36) {
    throw new InvalidChainConfigError(chainId, `implausible native currency decimals: ${config.nativeCurrency.decimals}`);
  }

  return {
    config: {
      ...config,
      entryPoint: getAddress(config.entryPoint),
      paymaster: getAddress(config.paymaster),
    },
    warnings,
  };
}

/** Validates a whole set, rejecting duplicate chain IDs. */
export function validateChainConfigs(configs: readonly ChainConfig[]): {
  configs: readonly ChainConfig[];
  warnings: readonly ChainConfigWarning[];
} {
  const seen = new Set<number>();
  const validated: ChainConfig[] = [];
  const warnings: ChainConfigWarning[] = [];

  for (const raw of configs) {
    if (seen.has(raw.chainId)) {
      throw new InvalidChainConfigError(raw.chainId, "duplicate chain id in configuration");
    }
    seen.add(raw.chainId);
    const result = validateChainConfig(raw);
    validated.push(result.config);
    warnings.push(...result.warnings);
  }

  return {configs: validated, warnings};
}
