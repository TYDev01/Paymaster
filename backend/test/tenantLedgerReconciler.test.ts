import {describe, expect, it} from "vitest";
import type {Hex} from "viem";

import type {TenantLedgerEvent} from "../src/chain/chainAdapter.js";
import type {Alert, Alerter} from "../src/monitoring/alerting.js";
import {
  TenantLedgerReconciler,
  type TenantLedgerSource,
  type TenantLedgerStore,
} from "../src/reconciliation/tenantLedgerReconciler.js";

const CHAIN = 11155111;
const A = `0x${"aa".repeat(32)}` as Hex;
const B = `0x${"bb".repeat(32)}` as Hex;

function event(
  tenant: Hex,
  kind: TenantLedgerEvent["kind"],
  deltaWei: bigint,
  balanceAfterWei: bigint,
  blockNumber: bigint,
  logIndex = 0,
): TenantLedgerEvent {
  return {kind, tenant, deltaWei, balanceAfterWei, blockNumber, logIndex, transactionHash: `0x${"01".repeat(32)}`};
}

class RecordingAlerter implements Alerter {
  readonly fired: Alert[] = [];
  readonly resolved: string[] = [];
  fire(alert: Alert): void {
    this.fired.push(alert);
  }
  resolve(key: string): void {
    this.resolved.push(key);
  }
}

class MemoryStore implements TenantLedgerStore {
  checkpoint: bigint | undefined;
  readonly stored = new Map<Hex, bigint>();
  readonly entries: TenantLedgerEvent[] = [];

  async getCheckpoint(): Promise<bigint | undefined> {
    return this.checkpoint;
  }
  async balances(): Promise<ReadonlyMap<Hex, bigint>> {
    return new Map(this.stored);
  }
  async commitWindow(
    _chainId: number,
    toBlock: bigint,
    entries: readonly TenantLedgerEvent[],
    balances: ReadonlyMap<Hex, bigint>,
  ) {
    this.entries.push(...entries);
    for (const [key, value] of balances) this.stored.set(key, value);
    this.checkpoint = toBlock;
  }
}

/** A chain whose head, events, balances and solvency the test sets directly. */
class FakeChain implements TenantLedgerSource {
  head = 100n;
  /** The chain's whole event log; `events()` serves the window out of it. */
  log: TenantLedgerEvent[] = [];
  balances = new Map<Hex, bigint>();
  solvency = {totalTenantBalance: 0n, deposit: 0n};
  failHistoricalReads = false;

  async latestBlock(): Promise<bigint> {
    return this.head;
  }
  async events(_chainId: number, from: bigint, to: bigint): Promise<readonly TenantLedgerEvent[]> {
    return this.log.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
  }
  async balanceAt(_chainId: number, key: Hex): Promise<bigint> {
    if (this.failHistoricalReads) throw new Error("missing trie node");
    return this.balances.get(key) ?? 0n;
  }
  async solvencyAt(): Promise<{totalTenantBalance: bigint; deposit: bigint}> {
    return this.solvency;
  }
}

function reconciler(chain: FakeChain, store: MemoryStore, alerter: RecordingAlerter) {
  return new TenantLedgerReconciler(chain, store, alerter, {
    intervalMs: 60_000,
    confirmations: 0,
    maxBlockRange: 1_000,
    initialLookbackBlocks: 1_000,
    chainIds: [CHAIN],
  });
}

describe("tenant ledger reconciliation", () => {
  it("takes a baseline for a tenant it has never seen, and checks it from then on", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    const alerter = new RecordingAlerter();
    chain.log = [event(A, "deposit", 5n, 5n, 10n)];
    chain.balances.set(A, 5n);
    chain.solvency = {totalTenantBalance: 5n, deposit: 5n};

    const first = await reconciler(chain, store, alerter).reconcileChain(CHAIN);
    expect(first).toMatchObject({seeded: 1, drifted: []});
    expect(store.stored.get(A)).toBe(5n);

    chain.head = 200n;
    chain.log.push(event(A, "charge", -2n, 3n, 150n));
    chain.balances.set(A, 3n);
    const second = await reconciler(chain, store, alerter).reconcileChain(CHAIN);
    expect(second).toMatchObject({seeded: 0, drifted: [], solvent: true});
    expect(alerter.fired).toEqual([]);
  });

  it("alerts when a balance moved without an event — a reservation that was never settled", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    const alerter = new RecordingAlerter();
    store.checkpoint = 50n;
    store.stored.set(A, 10n);
    chain.solvency = {totalTenantBalance: 7n, deposit: 10n};
    // No events at all, and the contract now holds 7: 3 wei left with nothing to show for it.
    chain.balances.set(A, 7n);

    const stats = await reconciler(chain, store, alerter).reconcileChain(CHAIN);
    expect(stats!.drifted).toEqual([{tenantKey: A, expectedWei: 10n, actualWei: 7n}]);
    expect(alerter.fired.map((a) => a.key)).toEqual([`tenant-ledger-drift:${CHAIN}:${A}`]);
    expect(alerter.fired[0]!.severity).toBe("critical");

    // Re-based on the chain after reporting, so the same incident does not page every tick.
    expect(store.stored.get(A)).toBe(7n);
    chain.head = 150n;
    await reconciler(chain, store, alerter).reconcileChain(CHAIN);
    expect(alerter.fired).toHaveLength(1);
    expect(alerter.resolved).toContain(`tenant-ledger-drift:${CHAIN}:${A}`);
  });

  it("alerts when the contract owes tenants more than its deposit holds", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    const alerter = new RecordingAlerter();
    chain.solvency = {totalTenantBalance: 11n, deposit: 10n};

    const stats = await reconciler(chain, store, alerter).reconcileChain(CHAIN);
    expect(stats!.solvent).toBe(false);
    expect(alerter.fired.map((a) => a.key)).toEqual([`tenant-solvency:${CHAIN}`]);
  });

  it("falls back to the contract's reported balance when the node cannot serve historical state", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    const alerter = new RecordingAlerter();
    store.checkpoint = 0n;
    store.stored.set(B, 4n);
    chain.failHistoricalReads = true;
    chain.log = [event(B, "deposit", 6n, 10n, 20n), event(B, "withdrawal", -1n, 9n, 30n)];
    chain.solvency = {totalTenantBalance: 9n, deposit: 9n};

    const stats = await reconciler(chain, store, alerter).reconcileChain(CHAIN);
    expect(stats!.drifted).toEqual([]);
    expect(store.stored.get(B)).toBe(9n);
  });

  it("records every movement and advances the checkpoint in the same commit", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    chain.log = [event(A, "deposit", 5n, 5n, 10n), event(B, "deposit", 1n, 1n, 11n)];
    chain.balances.set(A, 5n).set(B, 1n);
    chain.solvency = {totalTenantBalance: 6n, deposit: 6n};

    await reconciler(chain, store, new RecordingAlerter()).reconcileChain(CHAIN);
    expect(store.entries).toHaveLength(2);
    expect(store.checkpoint).toBe(100n);
  });
});
