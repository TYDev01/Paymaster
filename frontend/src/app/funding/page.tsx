"use client";

import {LuCoins, LuLock, LuTriangleAlert} from "react-icons/lu";

import {PageHeader} from "@/components/panels/page-header";
import {Panel, EmptyState} from "@/components/viz/panel";
import {StatTile} from "@/components/viz/stat-tile";
import {StatusPill} from "@/components/viz/status";
import {useTelemetry} from "@/hooks/use-telemetry";
import {chainName, formatEth} from "@/lib/format";
import type {ChainView, Severity} from "@/lib/telemetry";

export default function FundingPage() {
  const {telemetry} = useTelemetry();
  const chains = telemetry?.chains ?? [];

  const totalDeposit = chains.reduce((sum, c) => sum + (c.depositWei ?? 0), 0);
  const totalStake = chains.reduce((sum, c) => sum + (c.stakeWei ?? 0), 0);
  const belowThreshold = chains.filter((c) => c.depositBelowThreshold === true || c.stakeBelowThreshold === true);

  return (
    <>
      <PageHeader
        title="Funding"
        description="The deposit pays for sponsored gas; the stake is what lets a bundler accept our operations at all. Both are per chain, and both are read from the EntryPoint."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Total deposit"
          value={formatEth(totalDeposit)}
          unit="ETH"
          caption="Summed across chains. Native units differ per chain, so treat this as a rollup, not a currency total."
          icon={LuCoins}
          delay={0}
        />
        <StatTile
          label="Total stake"
          value={formatEth(totalStake)}
          unit="ETH"
          caption="Withdrawing stake needs an unlock and the full unstake delay. Plan exits."
          icon={LuLock}
          delay={0.04}
        />
        <StatTile
          label="Below threshold"
          value={String(belowThreshold.length)}
          unit={belowThreshold.length === 1 ? "chain" : "chains"}
          caption="At zero deposit every operation on that chain fails on chain, at the EntryPoint."
          severity={belowThreshold.length > 0 ? "critical" : "good"}
          icon={LuTriangleAlert}
          delay={0.08}
        />
      </div>

      <div className="mt-4">
        <Panel
          title="Per chain"
          subtitle="Deposit and stake, against their configured minimums"
          hint="The bar is filled relative to twice the configured minimum, so the threshold marker sits at the midpoint. It is a reference point, not a capacity: there is no maximum deposit."
          delay={0.12}
        >
          {chains.length === 0 ? (
            <EmptyState title="No chains reported" />
          ) : (
            <ul className="space-y-5">
              {chains.map((chain) => (
                <li key={chain.chainId}>
                  <FundingRow chain={chain} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function FundingRow({chain}: {chain: ChainView}) {
  const severity: Severity = chain.fundingUnreadable
    ? "serious"
    : chain.depositBelowThreshold === true
      ? "critical"
      : chain.stakeBelowThreshold === true
        ? "warning"
        : "good";

  const label = chain.fundingUnreadable
    ? "Unreadable"
    : chain.depositBelowThreshold === true
      ? "Deposit below minimum"
      : chain.stakeBelowThreshold === true
        ? "Stake below minimum"
        : "Funded";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-ash-100">{chainName(chain.chainId)}</span>
          <span className="tnum font-mono text-[11px] text-ash-600">{chain.chainId}</span>
        </div>
        <StatusPill severity={severity} label={label} />
      </div>

      {chain.fundingUnreadable ? (
        // "Unknown" is not "fine". The monitor could not read the balance, and saying so is the
        // whole point — a zero-length bar here would read as an empty deposit.
        <p className="rounded-md border border-serious/25 bg-serious/10 px-3 py-2 text-[11px] text-serious">
          The funding monitor could not read this chain&apos;s deposit or stake. The balance is unknown, not
          known-good — treat it as a potential deposit alert until it can be read.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FundingBar
            label="Deposit"
            wei={chain.depositWei}
            below={chain.depositBelowThreshold === true}
            color="var(--series-1)"
          />
          <FundingBar
            label="Stake"
            wei={chain.stakeWei}
            below={chain.stakeBelowThreshold === true}
            color="var(--series-3)"
          />
        </div>
      )}
    </div>
  );
}

/**
 * One balance, with its threshold marked.
 *
 * The scale is anchored to the threshold rather than to the largest balance on screen: the question
 * an operator has is "is this above the line", and a bar scaled to the biggest chain would make a
 * healthy small chain look nearly empty.
 *
 * The exact threshold is not in the metrics — only the boolean "below" gauge is exported — so the
 * marker's position is a fixed midpoint and the BOOLEAN drives the color. The bar never implies a
 * precision the data does not have.
 */
function FundingBar({
  label,
  wei,
  below,
  color,
}: {
  label: string;
  wei: number | undefined;
  below: boolean;
  color: string;
}) {
  const known = wei !== undefined;
  // Without the threshold value, "above the line" is drawn as a healthy two-thirds and "below" as a
  // third — enough to read the state at a glance, not enough to read a value off.
  const fill = !known ? 0 : below ? 30 : 66;

  return (
    <div className="rounded-md border border-border bg-oil-900 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-ash-500">{label}</span>
        <span className={`tnum text-sm font-medium ${below ? "text-critical" : "text-ash-100"}`}>
          {formatEth(wei)} <span className="text-[11px] text-ash-600">ETH</span>
        </span>
      </div>

      <div className="relative mt-2 h-2 w-full overflow-hidden rounded-[2px] bg-oil-800">
        <div
          className="h-full rounded-r-[4px] transition-[width] duration-500"
          style={{width: `${fill}%`, backgroundColor: below ? "var(--status-critical)" : color}}
        />
        {/* The threshold, as a hairline. Marked, never implied by color alone. */}
        <span className="absolute inset-y-0 left-1/2 w-px bg-ash-400" aria-hidden />
      </div>
      <p className="mt-1.5 text-[10px] text-ash-600">
        {known ? (below ? "Below the configured minimum" : "Above the configured minimum") : "Not reported"}
      </p>
    </div>
  );
}
