"use client";

import {useEffect, useState} from "react";
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

      <TenantFunding />
    </>
  );
}

/**
 * Per-tenant balances, and what to do with them.
 *
 * This panel used to be a note explaining why there was no "Fund" button: there was one shared
 * deposit per chain, so a top-up funded the pool everyone spent from and nothing could say whose
 * balance had been consumed. `TenantPaymaster` closed that — each tenant now holds its own balance
 * inside one staked contract — so the note was removed rather than left to misinform.
 *
 * What is still NOT here is a wallet-connected fund button, and that is a scope decision rather
 * than a missing afternoon. This console authenticates with a single server-held operator key; it
 * has no per-person session and no wallet. A button here would fund whichever tenant owns that key,
 * which is the operator's own — not what a customer clicking "fund my account" would mean. That
 * belongs on the tenant-facing surface, with the customer's own wallet.
 *
 * So this shows the two things a top-up actually requires and that nothing else reveals: the
 * tenant key, which is `keccak256(tenantId)` and cannot be derived from anything else on screen,
 * and the exact call. A plain transfer to the paymaster credits no tenant at all.
 */
function TenantFunding() {
  const state = useAdminResource<TenantFundingRow[]>("funding");
  const rows = state.data ?? [];

  return (
    <div className="mt-4">
      <Panel
        title="Your tenant balance"
        subtitle="Per chain, for the account this console authenticates as"
        hint="A tenant key is keccak256 of the tenant id. It is not a secret, but it is the only way to fund correctly: depositFor(tenantKey) credits a balance, while a plain transfer to the paymaster credits nobody and cannot be attributed afterwards."
        delay={0.16}
      >
        {state.loading ? (
          <p className="text-xs text-ash-600">Reading balances…</p>
        ) : state.error !== undefined ? (
          <p className="rounded-md border border-serious/25 bg-serious/10 px-3 py-2 text-[11px] text-serious">
            {state.error}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No chain here holds per-tenant balances"
            detail="Chains running the single-tenant paymaster are omitted: their deposit is the operator's, shown above, and there is nothing to fund per account."
          />
        ) : (
          <ul className="space-y-4">
            {rows.map((row) => (
              <li key={row.chainId}>
                <TenantFundingRowView row={row} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

interface TenantFundingRow {
  readonly chainId: number;
  readonly chainName: string;
  readonly paymaster: string;
  readonly tenantKey: string;
  /** Wei as a decimal string, or null when the balance could not be read. */
  readonly balanceWei: string | null;
  readonly nativeCurrency: {readonly symbol: string; readonly decimals: number};
}

function TenantFundingRowView({row}: {row: TenantFundingRow}) {
  const unreadable = row.balanceWei === null;
  // WEI, not ether: `formatEth` does the conversion itself. Dividing here as well rendered a
  // 4.2 ETH balance as "<0.0001" — which reads as an empty account rather than a funded one.
  const balanceWei = unreadable ? undefined : Number(row.balanceWei);
  const empty = !unreadable && row.balanceWei === "0";

  return (
    <div className="rounded-md border border-border bg-oil-900 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-ash-100">{row.chainName}</span>
          <span className="tnum font-mono text-[11px] text-ash-600">{row.chainId}</span>
        </div>
        {unreadable ? (
          // Not zero. An unreadable balance and an empty one call for opposite actions, and only
          // one of them is the customer's problem.
          <StatusPill severity="serious" label="Balance unreadable" />
        ) : (
          <span className={`tnum text-sm font-medium ${empty ? "text-critical" : "text-ash-100"}`}>
            {formatEth(balanceWei)} <span className="text-[11px] text-ash-600">{row.nativeCurrency.symbol}</span>
          </span>
        )}
      </div>

      {empty ? (
        <p className="mb-2 rounded-md border border-critical/25 bg-critical/10 px-3 py-2 text-[11px] text-critical">
          Empty. Sponsorship on this chain is refused with 402 until it is funded.
        </p>
      ) : null}

      <dl className="space-y-1.5 text-[11px]">
        <Field label="Paymaster" value={row.paymaster} />
        <Field label="Tenant key" value={row.tenantKey} />
      </dl>

      <code className="mt-2 block overflow-x-auto rounded border border-ash-800 bg-oil-950 px-2 py-1.5 font-mono text-[11px] text-ash-300">
        cast send {row.paymaster} &quot;depositFor(bytes32)&quot; {row.tenantKey} --value 1ether --rpc-url $RPC_URL
      </code>
    </div>
  );
}

function Field({label, value}: {label: string; value: string}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="w-20 shrink-0 text-ash-600">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-ash-300">{value}</dd>
    </div>
  );
}

interface ResourceState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

function useAdminResource<T>(resource: string): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({data: undefined, error: undefined, loading: true});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/admin/${resource}`, {cache: "no-store"});
        const body = (await response.json()) as {data?: T; error?: string};
        if (cancelled) return;
        setState({data: body.data, error: body.error, loading: false});
      } catch (cause) {
        if (!cancelled) {
          setState({data: undefined, error: cause instanceof Error ? cause.message : String(cause), loading: false});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resource]);

  return state;
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
