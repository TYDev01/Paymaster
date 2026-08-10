import type {ChainRegistry} from "../chain/chainRegistry.js";
import type {PaymasterFunding} from "../chain/chainAdapter.js";
import type {Alert, Alerter} from "./alerting.js";
import {AlertGate} from "./alertGate.js";
import type {BackgroundService} from "./backgroundService.js";
import {IntervalLoop} from "./intervalLoop.js";

export interface FundingMonitorOptions {
  /** How often to poll each chain's deposit and stake. */
  readonly intervalMs: number;
  /** How long before an unresolved low-funding alert re-fires. */
  readonly reAlertMs: number;
}

/** One chain's funding snapshot, or the error that prevented reading it. */
export type FundingResult =
  | {readonly chainId: number; readonly ok: true; readonly funding: PaymasterFunding}
  | {readonly chainId: number; readonly ok: false; readonly error: string};

/**
 * Watches every chain's paymaster deposit and stake against its configured thresholds and alerts
 * before sponsorship fails.
 *
 * This closes a specific silent-failure gap: a drained deposit stops all sponsorship on a chain with
 * an opaque on-chain AA31, and an under-staked paymaster is quietly unbundleable — neither surfaces
 * anywhere until a customer reports failures. `ChainAdapter.getPaymasterFunding` already computes the
 * threshold breach; this puts it on a timer and routes it to alerting.
 *
 * Disabled chains are polled too. A chain disabled for serving still holds a deposit an operator may
 * need to withdraw or top up, and "we stopped watching the money when we stopped serving" is exactly
 * the kind of gap this exists to prevent.
 *
 * A failed read is itself an alert (`funding-read-error:<chainId>`): if we cannot tell whether the
 * deposit is low, we must not stay silent, because "can't read the balance" and "balance is fine"
 * are not the same and treating them alike is how a drain goes unnoticed.
 */
export class FundingMonitor implements BackgroundService {
  readonly name = "funding-monitor";
  readonly #chains: ChainRegistry;
  readonly #gate: AlertGate;
  readonly #loop: IntervalLoop;
  /** Last observed result per chain, for the metrics endpoint. */
  #last: readonly FundingResult[] = [];

  /** Called with each poll's results, for metrics. Kept separate from alerting, which is edge-triggered. */
  readonly #onResults: ((results: readonly FundingResult[]) => void) | undefined;

  constructor(
    chains: ChainRegistry,
    alerter: Alerter,
    options: FundingMonitorOptions,
    now: () => number = () => Date.now(),
    onResults?: (results: readonly FundingResult[]) => void,
  ) {
    this.#chains = chains;
    this.#gate = new AlertGate(alerter, {reAlertMs: options.reAlertMs}, now);
    this.#onResults = onResults;
    this.#loop = new IntervalLoop(this.name, options.intervalMs, () => this.checkOnce().then(() => undefined));
  }

  start(): Promise<void> {
    return this.#loop.start();
  }

  stop(): void {
    this.#loop.stop();
  }

  /** The most recent poll's results. Empty until the first tick completes. */
  get lastResults(): readonly FundingResult[] {
    return this.#last;
  }

  /**
   * Polls every chain once and reconciles alerts. Returns the per-chain results so it can be driven
   * directly from a test or a one-shot CLI check, not only from the timer.
   */
  async checkOnce(): Promise<readonly FundingResult[]> {
    const results = await Promise.all(this.#chains.adapters.map((adapter) => this.#readOne(adapter.chainId)));
    this.#last = results;
    this.#onResults?.(results);
    await this.#gate.reconcile(results.flatMap(toAlerts));
    return results;
  }

  async #readOne(chainId: number): Promise<FundingResult> {
    try {
      const funding = await this.#chains.getEvenIfDisabled(chainId).getPaymasterFunding();
      return {chainId, ok: true, funding};
    } catch (error) {
      return {chainId, ok: false, error: error instanceof Error ? error.message : String(error)};
    }
  }
}

/** Maps a chain's funding result to the alerts that should be active for it right now. */
function toAlerts(result: FundingResult): Alert[] {
  if (!result.ok) {
    return [
      {
        key: `funding-read-error:${result.chainId}`,
        severity: "critical",
        title: "paymaster funding unreadable",
        detail: `could not read deposit/stake for chain ${result.chainId}: ${result.error}`,
        labels: {chainId: String(result.chainId)},
      },
    ];
  }

  const alerts: Alert[] = [];
  const {chainId, funding} = result;

  // Deposit is critical: without it the EntryPoint rejects every sponsored op (AA31).
  if (funding.depositBelowThreshold) {
    alerts.push({
      key: `deposit-low:${chainId}`,
      severity: "critical",
      title: "paymaster deposit below threshold",
      detail: `chain ${chainId} deposit is ${funding.deposit} wei, below the configured minimum`,
      labels: {chainId: String(chainId), deposit: String(funding.deposit)},
    });
  }

  // Stake is a warning: an under-staked paymaster is unbundleable but not yet failing settled ops,
  // and topping up stake has an unbonding delay, so operators want lead time rather than a page.
  if (funding.stakeBelowThreshold) {
    alerts.push({
      key: `stake-low:${chainId}`,
      severity: "warning",
      title: "paymaster stake below threshold",
      detail: `chain ${chainId} stake is ${funding.stake} wei${funding.staked ? "" : " (not staked)"}, below the configured minimum`,
      labels: {chainId: String(chainId), stake: String(funding.stake), staked: String(funding.staked)},
    });
  }

  return alerts;
}
