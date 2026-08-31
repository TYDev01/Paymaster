"use client";

import {useState} from "react";
import {LuCheck, LuCopy, LuExternalLink} from "react-icons/lu";

import {Busy, Empty, ErrorNote, Field, Mono, Note, PageHeader, Panel} from "@/components/panel";
import {useAccountResource} from "@/lib/account";

/**
 * Where the gas comes from, per chain.
 *
 * Read-only, and that is the design rather than a gap. The balance is a deposit held by the
 * paymaster contract on chain, so funding it is a transaction the customer sends from their own
 * wallet — there is no API that could move their money for them, and a "Deposit" button here could
 * only ever hand them the same address this page already shows.
 */
interface Funding {
  readonly chainId: number;
  readonly chainName: string;
  readonly paymaster: string;
  readonly paymasterKind: string;
  /** Derived from the tenant id, so not a secret — but it IS how a deposit is credited correctly. */
  readonly tenantKey: string;
  readonly balanceWei: string | null;
  readonly nativeCurrency: {readonly symbol: string; readonly decimals: number};
  readonly explorerUrl: string;
}

export default function FundingPage() {
  const funding = useAccountResource<Funding[]>("funding");
  const rows = funding.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Funding"
        lede="Gas is paid from a balance you own on chain, one per chain. Only your operations spend it, and that is enforced by the paymaster contract rather than by our bookkeeping."
      />

      {funding.loading && funding.data === undefined ? (
        <Panel>
          <Busy label="Reading your balances…" />
        </Panel>
      ) : funding.error !== undefined ? (
        <Panel>
          <ErrorNote message={funding.error} onRetry={funding.reload} />
        </Panel>
      ) : rows.length === 0 ? (
        <Panel title="No per-tenant balances">
          <Empty>
            <p>
              None of the configured chains uses a per-tenant paymaster, so there is no balance of
              your own to fund. On this deployment the paymaster is a{" "}
              <span className="text-ash-300">verifying</span> one: it sponsors from a single deposit
              held by the operator, and your usage is governed by policy rather than by a balance.
            </p>
            <p className="mt-2">
              This page fills in on a chain configured with{" "}
              <code className="font-mono text-ash-400">paymasterKind: &quot;tenant&quot;</code>.
            </p>
          </Empty>
        </Panel>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <ChainFunding key={row.chainId} row={row} />
          ))}
          <Note>
            A deposit is credited to your tenant key, not to your wallet address. Sending funds to
            the paymaster without it credits the contract and not your balance.
          </Note>
        </div>
      )}
    </div>
  );
}

function ChainFunding({row}: {row: Funding}) {
  return (
    <Panel
      title={`${row.chainName} · ${row.chainId}`}
      action={
        <a
          href={`${row.explorerUrl.replace(/\/+$/, "")}/address/${row.paymaster}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[11px] text-ash-500 transition-colors hover:text-ash-300"
        >
          Explorer
          <LuExternalLink className="size-3" aria-hidden />
        </a>
      }
    >
      <dl>
        <Field label="Balance">
          {/* A balance that could not be read is NOT zero, and showing zero would tell a customer
              their deposit had vanished. The backend sends null when the RPC failed. */}
          {row.balanceWei === null ? (
            <span className="text-ash-600">unavailable — the chain did not answer</span>
          ) : (
            <span className="text-ash-100">
              {formatWei(row.balanceWei, row.nativeCurrency.decimals)} {row.nativeCurrency.symbol}
            </span>
          )}
        </Field>
        <Field label="Paymaster">
          <CopyableMono value={row.paymaster} />
        </Field>
        <Field label="Your tenant key">
          <CopyableMono value={row.tenantKey} />
        </Field>
      </dl>
    </Panel>
  );
}

function CopyableMono({value}: {value: string}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <Mono title={value}>{value}</Mono>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        aria-label={`Copy ${value}`}
        className="shrink-0 text-ash-600 transition-colors hover:text-ash-300"
      >
        {copied ? <LuCheck className="size-3.5" aria-hidden /> : <LuCopy className="size-3.5" aria-hidden />}
      </button>
    </span>
  );
}

/**
 * Wei as a token amount, without going through a float.
 *
 * `Number(balanceWei)` loses precision above 2^53, which for an 18-decimal token is about 0.009 —
 * well inside the range a real balance occupies. The integer and fractional parts are therefore
 * split as strings, which is exact for any size.
 */
function formatWei(wei: string, decimals: number, places = 6): string {
  let digits = wei.trim();
  if (!/^\d+$/.test(digits)) return "—";
  digits = digits.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).slice(0, places).replace(/0+$/, "");
  const grouped = new Intl.NumberFormat("en").format(BigInt(whole));
  return fraction === "" ? grouped : `${grouped}.${fraction}`;
}
