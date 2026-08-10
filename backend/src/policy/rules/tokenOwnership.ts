import {getAddress, type Address} from "viem";

import {ALLOW, deny, type PolicyContext, type PolicyDecision} from "../context.js";
import type {PolicyRule} from "../rule.js";

/**
 * Reads an on-chain token balance for the token-ownership rule.
 *
 * A port, so the rule depends on "give me `balanceOf(token, account)` on chain N" and nothing about
 * how chains are configured or how RPC failover works. `ChainRegistryTokenBalanceReader` satisfies
 * it over the real registry; a test satisfies it with a map.
 */
export interface TokenBalanceReader {
  balanceOf(chainId: number, token: Address, account: Address): Promise<bigint>;
}

export type TokenStandard = "erc20" | "erc721";

export interface TokenOwnershipConfig {
  /**
   * Fallback token contract, applied on any chain without a `tokenByChain` entry. Optional: a
   * policy may instead enumerate `tokenByChain` and fail closed on chains it does not list.
   */
  readonly token?: Address | undefined;
  /**
   * Per-chain token address overrides. A token rarely shares an address across chains, so a policy
   * that spans chains gives the address on each; a single-chain policy just uses `token`.
   */
  readonly tokenByChain?: Readonly<Record<number, Address>> | undefined;
  /** Minimum raw balance (token base units for ERC-20, holding count for ERC-721). Defaults to 1. */
  readonly minBalance?: bigint | undefined;
  /** Interpretation only; `balanceOf` is identical for both. Defaults to erc20. */
  readonly standard?: TokenStandard | undefined;
}

/**
 * Sponsors only senders that hold at least `minBalance` of a configured token — td.md's "token
 * ownership requirements".
 *
 * `network` cost: it makes a chain read, so the engine runs it after every pure and store rule, and
 * a free denial (wrong chain, blocked sender) skips the RPC call entirely.
 *
 * Fails closed. If the balance cannot be read — the token address is wrong, the RPC is down, the
 * contract reverts — the rule DENIES rather than assuming the holding is present. An unreadable
 * balance must never become a way to be sponsored without holding the token. It equally denies when
 * no token address is configured for the operation's chain, for the same reason: a rule that cannot
 * check its condition must not pass.
 */
export class TokenOwnershipRule implements PolicyRule {
  readonly name = "token-ownership";
  readonly cost = "network" as const;

  readonly #reader: TokenBalanceReader;
  readonly #default: Address | undefined;
  readonly #byChain: ReadonlyMap<number, Address>;
  readonly #minBalance: bigint;
  readonly #standard: TokenStandard;

  constructor(reader: TokenBalanceReader, config: TokenOwnershipConfig) {
    this.#reader = reader;
    this.#default = config.token === undefined ? undefined : getAddress(config.token);
    const byChain = new Map<number, Address>();
    for (const [chainId, token] of Object.entries(config.tokenByChain ?? {})) {
      byChain.set(Number(chainId), getAddress(token));
    }
    this.#byChain = byChain;
    // A minimum of 0 would sponsor everyone and is almost certainly a config mistake, but it is not
    // this rule's job to reject it — the factory's schema does, requiring a positive minimum.
    this.#minBalance = config.minBalance ?? 1n;
    this.#standard = config.standard ?? "erc20";
  }

  async evaluate(context: PolicyContext): Promise<PolicyDecision> {
    const token = this.#byChain.get(context.chainId) ?? this.#default;
    if (token === undefined) {
      return deny(
        this.name,
        "TOKEN_BALANCE_INSUFFICIENT",
        `no ${this.#standard} token address is configured for chain ${context.chainId}`,
      );
    }

    let balance: bigint;
    try {
      balance = await this.#reader.balanceOf(context.chainId, token, context.sender);
    } catch (cause) {
      return deny(
        this.name,
        "RULE_ERROR",
        `could not read ${this.#standard} balance of ${token} for ${context.sender}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    if (balance >= this.#minBalance) return ALLOW;
    return deny(
      this.name,
      "TOKEN_BALANCE_INSUFFICIENT",
      `sender ${context.sender} holds ${balance} of ${token}, below the required ${this.#minBalance}`,
    );
  }
}
