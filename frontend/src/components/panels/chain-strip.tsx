"use client";

import Link from "next/link";
import {LuArrowRight} from "react-icons/lu";

import {Panel, EmptyState} from "@/components/viz/panel";
import {StatusDot} from "@/components/viz/status";
import {chainName, formatBlock, formatEth, formatMillis} from "@/lib/format";
import type {ChainView} from "@/lib/telemetry";
import {chainSeverity, chainStatusLabel} from "./chain-status";

/**
 * Every chain, one row each, at a glance.
 *
 * Per-chain rather than aggregated because this system is per-chain by design: one unhealthy RPC or
 * one drained deposit takes down sponsorship on that chain and no other. An aggregate "chains: OK"
 * would hide exactly the failure this system isolates.
 */
export function ChainStrip({chains, delay = 0}: {chains: readonly ChainView[]; delay?: number}) {
  return (
    <Panel
      title="Chains"
      subtitle={`${chains.length} configured`}
      actions={
        <Link
          href="/chains"
          className="inline-flex items-center gap-1 text-xs text-ash-400 transition-colors hover:text-ash-100"
        >
          Details <LuArrowRight className="size-3" aria-hidden />
        </Link>
      }
      delay={delay}
    >
      {chains.length === 0 ? (
        <EmptyState
          title="No chains reported"
          detail="The backend exposes chains through CHAINS; if this is empty, none are configured or enabled."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {chains.map((chain) => (
            <div
              key={chain.chainId}
              className="rounded-md border border-border bg-oil-900 p-3 transition-colors hover:border-ash-700"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-ash-100">{chainName(chain.chainId)}</span>
                <span className="tnum shrink-0 font-mono text-[11px] text-ash-600">{chain.chainId}</span>
              </div>

              <div className="mt-2">
                <StatusDot severity={chainSeverity(chain)} label={chainStatusLabel(chain)} />
              </div>

              <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                <Field label="Block" value={formatBlock(chain.blockNumber)} />
                <Field label="Deposit" value={`${formatEth(chain.depositWei, 3)}`} />
                <Field label="RPC" value={formatMillis(chain.rpcLatencyMs)} />
              </dl>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Field({label, value}: {label: string; value: string}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-ash-600">{label}</dt>
      <dd className="tnum truncate font-medium text-ash-200">{value}</dd>
    </div>
  );
}
