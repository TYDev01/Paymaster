import {Logger} from "@nestjs/common";
import type {Hex} from "viem";

import type {TenantLedgerEvent} from "../chain/chainAdapter.js";
import type {ChainRegistry} from "../chain/chainRegistry.js";
import type {Alerter} from "../monitoring/alerting.js";
import type {BackgroundService} from "../monitoring/backgroundService.js";
import {IntervalLoop} from "../monitoring/intervalLoop.js";

/** Reads TenantPaymaster state. A port over the chain adapters, so the reconciler is testable. */
export interface TenantLedgerSource {
  latestBlock(chainId: number): Promise<bigint>;
  events(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<readonly TenantLedgerEvent[]>;
  balanceAt(chainId: number, tenantKey: Hex, blockNumber: bigint): Promise<bigint>;
  solvencyAt(chainId: number, blockNumber: bigint): Promise<{totalTenantBalance: bigint; deposit: bigint}>;
}

/** The replayed ledger's persistence. */
export interface TenantLedgerStore {
  getCheckpoint(chainId: number): Promise<bigint | undefined>;
  /** Every tenant key this chain's ledger knows, with its last reconciled balance. */
  balances(chainId: number): Promise<ReadonlyMap<Hex, bigint>>;
  /**
   * Records a window: its entries (idempotently), the reconciled balances as of `toBlock`, and the
   * checkpoint — in ONE transaction, so a crash leaves either the whole window or none of it.
   */
  commitWindow(
    chainId: number,
    toBlock: bigint,
    entries: readonly TenantLedgerEvent[],
    balances: ReadonlyMap<Hex, bigint>,
  ): Promise<void>;
}

export interface TenantLedgerReconcilerOptions {
  readonly intervalMs: number;
  readonly confirmations: number;
  readonly maxBlockRange: number;
  readonly initialLookbackBlocks: number;
  /** Chains running `TenantPaymaster`. The single-tenant contract has no ledger to reconcile. */
  readonly chainIds: readonly number[];
}

export interface TenantLedgerStats {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly events: number;
  readonly tenantsChecked: number;
  /** Tenants whose chain balance disagreed with their replayed history. */
  readonly drifted: readonly {tenantKey: Hex; expectedWei: bigint; actualWei: bigint}[];
  /** Tenants seen for the first time, whose baseline was taken rather than checked. */
  readonly seeded: number;
  readonly solvent: boolean;
}

/**
 * Checks TenantPaymaster's books against themselves, continuously.
 *
 * Two questions, both of which the chain can answer and neither of which anything else was asking:
 *
 *   1. SOLVENCY. `totalTenantBalance() <= EntryPoint.balanceOf(paymaster)`. The Foundry invariant
 *      suite proves the contract preserves this; this watches the DEPLOYED contract, where an
 *      owner's `withdrawTo` of the shared deposit could break it without any bug at all. Broken, the
 *      last customer to spend finds the deposit empty while their balance still reads healthy.
 *
 *   2. HISTORY. For every tenant touched in a window: last reconciled balance + the deposits,
 *      withdrawals and charges the contract emitted == the balance in storage at the end of the
 *      window. A mismatch means money moved without an event — for example a reservation taken in
 *      validation and never settled because `postOp` reverted — which is exactly the kind of loss that
 *      is invisible to anyone reading only balances.
 *
 * Balances are read at the window's last block, never at `latest`, so movements the window has not
 * replayed cannot show up as drift. When a node cannot serve state that old (a non-archive node
 * catching up), the contract's own reported post-balance from the last event is used instead: it is
 * what storage held at the end of that transaction, which is the end of the window for that tenant.
 *
 * Every window also re-checks tenants with NO events once caught up to the head, so a balance that
 * moved silently is caught even if that tenant never transacts again.
 *
 * Findings are ALERTS, not corrections. The chain is the source of truth; the stored balance is
 * re-based on what the chain says after a drift is reported, so one incident pages once rather than
 * every tick forever.
 */
export class TenantLedgerReconciler implements BackgroundService {
  readonly name = "tenant-ledger-reconciler";
  readonly #source: TenantLedgerSource;
  readonly #store: TenantLedgerStore;
  readonly #alerter: Alerter;
  readonly #options: TenantLedgerReconcilerOptions;
  readonly #loop: IntervalLoop;
  readonly #logger = new Logger(this.name);

  constructor(
    source: TenantLedgerSource,
    store: TenantLedgerStore,
    alerter: Alerter,
    options: TenantLedgerReconcilerOptions,
  ) {
    this.#source = source;
    this.#store = store;
    this.#alerter = alerter;
    this.#options = options;
    this.#loop = new IntervalLoop(this.name, options.intervalMs, () => this.reconcileAll().then(() => undefined));
  }

  start(): Promise<void> {
    return this.#loop.start();
  }

  stop(): void {
    this.#loop.stop();
  }

  async reconcileAll(): Promise<readonly TenantLedgerStats[]> {
    const stats: TenantLedgerStats[] = [];
    for (const chainId of this.#options.chainIds) {
      try {
        const result = await this.reconcileChain(chainId);
        if (result !== undefined) stats.push(result);
      } catch (error) {
        this.#logger.error(`chain ${chainId} ledger reconciliation failed: ${message(error)}`);
      }
    }
    return stats;
  }

  async reconcileChain(chainId: number): Promise<TenantLedgerStats | undefined> {
    const latest = await this.#source.latestBlock(chainId);
    const safeHead = latest - BigInt(this.#options.confirmations);
    if (safeHead < 0n) return undefined;

    const checkpoint = await this.#store.getCheckpoint(chainId);
    const from =
      checkpoint !== undefined ? checkpoint + 1n : bigMax(0n, safeHead - BigInt(this.#options.initialLookbackBlocks));
    if (from > safeHead) return undefined;
    const to = bigMin(safeHead, from + BigInt(this.#options.maxBlockRange) - 1n);
    const caughtUp = to === safeHead;

    const events = await this.#source.events(chainId, from, to);
    const known = await this.#store.balances(chainId);

    // Per tenant: the net movement in this window, and the balance the contract last reported.
    const movement = new Map<Hex, {delta: bigint; lastReported: bigint}>();
    for (const event of events) {
      const key = event.tenant.toLowerCase() as Hex;
      const entry = movement.get(key) ?? {delta: 0n, lastReported: 0n};
      movement.set(key, {delta: entry.delta + event.deltaWei, lastReported: event.balanceAfterWei});
    }

    const keys = new Set<Hex>(movement.keys());
    if (caughtUp) for (const key of known.keys()) keys.add(key);

    const reconciled = new Map<Hex, bigint>();
    const drifted: {tenantKey: Hex; expectedWei: bigint; actualWei: bigint}[] = [];
    let seeded = 0;

    for (const key of keys) {
      const moved = movement.get(key);
      const actual = await this.#actualBalance(chainId, key, to, moved?.lastReported);
      if (actual === undefined) continue; // Unreadable and unreported: leave it for the next window.
      reconciled.set(key, actual);

      const prior = known.get(key);
      if (prior === undefined) {
        seeded += 1;
        continue;
      }

      const expected = prior + (moved?.delta ?? 0n);
      const alertKey = `tenant-ledger-drift:${chainId}:${key}`;
      if (expected !== actual) {
        drifted.push({tenantKey: key, expectedWei: expected, actualWei: actual});
        await this.#alerter.fire({
          key: alertKey,
          severity: "critical",
          title: "tenant balance moved without an event",
          detail:
            `tenant ${key} on chain ${chainId}: replayed history says ${expected} wei at block ${to}, ` +
            `the contract holds ${actual} wei (${actual - expected} wei unexplained)`,
          labels: {chainId: String(chainId), tenantKey: key},
        });
      } else {
        await this.#alerter.resolve(alertKey);
      }
    }

    const solvent = await this.#checkSolvency(chainId, to, latest);

    await this.#store.commitWindow(chainId, to, events, reconciled);

    return {
      chainId,
      fromBlock: from,
      toBlock: to,
      events: events.length,
      tenantsChecked: keys.size,
      drifted,
      seeded,
      solvent,
    };
  }

  async #actualBalance(
    chainId: number,
    key: Hex,
    block: bigint,
    lastReported: bigint | undefined,
  ): Promise<bigint | undefined> {
    try {
      return await this.#source.balanceAt(chainId, key, block);
    } catch (error) {
      if (lastReported !== undefined) return lastReported;
      this.#logger.warn(
        `could not read tenant ${key} balance at block ${block} on chain ${chainId}: ${message(error)}`,
      );
      return undefined;
    }
  }

  async #checkSolvency(chainId: number, block: bigint, latest: bigint): Promise<boolean> {
    let solvency: {totalTenantBalance: bigint; deposit: bigint};
    try {
      solvency = await this.#source.solvencyAt(chainId, block);
    } catch {
      // The invariant must hold at EVERY block, so the head is as good a place to check it as any.
      solvency = await this.#source.solvencyAt(chainId, latest);
    }

    const alertKey = `tenant-solvency:${chainId}`;
    if (solvency.totalTenantBalance > solvency.deposit) {
      await this.#alerter.fire({
        key: alertKey,
        severity: "critical",
        title: "tenant paymaster owes more than it holds",
        detail:
          `chain ${chainId}: tenants are owed ${solvency.totalTenantBalance} wei but the EntryPoint deposit ` +
          `is ${solvency.deposit} wei. The last tenants to spend will be refused with their balances intact.`,
        labels: {chainId: String(chainId)},
      });
      return false;
    }
    await this.#alerter.resolve(alertKey);
    return true;
  }
}

/** Backs `TenantLedgerSource` with the chain registry. Reads disabled chains too: money is still there. */
export class ChainRegistryTenantLedgerSource implements TenantLedgerSource {
  constructor(private readonly chains: ChainRegistry) {}

  latestBlock(chainId: number): Promise<bigint> {
    return this.chains.getEvenIfDisabled(chainId).blockNumber();
  }

  events(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<readonly TenantLedgerEvent[]> {
    return this.chains.getEvenIfDisabled(chainId).getTenantLedgerEvents(fromBlock, toBlock);
  }

  balanceAt(chainId: number, tenantKey: Hex, blockNumber: bigint): Promise<bigint> {
    return this.chains.getEvenIfDisabled(chainId).getTenantBalanceAt(tenantKey, blockNumber);
  }

  solvencyAt(chainId: number, blockNumber: bigint): Promise<{totalTenantBalance: bigint; deposit: bigint}> {
    return this.chains.getEvenIfDisabled(chainId).getTenantSolvencyAt(blockNumber);
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
