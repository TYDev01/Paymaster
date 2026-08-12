import {describe, expect, it} from "vitest";
import {toHex, type Address} from "viem";

import {packUint128Pair, type PackedUserOperation} from "../src/domain/userOperation.js";
import type {PolicyContext} from "../src/policy/context.js";
import type {Policy} from "../src/policy/engine.js";
import {InMemoryQuotaStore} from "../src/policy/quota/inMemoryQuotaStore.js";
import {QuotaRule} from "../src/policy/rules/quotaRules.js";
import {UnknownPolicyError} from "../src/policy/policySource.js";
import {
  SpendReconciler,
  type ClaimedReservation,
  type PolicyLookup,
  type SpendReconcilerOptions,
  type SpendReconciliationStore,
  type UserOpEventSource,
  type UserOperationEventRecord,
} from "../src/reconciliation/spendReconciler.js";
import {ACME} from "./support/tenants.js";

const SENDER = "0x1234567890123456789012345678901234567890" as Address;
const CHAIN = 8453;
const WINDOW = 86_400;
const RESERVED_AT = 1_700_000_000;
const GWEI = 1_000_000_000n;

function contextForReservation(maxCost: bigint): PolicyContext {
  const userOp: PackedUserOperation = {
    sender: SENDER,
    nonce: 7n,
    initCode: "0x",
    callData: "0x",
    accountGasLimits: toHex(packUint128Pair(500_000n, 200_000n), {size: 32}),
    preVerificationGas: 100_000n,
    gasFees: toHex(packUint128Pair(1_000_000_000n, 20_000_000_000n), {size: 32}),
    paymasterAndData: "0x",
    signature: "0x",
  };
  return {
    chainId: CHAIN,
    sender: SENDER,
    userOp,
    calls: undefined,
    clientIp: undefined,
    apiKeyId: "key-1",
    maxCost,
    now: RESERVED_AT,
  };
}

/** A wallet-scoped wei spend cap and the store behind it, with one reservation already made. */
async function reservedWalletCap(maxCost: bigint): Promise<{store: InMemoryQuotaStore; rule: QuotaRule; key: string}> {
  const store = new InMemoryQuotaStore();
  const rule = new QuotaRule(store, {
    name: "spend",
    subject: "wallet",
    unit: "wei",
    limit: 10n ** 20n, // 100 ETH: never the binding constraint here
    windowSeconds: WINDOW,
  });
  const outcome = await rule.evaluate(contextForReservation(maxCost));
  expect(outcome.allowed).toBe(true);
  return {store, rule, key: `quota:spend:${CHAIN}:${SENDER.toLowerCase()}`};
}

function policyLookup(policy: Policy | undefined): PolicyLookup {
  return {
    get: (_tenant: unknown, id) => {
      if (policy === undefined || id !== policy.id) throw new UnknownPolicyError(id);
      return policy;
    },
  };
}

/** A one-shot claim store: each (sender,nonce) can be claimed once, matching the atomic DB claim. */
function fakeStore(reservations: ClaimedReservation[]): SpendReconciliationStore & {checkpoint?: bigint} {
  const queue = [...reservations];
  const state: {checkpoint?: bigint} = {};
  return {
    getCheckpoint: async () => state.checkpoint,
    saveCheckpoint: async (_chainId, block) => {
      state.checkpoint = block;
    },
    claim: async () => queue.shift(),
    get checkpoint() {
      return state.checkpoint;
    },
  } as SpendReconciliationStore & {checkpoint?: bigint};
}

function source(latest: bigint, events: readonly UserOperationEventRecord[]): UserOpEventSource {
  return {
    latestBlock: async () => latest,
    getUserOperationEvents: async () => events,
  };
}

function event(over: Partial<UserOperationEventRecord> = {}): UserOperationEventRecord {
  return {sender: SENDER, nonce: 7n, actualGasCostWei: 4n * 10n ** 14n, success: true, blockNumber: 10n, ...over};
}

const OPTS: SpendReconcilerOptions = {
  intervalMs: 60_000,
  confirmations: 5,
  maxBlockRange: 1000,
  initialLookbackBlocks: 100,
  chainIds: [CHAIN],
};

function claim(reservedMaxCostWei: bigint): ClaimedReservation {
  return {
    sponsorshipId: 1n,
    tenantId: ACME,
    policyId: "p",
    apiKeyId: "key-1",
    reservedMaxCostWei,
    reservedAt: RESERVED_AT,
  };
}

describe("SpendReconciler", () => {
  it("refunds the over-reservation to the exact counter that reserved it", async () => {
    const reservedMax = 10n ** 15n; // reserved worst case
    const actual = 4n * 10n ** 14n; // realised cost, lower
    const {store, rule, key} = await reservedWalletCap(reservedMax);
    const policy: Policy = {tenantId: ACME, id: "p", rules: [rule]};

    // Before reconciliation the counter holds the full worst-case reservation, in gwei.
    expect(await store.usage(key, WINDOW, RESERVED_AT)).toBe(reservedMax / GWEI);

    const reconciler = new SpendReconciler(
      source(100n, [event({actualGasCostWei: actual})]),
      fakeStore([claim(reservedMax)]),
      policyLookup(policy),
      OPTS,
    );
    const [stats] = await reconciler.reconcileAll();

    expect(stats).toMatchObject({chainId: CHAIN, reservationsReconciled: 1});
    expect(stats!.weiRefunded).toBe((reservedMax / GWEI) * GWEI - (actual / GWEI) * GWEI);
    // Counter is now trued up to the realised cost (in gwei).
    expect(await store.usage(key, WINDOW, RESERVED_AT)).toBe(actual / GWEI);
  });

  it("does not refund below the realised cost when reprocessing finds no new reservation", async () => {
    const reservedMax = 10n ** 15n;
    const actual = 4n * 10n ** 14n;
    const {store, rule, key} = await reservedWalletCap(reservedMax);
    const policy: Policy = {tenantId: ACME, id: "p", rules: [rule]};
    const st = fakeStore([claim(reservedMax)]); // only one claim available, ever

    const reconciler = new SpendReconciler(
      source(100n, [event({actualGasCostWei: actual})]),
      st,
      policyLookup(policy),
      OPTS,
    );
    await reconciler.reconcileChain(CHAIN);
    // Second pass: the event source still returns the event, but claim() is now exhausted.
    await reconciler.reconcileChain(CHAIN);

    expect(await store.usage(key, WINDOW, RESERVED_AT)).toBe(actual / GWEI);
  });

  it("counts a reconciliation but refunds nothing when the policy is gone", async () => {
    const reconciler = new SpendReconciler(
      source(100n, [event()]),
      fakeStore([claim(10n ** 15n)]),
      policyLookup(undefined), // get() always throws UnknownPolicyError
      OPTS,
    );
    const [stats] = await reconciler.reconcileAll();
    expect(stats).toMatchObject({reservationsReconciled: 1, weiRefunded: 0n});
  });

  it("skips events that match no sponsorship of ours", async () => {
    const {rule} = await reservedWalletCap(10n ** 15n);
    const reconciler = new SpendReconciler(
      source(100n, [event(), event({nonce: 8n})]),
      fakeStore([]), // claim always returns undefined
      policyLookup({tenantId: ACME, id: "p", rules: [rule]}),
      OPTS,
    );
    const [stats] = await reconciler.reconcileAll();
    expect(stats).toMatchObject({eventsScanned: 2, reservationsReconciled: 0, weiRefunded: 0n});
  });

  it("stays behind the head by the confirmation depth", async () => {
    const st = fakeStore([]);
    const reconciler = new SpendReconciler(
      source(3n, []),
      st,
      policyLookup({tenantId: ACME, id: "p", rules: []}),
      OPTS,
    );
    // latest 3, confirmations 5 => safeHead negative => nothing to scan, no checkpoint written.
    const result = await reconciler.reconcileChain(CHAIN);
    expect(result).toBeUndefined();
    expect(st.checkpoint).toBeUndefined();
  });

  it("bounds the scan window by maxBlockRange and starts from the checkpoint", async () => {
    let scanned: {from: bigint; to: bigint} | undefined;
    const src: UserOpEventSource = {
      latestBlock: async () => 10_000n,
      getUserOperationEvents: async (_c, from, to) => {
        scanned = {from, to};
        return [];
      },
    };
    const st = fakeStore([]);
    await st.saveCheckpoint(CHAIN, 100n);
    const reconciler = new SpendReconciler(src, st, policyLookup({tenantId: ACME, id: "p", rules: []}), {
      ...OPTS,
      maxBlockRange: 500,
    });
    await reconciler.reconcileChain(CHAIN);
    // from = checkpoint+1 = 101; to = min(safeHead=9995, 101+500-1=600) = 600.
    expect(scanned).toEqual({from: 101n, to: 600n});
    expect(st.checkpoint).toBe(600n);
  });

  it("does not true up an operations quota, only spend caps", async () => {
    const store = new InMemoryQuotaStore();
    const opsRule = new QuotaRule(store, {
      name: "ops",
      subject: "wallet",
      unit: "operations",
      limit: 100n,
      windowSeconds: WINDOW,
    });
    await opsRule.evaluate(contextForReservation(10n ** 15n)); // consumes 1 operation
    const key = `quota:ops:${CHAIN}:${SENDER.toLowerCase()}`;
    expect(await store.usage(key, WINDOW, RESERVED_AT)).toBe(1n);

    const reconciler = new SpendReconciler(
      source(100n, [event()]),
      fakeStore([claim(10n ** 15n)]),
      policyLookup({tenantId: ACME, id: "p", rules: [opsRule]}),
      OPTS,
    );
    await reconciler.reconcileAll();
    // Operation count is exact; reconciliation must leave it untouched.
    expect(await store.usage(key, WINDOW, RESERVED_AT)).toBe(1n);
  });
});
