import type {Address} from "viem";

import type {TokenBalanceReader} from "../policy/rules/tokenOwnership.js";
import type {ChainRegistry} from "./chainRegistry.js";

/**
 * Backs the token-ownership rule's `TokenBalanceReader` port with the real chain registry.
 *
 * Uses `get` (not `getEvenIfDisabled`): a balance is only ever read while sponsoring, which already
 * resolved an enabled chain, so a read against a disabled or unknown chain is a bug and should throw
 * — the rule turns that throw into a fail-closed denial.
 */
export class ChainRegistryTokenBalanceReader implements TokenBalanceReader {
  constructor(private readonly chains: ChainRegistry) {}

  balanceOf(chainId: number, token: Address, account: Address): Promise<bigint> {
    return this.chains.get(chainId).getTokenBalance(token, account);
  }
}
