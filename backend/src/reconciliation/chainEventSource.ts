import type {ChainRegistry} from "../chain/chainRegistry.js";
import type {UserOpEventSource, UserOperationEventRecord} from "./spendReconciler.js";

/**
 * Backs the reconciler's `UserOpEventSource` with the chain registry.
 *
 * Reads even from disabled chains (`getEvenIfDisabled`): an in-flight op sponsored just before a
 * chain was disabled still settles on-chain and still over-reserved budget, so its spend must be
 * reconciled regardless of whether the chain currently serves new sponsorships.
 */
export class ChainRegistryEventSource implements UserOpEventSource {
  constructor(private readonly chains: ChainRegistry) {}

  latestBlock(chainId: number): Promise<bigint> {
    return this.chains.getEvenIfDisabled(chainId).blockNumber();
  }

  async getUserOperationEvents(
    chainId: number,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly UserOperationEventRecord[]> {
    const logs = await this.chains.getEvenIfDisabled(chainId).getUserOperationEvents(fromBlock, toBlock);
    // The adapter's log shape already matches the reconciler's record shape.
    return logs;
  }
}
