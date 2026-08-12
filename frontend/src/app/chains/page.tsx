"use client";

import {LuCircuitBoard, LuLink} from "react-icons/lu";

import {PageHeader} from "@/components/panels/page-header";
import {Panel, EmptyState} from "@/components/viz/panel";
import {StatusPill} from "@/components/viz/status";
import {chainSeverity, chainStatusLabel} from "@/components/panels/chain-status";
import {useTelemetry} from "@/hooks/use-telemetry";
import {chainName, formatBlock, formatCount, formatEth, formatMillis, formatPercent} from "@/lib/format";
import type {ChainView} from "@/lib/telemetry";

export default function ChainsPage() {
  const {telemetry} = useTelemetry();
  const chains = telemetry?.chains ?? [];

  return (
    <>
      <PageHeader
        title="Chains"
        description="Per-chain RPC health, head, circuit-breaker state and sponsorship mix. Chains are isolated by design: one failing takes down sponsorship on that chain and no other."
      />

      {chains.length === 0 ? (
        <Panel title="No chains">
          <EmptyState
            title="Nothing configured"
            detail="Chains come from the backend's CHAINS environment variable. An empty list means none are configured or none are enabled."
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {chains.map((chain, index) => (
            <ChainCard key={chain.chainId} chain={chain} delay={index * 0.04} />
          ))}
        </div>
      )}
    </>
  );
}

function ChainCard({chain, delay}: {chain: ChainView; delay: number}) {
  const total = chain.sponsorships.issued + chain.sponsorships.denied + chain.sponsorships.error;
  const errorShare = total === 0 ? 0 : chain.sponsorships.error / total;

  return (
    <Panel
      title={chainName(chain.chainId)}
      subtitle={`Chain ${chain.chainId}`}
      actions={<StatusPill severity={chainSeverity(chain)} label={chainStatusLabel(chain)} />}
      delay={delay}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Metric label="Head" value={formatBlock(chain.blockNumber)} icon={LuLink} />
        <Metric label="RPC latency" value={formatMillis(chain.rpcLatencyMs)} />
        <Metric
          label="Circuit"
          value={chain.circuitOpen === undefined ? "—" : chain.circuitOpen ? "Open" : "Closed"}
          icon={LuCircuitBoard}
          tone={chain.circuitOpen === true ? "bad" : undefined}
        />
        <Metric label="Deposit" value={`${formatEth(chain.depositWei, 3)} ETH`} tone={chain.depositBelowThreshold === true ? "bad" : undefined} />
      </dl>

      <div className="mt-4 border-t border-border/70 pt-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-xs font-medium text-ash-400">Sponsorship</span>
          <span className="tnum text-[11px] text-ash-600">{formatCount(total)} requests</span>
        </div>

        {total === 0 ? (
          <p className="text-[11px] text-ash-600">Nothing requested on this chain yet.</p>
        ) : (
          <>
            {/* A single stacked bar: the parts sum to every request this chain has seen, so the
                proportions are the point. 2px surface gaps separate the segments. */}
            <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-[2px]">
              <Segment value={chain.sponsorships.issued} total={total} color="var(--series-3)" />
              <Segment value={chain.sponsorships.denied} total={total} color="var(--series-4)" />
              <Segment value={chain.sponsorships.error} total={total} color="var(--status-critical)" />
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
              <LegendItem color="var(--series-3)" label="Issued" value={chain.sponsorships.issued} />
              <LegendItem color="var(--series-4)" label="Denied" value={chain.sponsorships.denied} />
              <LegendItem color="var(--status-critical)" label="Error" value={chain.sponsorships.error} />
              <li className="ml-auto text-ash-600">
                error ratio <span className="tnum text-ash-300">{formatPercent(errorShare)}</span>
              </li>
            </ul>
          </>
        )}
      </div>
    </Panel>
  );
}

function Segment({value, total, color}: {value: number; total: number; color: string}) {
  if (value === 0) return null;
  return <span style={{width: `${(value / total) * 100}%`, backgroundColor: color}} className="h-full" />;
}

function LegendItem({color, label, value}: {color: string; label: string; value: number}) {
  return (
    <li className="flex items-center gap-1.5">
      <span className="size-2 rounded-[2px]" style={{backgroundColor: color}} aria-hidden />
      <span className="text-ash-500">{label}</span>
      <span className="tnum text-ash-200">{formatCount(value)}</span>
    </li>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon?: React.ComponentType<{className?: string}>;
  tone?: "bad";
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[11px] text-ash-600">
        {Icon !== undefined ? <Icon className="size-3" /> : null}
        {label}
      </dt>
      <dd className={`tnum mt-0.5 truncate text-sm font-medium ${tone === "bad" ? "text-critical" : "text-ash-100"}`}>
        {value}
      </dd>
    </div>
  );
}
