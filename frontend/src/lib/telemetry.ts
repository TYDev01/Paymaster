import {
  histogramQuantile,
  labelValues,
  sumByLabel,
  sumOf,
  valueOf,
  type MetricsSnapshot,
} from "./prometheus";

/**
 * The dashboard's view of the paymaster, derived from one `/metrics` scrape and one health probe.
 *
 * This is the only place metric NAMES appear outside the parser. Components read this shape, so a
 * renamed series breaks one file rather than a dozen components — and, more usefully, the mapping
 * from "what the backend exports" to "what an operator is looking for" is legible in one screen.
 *
 * Counters are reported as cumulative totals, not rates. A single scrape cannot produce a rate; the
 * client computes those by differencing consecutive scrapes, which is the honest way to do it and
 * is why the charts start empty rather than inventing a history.
 */
export interface ChainView {
  readonly chainId: string;
  readonly healthy: boolean | undefined;
  readonly blockNumber: number | undefined;
  readonly circuitOpen: boolean | undefined;
  readonly depositWei: number | undefined;
  readonly stakeWei: number | undefined;
  readonly depositBelowThreshold: boolean | undefined;
  readonly stakeBelowThreshold: boolean | undefined;
  readonly fundingUnreadable: boolean;
  readonly sponsorships: {issued: number; denied: number; error: number};
  readonly gasCommittedWei: number;
  /** From the health probe rather than metrics: the RPC round trip this replica measured. */
  readonly rpcLatencyMs: number | undefined;
}

export interface Telemetry {
  readonly scrapedAt: number;
  readonly metricsEnabled: boolean;
  readonly health: HealthView | undefined;
  readonly chains: readonly ChainView[];
  readonly sponsorships: {issued: number; denied: number; error: number; total: number};
  readonly gasCommittedWei: number;
  readonly decisions: {allowed: number; denied: number};
  readonly denialsByRule: readonly {key: string; value: number}[];
  readonly denialsByCode: readonly {key: string; value: number}[];
  readonly latencySeconds: {p50?: number; p95?: number; p99?: number};
  readonly abuse: {authFailures: number; ipBlocks: number; rejectionsByReason: readonly {key: string; value: number}[]};
}

export interface HealthView {
  readonly status: string;
  readonly policies?: {loaded: boolean; generation: number};
  readonly chains?: readonly {chainId: number; healthy: boolean; blockNumber?: string; latencyMs?: number}[];
}

export function buildTelemetry(snapshot: MetricsSnapshot, health: HealthView | undefined): Telemetry {
  // The endpoint answers "# metrics are disabled" when METRICS_ENABLED is false. Distinguishing
  // that from "scraped fine, nothing has happened yet" matters: one is a config choice to surface,
  // the other is an idle service.
  const metricsEnabled = Object.keys(snapshot.families).length > 0;

  const chainIds = new Set<string>([
    ...labelValues(snapshot, "paymaster_chain_healthy", "chain"),
    ...labelValues(snapshot, "paymaster_deposit_wei", "chain"),
    ...labelValues(snapshot, "paymaster_sponsorships_total", "chain"),
    ...(health?.chains ?? []).map((c) => String(c.chainId)),
  ]);

  const chains: ChainView[] = [...chainIds]
    .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))
    .map((chainId) => {
      const fromHealth = health?.chains?.find((c) => String(c.chainId) === chainId);
      const healthyGauge = valueOf(snapshot, "paymaster_chain_healthy", {chain: chainId});
      const circuit = valueOf(snapshot, "paymaster_chain_circuit_open", {chain: chainId});

      return {
        chainId,
        // The health probe is the fresher signal — it is measured on request, while the gauge is as
        // old as the last monitor tick — so it wins when both are present.
        healthy: fromHealth?.healthy ?? (healthyGauge === undefined ? undefined : healthyGauge === 1),
        blockNumber:
          fromHealth?.blockNumber !== undefined
            ? Number(fromHealth.blockNumber)
            : valueOf(snapshot, "paymaster_chain_block_number", {chain: chainId}),
        circuitOpen: circuit === undefined ? undefined : circuit === 1,
        depositWei: valueOf(snapshot, "paymaster_deposit_wei", {chain: chainId}),
        stakeWei: valueOf(snapshot, "paymaster_stake_wei", {chain: chainId}),
        depositBelowThreshold: booleanGauge(snapshot, chainId, "deposit"),
        stakeBelowThreshold: booleanGauge(snapshot, chainId, "stake"),
        fundingUnreadable: booleanGauge(snapshot, chainId, "read_error") === true,
        sponsorships: {
          issued: sumOf(snapshot, "paymaster_sponsorships_total", {chain: chainId, outcome: "issued"}),
          denied: sumOf(snapshot, "paymaster_sponsorships_total", {chain: chainId, outcome: "denied"}),
          error: sumOf(snapshot, "paymaster_sponsorships_total", {chain: chainId, outcome: "error"}),
        },
        gasCommittedWei: sumOf(snapshot, "paymaster_gas_committed_wei_total", {chain: chainId}),
        rpcLatencyMs: fromHealth?.latencyMs,
      };
    });

  const issued = sumOf(snapshot, "paymaster_sponsorships_total", {outcome: "issued"});
  const denied = sumOf(snapshot, "paymaster_sponsorships_total", {outcome: "denied"});
  const errored = sumOf(snapshot, "paymaster_sponsorships_total", {outcome: "error"});

  return {
    scrapedAt: snapshot.scrapedAt,
    metricsEnabled,
    health,
    chains,
    sponsorships: {issued, denied, error: errored, total: issued + denied + errored},
    gasCommittedWei: sumOf(snapshot, "paymaster_gas_committed_wei_total"),
    decisions: {
      allowed: sumOf(snapshot, "paymaster_policy_decisions_total", {outcome: "allowed"}),
      denied: sumOf(snapshot, "paymaster_policy_decisions_total", {outcome: "denied"}),
    },
    denialsByRule: sumByLabel(snapshot, "paymaster_policy_denials_total", "rule"),
    denialsByCode: sumByLabel(snapshot, "paymaster_policy_denials_total", "code"),
    latencySeconds: {
      p50: histogramQuantile(snapshot, "paymaster_policy_evaluation_seconds", 0.5),
      p95: histogramQuantile(snapshot, "paymaster_policy_evaluation_seconds", 0.95),
      p99: histogramQuantile(snapshot, "paymaster_policy_evaluation_seconds", 0.99),
    },
    abuse: {
      authFailures: sumOf(snapshot, "paymaster_auth_failures_total"),
      ipBlocks: sumOf(snapshot, "paymaster_ip_blocks_total"),
      rejectionsByReason: sumByLabel(snapshot, "paymaster_ip_rejections_total", "reason"),
    },
  };
}

function booleanGauge(snapshot: MetricsSnapshot, chain: string, kind: string): boolean | undefined {
  const value = valueOf(snapshot, "paymaster_funding_below_threshold", {chain, kind});
  return value === undefined ? undefined : value === 1;
}

// ------------------------------------------------------------------------------------------------
// Derived judgements
// ------------------------------------------------------------------------------------------------

export type Severity = "good" | "warning" | "serious" | "critical" | "unknown";

/**
 * The single line an operator reads first.
 *
 * Ordered by what stops sponsorship soonest, which is not the same as by metric magnitude: a
 * drained deposit fails every operation on a chain, while a high denial rate may be the policy
 * working exactly as configured.
 */
export function overallStatus(telemetry: Telemetry): {severity: Severity; headline: string} {
  if (telemetry.health === undefined) {
    return {severity: "unknown", headline: "Backend unreachable"};
  }
  const belowDeposit = telemetry.chains.filter((c) => c.depositBelowThreshold === true);
  if (belowDeposit.length > 0) {
    return {
      severity: "critical",
      headline: `Deposit below threshold on ${belowDeposit.length} chain${belowDeposit.length > 1 ? "s" : ""}`,
    };
  }
  const unhealthy = telemetry.chains.filter((c) => c.healthy === false);
  if (unhealthy.length > 0) {
    return {severity: "critical", headline: `${unhealthy.length} chain RPC unhealthy`};
  }
  const openCircuits = telemetry.chains.filter((c) => c.circuitOpen === true);
  if (openCircuits.length > 0) {
    return {severity: "serious", headline: `${openCircuits.length} RPC circuit open`};
  }
  if (telemetry.chains.some((c) => c.fundingUnreadable)) {
    return {severity: "serious", headline: "Funding unreadable on a chain"};
  }
  const belowStake = telemetry.chains.filter((c) => c.stakeBelowThreshold === true);
  if (belowStake.length > 0) {
    return {severity: "warning", headline: `Stake below threshold on ${belowStake.length}`};
  }
  const errorRatio = telemetry.sponsorships.total === 0 ? 0 : telemetry.sponsorships.error / telemetry.sponsorships.total;
  if (errorRatio > 0.05) {
    return {severity: "critical", headline: "Sponsorship error rate above 5%"};
  }
  return {severity: "good", headline: "All systems nominal"};
}

/** Errors over all sponsorship requests. Denials are excluded: a denial is the service working. */
export function errorRatio(telemetry: Telemetry): number {
  return telemetry.sponsorships.total === 0 ? 0 : telemetry.sponsorships.error / telemetry.sponsorships.total;
}
