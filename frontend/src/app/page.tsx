"use client";

import {LuActivity, LuCoins, LuGauge, LuTriangleAlert} from "react-icons/lu";

import {PageHeader} from "@/components/panels/page-header";
import {Panel, EmptyState} from "@/components/viz/panel";
import {StatTile} from "@/components/viz/stat-tile";
import {StatusPill} from "@/components/viz/status";
import {BreakdownBars} from "@/components/viz/breakdown-bars";
import {OUTCOME_SERIES, RateChart} from "@/components/viz/rate-chart";
import {ChainStrip} from "@/components/panels/chain-strip";
import {latestRate, useTelemetry} from "@/hooks/use-telemetry";
import {errorRatio, overallStatus} from "@/lib/telemetry";
import {formatCount, formatDuration, formatEth, formatPercent, formatRate} from "@/lib/format";
import {SERIES_BY_OUTCOME, STATUS} from "@/components/viz/theme";

export default function OverviewPage() {
  const {telemetry, rates, loading} = useTelemetry();

  if (telemetry === undefined) {
    return (
      <>
        <PageHeader title="Overview" description="Sponsorship decisions, spend, and evaluation latency." />
        <Panel title="No telemetry yet">
          <EmptyState
            title={loading ? "Contacting the backend…" : "The backend has not answered"}
            detail={
              loading
                ? undefined
                : "Set PAYMASTER_API_URL to the backend's address and make sure /metrics is reachable from this server."
            }
          />
        </Panel>
      </>
    );
  }

  const status = overallStatus(telemetry);
  const ratio = errorRatio(telemetry);
  const issuedRate = latestRate(rates, "issued");

  return (
    <>
      <PageHeader
        title="Overview"
        description="Sponsorship decisions, spend, and evaluation latency, read from the backend's own metrics."
        actions={<StatusPill severity={status.severity} label={status.headline} />}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Issued"
          value={issuedRate === undefined ? formatCount(telemetry.sponsorships.issued) : formatRate(issuedRate, "")}
          unit={issuedRate === undefined ? "total" : "/s"}
          caption={
            issuedRate === undefined
              ? "Cumulative since the backend started. A rate appears after the second sample."
              : `${formatCount(telemetry.sponsorships.issued)} since the backend started`
          }
          icon={LuActivity}
          spark={rates.map((point) => point.issued)}
          sparkColor={SERIES_BY_OUTCOME["issued"]}
          delay={0}
        />
        <StatTile
          label="Internal error ratio"
          value={formatPercent(ratio)}
          caption="Errors over all sponsorship requests. Denials are excluded — a denial is the service working."
          severity={ratio > 0.05 ? "critical" : ratio > 0.01 ? "warning" : "good"}
          icon={LuTriangleAlert}
          spark={rates.map((point) => point.error)}
          sparkColor={STATUS.critical}
          delay={0.04}
        />
        <StatTile
          label="Policy p99"
          value={formatDuration(telemetry.latencySeconds.p99)}
          caption={`p50 ${formatDuration(telemetry.latencySeconds.p50)} · p95 ${formatDuration(telemetry.latencySeconds.p95)}`}
          severity={
            telemetry.latencySeconds.p99 === undefined
              ? "unknown"
              : telemetry.latencySeconds.p99 > 0.25
                ? "warning"
                : "good"
          }
          icon={LuGauge}
          delay={0.08}
        />
        <StatTile
          label="Gas committed"
          value={formatEth(telemetry.gasCommittedWei)}
          unit="ETH"
          caption="Worst case reserved at signing time. Actual spend is lower — the reconciler trues it up."
          icon={LuCoins}
          spark={rates.map((point) => point.gasCommittedWei)}
          sparkColor={SERIES_BY_OUTCOME["denied"]}
          delay={0.12}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Sponsorship outcomes"
          subtitle="Per-second rates, differenced from consecutive scrapes"
          hint="This window starts when you open the page — the backend exports a snapshot, not a history. For history across restarts, use the Grafana dashboard in deploy/monitoring, which reads the same metrics from Prometheus."
          delay={0.16}
        >
          <RateChart
            data={rates as unknown as Record<string, number>[]}
            series={OUTCOME_SERIES}
            emptyDetail="Rates are computed by differencing two scrapes, so the first point appears one interval after the page loads."
          />
        </Panel>

        <Panel
          title="Denials by rule"
          subtitle="Which rule refused, cumulative"
          hint="A denial is the policy engine working. A single rule dominating usually means a caller is over quota, or someone is probing what you refuse."
          delay={0.2}
        >
          <BreakdownBars
            items={telemetry.denialsByRule}
            emptyTitle="No denials recorded"
            emptyDetail="Every sponsorship request so far has been allowed by every rule."
          />
        </Panel>
      </div>

      <div className="mt-4">
        <ChainStrip chains={telemetry.chains} delay={0.24} />
      </div>
    </>
  );
}
