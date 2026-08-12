import {Logger} from "@nestjs/common";
import type {Address} from "viem";

import type {Policy} from "../policy/engine.js";
import {QuotaRule, type SpendTrueUp} from "../policy/rules/quotaRules.js";
import {IntervalLoop} from "../monitoring/intervalLoop.js";
import type {BackgroundService} from "../monitoring/backgroundService.js";
import type {TenantId} from "../db/scope.js";

/** A settled UserOperationEvent, as the reconciler needs it. */
export interface UserOperationEventRecord {
  readonly sender: Address;
  readonly nonce: bigint;
  /** `actualGasCost` from the event — what the paymaster actually paid, in wei. */
  readonly actualGasCostWei: bigint;
  readonly success: boolean;
  readonly blockNumber: bigint;
}

/**
 * Reads settled UserOperationEvents for our paymaster. A port over `ChainAdapter`, so the reconciler
 * does not depend on viem or on how the paymaster address is configured.
 */
export interface UserOpEventSource {
  latestBlock(chainId: number): Promise<bigint>;
  getUserOperationEvents(
    chainId: number,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly UserOperationEventRecord[]>;
}

/** A sponsorship claimed for reconciliation — enough to refund its over-reservation. */
export interface ClaimedReservation {
  readonly sponsorshipId: bigint;
  /** Recorded on the sponsorship at signing time, so the refund is applied to the right tenant. */
  readonly tenantId: TenantId;
  readonly policyId: string;
  readonly apiKeyId: string;
  readonly reservedMaxCostWei: bigint;
  /** Unix seconds of the reservation, so the refund lands in the window it charged. */
  readonly reservedAt: number;
}

/**
 * The reconciler's persistence: a per-chain block checkpoint, and the atomic claim of an
 * unreconciled sponsorship.
 *
 * `claim` MUST be atomic and mark the row reconciled as it returns it, so two replicas cannot both
 * refund the same reservation. It returns undefined when no unreconciled sponsorship matches — the
 * op was not sponsored by us, or every attestation for it was already reconciled.
 */
export interface SpendReconciliationStore {
  getCheckpoint(chainId: number): Promise<bigint | undefined>;
  saveCheckpoint(chainId: number, block: bigint): Promise<void>;
  claim(params: {
    chainId: number;
    sender: Address;
    nonce: bigint;
    actualGasCostWei: bigint;
    success: boolean;
  }): Promise<ClaimedReservation | undefined>;
}

/** Resolves a policy id to its loaded rules. `PolicySource.get` satisfies this. */
export interface PolicyLookup {
  /**
   * Policy ids are unique per tenant, so a refund has to name both — the sponsorship row records
   * which tenant it belonged to precisely so this lookup can be exact rather than a guess across
   * tenants that happen to share a policy name.
   */
  get(tenantId: TenantId, policyId: string): Policy;
}

export interface SpendReconcilerOptions {
  readonly intervalMs: number;
  /** Blocks to stay behind the head, so a reorg does not reconcile against an orphaned event. */
  readonly confirmations: number;
  /** Cap on blocks scanned per chain per tick, to bound a single `getLogs`. */
  readonly maxBlockRange: number;
  /** From how far back to start when a chain has no checkpoint yet. */
  readonly initialLookbackBlocks: number;
  readonly chainIds: readonly number[];
}

export interface ReconcileStats {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly eventsScanned: number;
  readonly reservationsReconciled: number;
  readonly weiRefunded: bigint;
}

/**
 * Trues up spend-cap counters from actual on-chain cost.
 *
 * Spend caps reserve worst-case `maxCost` at sponsorship time — actual gas cost is always lower, so
 * a cap runs conservative and its drift grows the longer it runs. This loop reads each chain's
 * settled `UserOperationEvent`s, correlates them to the sponsorships that paid for them by
 * `(chainId, sender, nonce)`, and refunds the difference to the exact quota counters that reserved
 * it, so counters reflect what was actually spent.
 *
 * Safety bias, throughout: every ambiguity resolves toward reserving MORE, never less. A refund that
 * fails to apply is dropped rather than retried into a possible double-refund; a policy that has
 * since been deleted skips the refund; a reprocessed event claims a different attestation rather
 * than re-crediting one. All of these leave a cap slightly conservative, which is the same, safe
 * direction the un-reconciled system already errs in.
 */
export class SpendReconciler implements BackgroundService {
  readonly name = "spend-reconciler";
  readonly #source: UserOpEventSource;
  readonly #store: SpendReconciliationStore;
  readonly #policies: PolicyLookup;
  readonly #options: SpendReconcilerOptions;
  readonly #loop: IntervalLoop;
  readonly #logger = new Logger(this.name);

  constructor(
    source: UserOpEventSource,
    store: SpendReconciliationStore,
    policies: PolicyLookup,
    options: SpendReconcilerOptions,
  ) {
    this.#source = source;
    this.#store = store;
    this.#policies = policies;
    this.#options = options;
    this.#loop = new IntervalLoop(this.name, options.intervalMs, () => this.reconcileAll().then(() => undefined));
  }

  start(): Promise<void> {
    return this.#loop.start();
  }

  stop(): void {
    this.#loop.stop();
  }

  /** Reconciles every configured chain once. Chains are independent; one failing does not stop the rest. */
  async reconcileAll(): Promise<readonly ReconcileStats[]> {
    const stats: ReconcileStats[] = [];
    for (const chainId of this.#options.chainIds) {
      try {
        const result = await this.reconcileChain(chainId);
        if (result !== undefined) stats.push(result);
      } catch (error) {
        this.#logger.error(`chain ${chainId} reconciliation failed: ${message(error)}`);
      }
    }
    return stats;
  }

  /** Scans one chain's next block window and reconciles the events in it. Undefined when nothing to scan. */
  async reconcileChain(chainId: number): Promise<ReconcileStats | undefined> {
    const latest = await this.#source.latestBlock(chainId);
    const safeHead = latest - BigInt(this.#options.confirmations);
    if (safeHead < 0n) return undefined;

    const checkpoint = await this.#store.getCheckpoint(chainId);
    const from =
      checkpoint !== undefined ? checkpoint + 1n : bigMax(0n, safeHead - BigInt(this.#options.initialLookbackBlocks));
    if (from > safeHead) return undefined;

    const to = bigMin(safeHead, from + BigInt(this.#options.maxBlockRange) - 1n);

    const events = await this.#source.getUserOperationEvents(chainId, from, to);
    let reconciled = 0;
    let refunded = 0n;

    for (const event of events) {
      const claim = await this.#store.claim({
        chainId,
        sender: event.sender,
        nonce: event.nonce,
        actualGasCostWei: event.actualGasCostWei,
        success: event.success,
      });
      if (claim === undefined) continue; // Not ours, or already reconciled.

      refunded += await this.#refund(chainId, claim, event);
      reconciled += 1;
    }

    // Checkpoint AFTER processing the window. A crash mid-window reprocesses it; claims are marked
    // reconciled as they are taken, so reprocessing does not re-refund a reservation already trued up.
    await this.#store.saveCheckpoint(chainId, to);

    return {
      chainId,
      fromBlock: from,
      toBlock: to,
      eventsScanned: events.length,
      reservationsReconciled: reconciled,
      weiRefunded: refunded,
    };
  }

  async #refund(chainId: number, claim: ClaimedReservation, event: UserOperationEventRecord): Promise<bigint> {
    let policy: Policy;
    try {
      policy = this.#policies.get(claim.tenantId, claim.policyId);
    } catch {
      // Policy deleted or disabled since sponsorship. The row is already marked reconciled; leaving
      // its reservation in place keeps the cap conservative, which is the safe direction.
      this.#logger.warn(
        `policy ${claim.policyId} for sponsorship ${claim.sponsorshipId} is no longer loaded; skipping refund`,
      );
      return 0n;
    }

    const reservation: SpendTrueUp = {
      chainId,
      sender: event.sender,
      apiKeyId: claim.apiKeyId,
      reservedMaxCostWei: claim.reservedMaxCostWei,
      actualCostWei: event.actualGasCostWei,
      reservedAt: claim.reservedAt,
    };

    let refunded = 0n;
    for (const rule of policy.rules) {
      if (!(rule instanceof QuotaRule)) continue;
      try {
        refunded += await rule.trueUp(reservation);
      } catch (error) {
        // A failed release drops this refund rather than risk a double-refund on retry. The
        // reservation simply stands until its window rolls — the cap stays conservative.
        this.#logger.warn(
          `refund on rule ${rule.name} for sponsorship ${claim.sponsorshipId} failed: ${message(error)}`,
        );
      }
    }
    return refunded;
  }
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
