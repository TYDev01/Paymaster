import {describe, expect, it} from "vitest";

import type {PaymasterFunding} from "../src/chain/chainAdapter.js";
import type {ChainRegistry} from "../src/chain/chainRegistry.js";
import type {Alert, Alerter} from "../src/monitoring/alerting.js";
import {FundingMonitor} from "../src/monitoring/fundingMonitor.js";

interface ChainState {
  chainId: number;
  funding?: PaymasterFunding;
  error?: Error;
}

/** A structural stand-in for the parts of ChainRegistry the monitor touches. */
function fakeChains(states: ChainState[]): ChainRegistry {
  const byId = new Map(states.map((s) => [s.chainId, s]));
  return {
    adapters: states.map((s) => ({chainId: s.chainId})),
    getEvenIfDisabled(chainId: number) {
      const state = byId.get(chainId)!;
      return {
        getPaymasterFunding: async (): Promise<PaymasterFunding> => {
          if (state.error) throw state.error;
          return state.funding!;
        },
      };
    },
  } as unknown as ChainRegistry;
}

function capturing() {
  const fired: Alert[] = [];
  const resolved: string[] = [];
  const alerter: Alerter = {
    fire: (a) => {
      fired.push(a);
    },
    resolve: (k) => {
      resolved.push(k);
    },
  };
  return {alerter, fired, resolved};
}

function funding(over: Partial<PaymasterFunding> = {}): PaymasterFunding {
  return {
    chainId: 8453,
    deposit: 10n ** 18n,
    stake: 10n ** 18n,
    staked: true,
    unstakeDelaySec: 86_400,
    depositBelowThreshold: false,
    stakeBelowThreshold: false,
    ...over,
  };
}

const OPTS = {intervalMs: 60_000, reAlertMs: 300_000};

describe("FundingMonitor", () => {
  it("stays silent when funding is healthy", async () => {
    const {alerter, fired} = capturing();
    const monitor = new FundingMonitor(fakeChains([{chainId: 8453, funding: funding()}]), alerter, OPTS);
    await monitor.checkOnce();
    expect(fired).toHaveLength(0);
  });

  it("fires a critical alert when the deposit is below threshold", async () => {
    const {alerter, fired} = capturing();
    const monitor = new FundingMonitor(
      fakeChains([{chainId: 8453, funding: funding({depositBelowThreshold: true, deposit: 5n})}]),
      alerter,
      OPTS,
    );
    await monitor.checkOnce();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({key: "deposit-low:8453", severity: "critical"});
  });

  it("fires a warning when the stake is below threshold", async () => {
    const {alerter, fired} = capturing();
    const monitor = new FundingMonitor(
      fakeChains([{chainId: 8453, funding: funding({stakeBelowThreshold: true, staked: false, stake: 0n})}]),
      alerter,
      OPTS,
    );
    await monitor.checkOnce();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({key: "stake-low:8453", severity: "warning"});
  });

  it("treats a read failure as its own critical alert rather than silence", async () => {
    const {alerter, fired} = capturing();
    const monitor = new FundingMonitor(fakeChains([{chainId: 8453, error: new Error("rpc timeout")}]), alerter, OPTS);
    const results = await monitor.checkOnce();
    expect(results[0]).toMatchObject({ok: false});
    expect(fired[0]).toMatchObject({key: "funding-read-error:8453", severity: "critical"});
  });

  it("does not re-fire a persistent breach within the re-alert window", async () => {
    const {alerter, fired} = capturing();
    const monitor = new FundingMonitor(
      fakeChains([{chainId: 8453, funding: funding({depositBelowThreshold: true})}]),
      alerter,
      OPTS,
      () => 1_000, // frozen clock: no re-alert interval elapses
    );
    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(fired).toHaveLength(1);
  });

  it("re-fires once the re-alert window has elapsed", async () => {
    const {alerter, fired} = capturing();
    let clock = 0;
    const monitor = new FundingMonitor(
      fakeChains([{chainId: 8453, funding: funding({depositBelowThreshold: true})}]),
      alerter,
      OPTS,
      () => clock,
    );
    await monitor.checkOnce();
    clock = OPTS.reAlertMs; // exactly at the boundary
    await monitor.checkOnce();
    expect(fired).toHaveLength(2);
  });

  it("resolves the alert when funding recovers", async () => {
    const {alerter, fired, resolved} = capturing();
    const state: ChainState = {chainId: 8453, funding: funding({depositBelowThreshold: true})};
    const monitor = new FundingMonitor(fakeChains([state]), alerter, OPTS, () => 0);
    await monitor.checkOnce();
    expect(fired).toHaveLength(1);

    state.funding = funding({depositBelowThreshold: false});
    await monitor.checkOnce();
    expect(resolved).toEqual(["deposit-low:8453"]);
  });

  it("polls every configured chain, including disabled ones", async () => {
    const {alerter, fired} = capturing();
    const monitor = new FundingMonitor(
      fakeChains([
        {chainId: 1, funding: funding({chainId: 1, depositBelowThreshold: true})},
        {chainId: 10, funding: funding({chainId: 10})},
        {chainId: 8453, funding: funding({chainId: 8453, stakeBelowThreshold: true})},
      ]),
      alerter,
      OPTS,
    );
    const results = await monitor.checkOnce();
    expect(results).toHaveLength(3);
    expect(fired.map((a) => a.key).sort()).toEqual(["deposit-low:1", "stake-low:8453"]);
  });
});
