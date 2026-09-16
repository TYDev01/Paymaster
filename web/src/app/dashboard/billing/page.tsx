"use client";

import {useWallets, type ConnectedWallet} from "@privy-io/react-auth";
import {useState, type FormEvent} from "react";
import {LuCheck, LuExternalLink, LuTriangleAlert, LuWallet} from "react-icons/lu";
import {createPublicClient, custom, type Hex} from "viem";

import {Busy, Empty, ErrorNote, Field, Mono, Note, PageHeader, Panel} from "@/components/panel";
import {formatDate, postAccountResource, useAccountResource} from "@/lib/account";

/**
 * The subscription: whether it is paid, until when, what has been paid — and paying for it.
 *
 * Paying is self-service. The customer sends the plan price from their own wallet to the platform's
 * subscription address, with their account's payment reference as the transaction data, and the page
 * then claims it. The backend reads the transfer from the chain and credits the period; nothing the
 * browser says about the amount or the recipient is trusted, and a transfer that does not carry this
 * account's reference cannot be credited here.
 */
interface SubscriptionStatus {
  readonly state: "active" | "grace" | "lapsed" | "none";
  readonly plan?: string;
  readonly paidThrough?: number;
  readonly graceEndsAt?: number;
  readonly allowsSponsorship: boolean;
  readonly renewalDue: boolean;
}

interface Payment {
  readonly id: string;
  readonly amountWei?: string;
  readonly chainId?: number;
  readonly txHash?: string;
  readonly extendedFrom: number;
  readonly extendedTo: number;
  readonly recordedBy: string;
  readonly note?: string;
  readonly recordedAt: number;
}

interface Billing {
  readonly status: SubscriptionStatus;
  readonly payments: readonly Payment[];
}

interface PlanView {
  readonly id: string;
  readonly name: string;
  readonly periodSeconds: number;
  /** Wei per period, keyed by chain id. */
  readonly priceWei: Readonly<Record<string, string>>;
  readonly limits: {readonly operationsPerDay: string | null; readonly weiPerDay: string | null};
  readonly chainIds: readonly number[] | null;
}

interface BillingOptions {
  readonly plans: readonly PlanView[];
  /** Null when this deployment takes payments through the operator only. */
  readonly treasury: string | null;
  readonly paymentReference: string | null;
}

/** Chain names and currencies, borrowed from the funding view where it knows the chain. */
interface FundingChain {
  readonly chainId: number;
  readonly chainName: string;
  readonly nativeCurrency: {readonly symbol: string; readonly decimals: number};
  readonly explorerUrl: string;
}

const STATE_COPY: Record<SubscriptionStatus["state"], {label: string; tone: string; detail: string}> = {
  active: {
    label: "Active",
    tone: "text-ash-100",
    detail: "Paid up. Sponsorship runs normally.",
  },
  grace: {
    label: "In grace",
    tone: "text-warning",
    detail:
      "The paid period has ended and the grace window has not. Sponsorship continues for now, and stops when the window closes.",
  },
  lapsed: {
    label: "Lapsed",
    tone: "text-critical",
    detail:
      "Past the grace window, so sponsorship is refused. Your balance, keys and history are untouched and come straight back when a payment is credited.",
  },
  none: {
    label: "No subscription",
    tone: "text-ash-400",
    detail: "No subscription has ever been recorded for this account.",
  },
};

export default function BillingPage() {
  const billing = useAccountResource<Billing>("subscription");
  const options = useAccountResource<BillingOptions>("billing");
  const funding = useAccountResource<FundingChain[]>("funding");
  const status = billing.data?.status;
  const payments = billing.data?.payments ?? [];

  const reloadAll = () => {
    billing.reload();
    options.reload();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        lede="Platform access is a prepaid period, separate from gas. If it lapses, sponsorship stops — your balance, keys and history stay exactly where they are."
      />

      {billing.loading && billing.data === undefined ? (
        <Panel>
          <Busy label="Reading your subscription…" />
        </Panel>
      ) : billing.error !== undefined ? (
        <Panel>
          <ErrorNote message={billing.error} onRetry={billing.reload} />
        </Panel>
      ) : status === undefined ? (
        <Panel>
          <Empty>No subscription information was returned for this account.</Empty>
        </Panel>
      ) : (
        <>
          <Panel title="Status">
            <dl>
              <Field label="State">
                <span className={STATE_COPY[status.state].tone}>{STATE_COPY[status.state].label}</span>
              </Field>
              {status.plan === undefined ? null : <Field label="Plan">{status.plan}</Field>}
              {status.paidThrough === undefined ? null : (
                <Field label="Paid through">{formatDate(status.paidThrough)}</Field>
              )}
              {status.graceEndsAt === undefined ? null : (
                <Field label="Grace ends">{formatDate(status.graceEndsAt)}</Field>
              )}
              <Field label="Sponsorship">
                {status.allowsSponsorship ? (
                  <span className="text-ash-100">Permitted</span>
                ) : (
                  <span className="text-critical">Refused</span>
                )}
              </Field>
            </dl>
            <div className="border-t border-ash-800/60 p-4">
              <p className="text-[12px] leading-relaxed text-ash-500">{STATE_COPY[status.state].detail}</p>
              {status.renewalDue && status.state === "active" ? (
                <p className="mt-2 text-[12px] leading-relaxed text-warning">
                  This period ends on {formatDate(status.paidThrough)}. Renew below to keep sponsorship running — paying
                  early adds to the time you have left rather than replacing it.
                </p>
              ) : null}
              {/* The one combination that looks like a contradiction and is not. */}
              {status.state === "none" && status.allowsSponsorship ? (
                <p className="mt-2 text-[12px] leading-relaxed text-ash-500">
                  Sponsorship is permitted anyway because this deployment allows accounts with no subscription — which
                  is why &ldquo;no subscription&rdquo; is a distinct state from &ldquo;lapsed&rdquo; rather than a
                  synonym for it.
                </p>
              ) : null}
            </div>
          </Panel>

          <Pay options={options.data} chains={funding.data ?? []} onCredited={reloadAll} />

          <Panel title="Payments">
            {payments.length === 0 ? (
              <Empty>
                Nothing recorded yet. A payment extends the paid period from the moment it is credited, and each one is
                listed here with the period it bought.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-ash-800/60 text-[11px] uppercase tracking-wide text-ash-600">
                      <th className="px-4 py-2 font-medium">Recorded</th>
                      <th className="px-4 py-2 font-medium">Period</th>
                      <th className="px-4 py-2 font-medium">Amount</th>
                      <th className="px-4 py-2 font-medium">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((payment) => (
                      <tr key={payment.id} className="border-b border-ash-800/30 last:border-b-0">
                        <td className="px-4 py-2.5 text-ash-400">{formatDate(payment.recordedAt)}</td>
                        <td className="px-4 py-2.5 text-ash-300">
                          {formatDate(payment.extendedFrom)} → {formatDate(payment.extendedTo)}
                        </td>
                        {/* Absent means a granted period — a trial or a credit — not a zero payment. */}
                        <td className="px-4 py-2.5 text-ash-300">
                          {payment.amountWei === undefined ? (
                            <span className="text-ash-600">granted</span>
                          ) : (
                            <Mono>{payment.amountWei} wei</Mono>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {payment.txHash === undefined ? (
                            <span className="text-ash-600">—</span>
                          ) : (
                            <Mono title={payment.txHash}>
                              {payment.txHash.slice(0, 10)}…{payment.txHash.slice(-6)}
                            </Mono>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

type PayState =
  | {phase: "idle"}
  | {phase: "signing"}
  | {phase: "mining"; hash: Hex}
  | {phase: "claiming"; hash: Hex; attempt: number}
  | {phase: "done"; hash: Hex; paidThrough: number}
  | {phase: "error"; message: string; hash?: Hex};

/** How many times, and how far apart, a fresh payment is re-claimed while it gathers confirmations. */
const CLAIM_ATTEMPTS = 30;
const CLAIM_INTERVAL_MS = 8_000;

function Pay({
  options,
  chains,
  onCredited,
}: {
  options: BillingOptions | undefined;
  chains: readonly FundingChain[];
  onCredited: () => void;
}) {
  const {wallets, ready} = useWallets();
  const [planId, setPlanId] = useState<string | undefined>(undefined);
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [state, setState] = useState<PayState>({phase: "idle"});

  if (options === undefined) return null;

  if (options.plans.length === 0 || options.treasury === null || options.paymentReference === null) {
    return (
      <Note>
        Payments on this deployment are recorded by the platform operator rather than from this page. To start or renew
        a subscription, contact your operator — they record it against your account and this page updates.
      </Note>
    );
  }

  const plan = options.plans.find((p) => p.id === planId) ?? options.plans[0]!;
  const payableChains = Object.keys(plan.priceWei).map(Number);
  const selectedChain = chainId !== undefined && payableChains.includes(chainId) ? chainId : payableChains[0]!;
  const price = BigInt(plan.priceWei[String(selectedChain)]!);
  const chain = chains.find((c) => c.chainId === selectedChain);
  const decimals = chain?.nativeCurrency.decimals ?? 18;
  const symbol = chain?.nativeCurrency.symbol ?? "ETH";
  const wallet = wallets[0];
  const busy = state.phase === "signing" || state.phase === "mining" || state.phase === "claiming";

  async function claimUntilCredited(hash: Hex): Promise<void> {
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt++) {
      setState({phase: "claiming", hash, attempt});
      try {
        const result = await postAccountResource<{subscription: {paidThrough: number}}>("claim", {
          chainId: selectedChain,
          txHash: hash,
          planId: plan.id,
        });
        setState({phase: "done", hash, paidThrough: result.subscription.paidThrough});
        onCredited();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A fresh payment is expected to be refused as unconfirmed for a few blocks. Anything else is
        // a real answer and is shown as-is.
        if (/already been credited/i.test(message)) {
          onCredited();
          setState({phase: "error", message: "That payment was already credited to this account.", hash});
          return;
        }
        if (!/confirmations|not on chain yet/i.test(message) || attempt === CLAIM_ATTEMPTS) {
          setState({phase: "error", message, hash});
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CLAIM_INTERVAL_MS));
      }
    }
  }

  async function pay() {
    if (
      wallet === undefined ||
      options === undefined ||
      options.treasury === null ||
      options.paymentReference === null
    ) {
      return;
    }
    const hash = await sendPayment(
      wallet,
      selectedChain,
      options.treasury as Hex,
      options.paymentReference as Hex,
      price,
      setState,
    );
    if (hash !== undefined) await claimUntilCredited(hash);
  }

  return (
    <Panel title="Pay for a period">
      <div className="space-y-4 p-4">
        <fieldset>
          <legend className="text-[11px] uppercase tracking-wide text-ash-600">Plan</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {options.plans.map((p) => (
              <label
                key={p.id}
                className={`cursor-pointer rounded-md border px-3 py-2.5 transition-colors ${
                  p.id === plan.id ? "border-ash-500 bg-oil-800" : "border-ash-800 hover:border-ash-700"
                }`}
              >
                <input
                  type="radio"
                  name="plan"
                  value={p.id}
                  checked={p.id === plan.id}
                  onChange={() => setPlanId(p.id)}
                  className="sr-only"
                />
                <span className="block text-sm text-ash-100">{p.name}</span>
                <span className="mt-0.5 block text-[11px] text-ash-500">
                  {Math.round(p.periodSeconds / 86_400)} days
                  {p.limits.operationsPerDay === null ? "" : ` · ${p.limits.operationsPerDay} operations/day`}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {payableChains.length > 1 ? (
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ash-600">Pay on</span>
            <select
              value={selectedChain}
              onChange={(event) => setChainId(Number(event.target.value))}
              className="mt-1.5 block w-full rounded-md border border-ash-800 bg-oil-950 px-3 py-2 text-sm text-ash-100"
            >
              {payableChains.map((id) => (
                <option key={id} value={id}>
                  {chains.find((c) => c.chainId === id)?.chainName ?? `Chain ${id}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ash-300">
            {formatUnits(price, decimals)} {symbol}{" "}
            <span className="text-ash-600">on {chain?.chainName ?? `chain ${selectedChain}`}</span>
          </p>
          <button
            type="button"
            onClick={() => void pay()}
            disabled={!ready || wallet === undefined || busy}
            className="flex items-center gap-2 rounded-md bg-ash-200 px-4 py-2 text-sm font-medium text-oil-950 transition-colors hover:bg-ash-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <LuWallet className="size-4" aria-hidden />
            {state.phase === "signing"
              ? "Confirm in wallet…"
              : state.phase === "mining"
                ? "Mining…"
                : state.phase === "claiming"
                  ? "Crediting…"
                  : "Pay"}
          </button>
        </div>

        <PayFeedback state={state} explorerUrl={chain?.explorerUrl} />

        <p className="text-[11px] leading-relaxed text-ash-600">
          Sent to <Mono>{options.treasury}</Mono> with your payment reference as the transaction data, which is what
          ties it to this account. Paying more than one period&apos;s price buys whole extra periods.
        </p>

        <ManualClaim plans={options.plans} chainIds={payableChains} onCredited={onCredited} />
      </div>
    </Panel>
  );
}

/**
 * Claiming a payment that was already sent — the tab was closed while it confirmed, or it was sent
 * from another wallet with the right reference.
 */
function ManualClaim({
  plans,
  chainIds,
  onCredited,
}: {
  plans: readonly PlanView[];
  chainIds: readonly number[];
  onCredited: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [chainId, setChainId] = useState(chainIds[0] ?? 0);
  const [result, setResult] = useState<{ok: boolean; message: string} | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-ash-500 underline underline-offset-2 hover:text-ash-300"
      >
        Already paid? Claim a transaction
      </button>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const credited = await postAccountResource<{subscription: {paidThrough: number}}>("claim", {
        chainId,
        txHash: txHash.trim(),
        planId,
      });
      setResult({ok: true, message: `Credited. Paid through ${formatDate(credited.subscription.paidThrough)}.`});
      onCredited();
    } catch (err) {
      setResult({ok: false, message: err instanceof Error ? err.message : String(err)});
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-ash-800 p-3">
      <input
        value={txHash}
        onChange={(event) => setTxHash(event.target.value)}
        placeholder="0x… transaction hash"
        className="w-full rounded-md border border-ash-800 bg-oil-950 px-3 py-2 font-mono text-[12px] text-ash-100"
      />
      <div className="flex flex-wrap gap-2">
        <select
          value={planId}
          onChange={(event) => setPlanId(event.target.value)}
          className="rounded-md border border-ash-800 bg-oil-950 px-2 py-1.5 text-sm text-ash-100"
        >
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={chainId}
          onChange={(event) => setChainId(Number(event.target.value))}
          className="rounded-md border border-ash-800 bg-oil-950 px-2 py-1.5 text-sm text-ash-100"
        >
          {chainIds.map((id) => (
            <option key={id} value={id}>
              Chain {id}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())}
          className="rounded-md border border-ash-700 px-3 py-1.5 text-sm text-ash-200 hover:border-ash-500 disabled:opacity-40"
        >
          {busy ? "Checking…" : "Claim"}
        </button>
      </div>
      {result === undefined ? null : (
        <p className={`text-[11px] leading-relaxed ${result.ok ? "text-ash-300" : "text-critical"}`}>
          {result.message}
        </p>
      )}
    </form>
  );
}

function PayFeedback({state, explorerUrl}: {state: PayState; explorerUrl: string | undefined}) {
  const link = (hash: Hex) =>
    explorerUrl === undefined ? null : (
      <a
        href={`${explorerUrl.replace(/\/+$/, "")}/tx/${hash}`}
        target="_blank"
        rel="noreferrer"
        className="ml-1 inline-flex items-center gap-1 underline underline-offset-2 hover:text-ash-200"
      >
        View
        <LuExternalLink className="size-3" aria-hidden />
      </a>
    );

  switch (state.phase) {
    case "mining":
      return <p className="text-[11px] text-ash-500">Waiting for the payment to be mined.{link(state.hash)}</p>;
    case "claiming":
      return (
        <p className="text-[11px] text-ash-500">
          Paid. Waiting for confirmations before it is credited (check {state.attempt} of {CLAIM_ATTEMPTS}) — you can
          leave this page and claim it later with the hash.{link(state.hash)}
        </p>
      );
    case "done":
      return (
        <p className="flex gap-2 text-[11px] text-ash-300">
          <LuCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Credited. Paid through {formatDate(state.paidThrough)}.{link(state.hash)}
          </span>
        </p>
      );
    case "error":
      return (
        <p className="flex gap-2 rounded-md border border-critical/25 bg-critical/10 px-3 py-2 text-[11px] leading-relaxed text-critical">
          <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {state.message}
            {state.hash === undefined ? null : link(state.hash)}
          </span>
        </p>
      );
    default:
      return null;
  }
}

/** Sends the payment and waits for it to be mined. Returns the hash, or undefined on failure. */
async function sendPayment(
  wallet: ConnectedWallet,
  chainId: number,
  treasury: Hex,
  reference: Hex,
  value: bigint,
  onState: (state: PayState) => void,
): Promise<Hex | undefined> {
  onState({phase: "signing"});
  try {
    // Switch first and confirm it took: a payment sent on the wrong chain goes to this address on
    // THAT chain, where nothing will ever credit it.
    await wallet.switchChain(chainId);
    const provider = await wallet.getEthereumProvider();
    const active = (await provider.request({method: "eth_chainId"})) as string;
    if (Number.parseInt(active, 16) !== chainId) {
      onState({
        phase: "error",
        message: `Your wallet is on chain ${Number.parseInt(active, 16)}, not ${chainId}. Switch it and try again.`,
      });
      return undefined;
    }

    const hash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{from: wallet.address, to: treasury, value: `0x${value.toString(16)}`, data: reference}],
    })) as Hex;
    onState({phase: "mining", hash});

    const receipt = await createPublicClient({transport: custom(provider)}).waitForTransactionReceipt({
      hash,
      timeout: 180_000,
    });
    if (receipt.status !== "success") {
      onState({phase: "error", message: "The payment was mined but reverted, so nothing was paid.", hash});
      return undefined;
    }
    return hash;
  } catch (err) {
    const code = (err as {code?: unknown})?.code;
    const raw = String((err as {message?: unknown})?.message ?? err ?? "");
    onState({
      phase: "error",
      message:
        code === 4001 || /user rejected|denied|cancell?ed/i.test(raw)
          ? "You cancelled the payment in your wallet."
          : /insufficient funds/i.test(raw)
            ? "That wallet does not hold enough to cover the payment and its gas."
            : raw || "The wallet rejected the payment.",
    });
    return undefined;
  }
}

/** Wei as a decimal amount, exactly — see formatWei on the funding page for why not a float. */
function formatUnits(wei: bigint, decimals: number, places = 6): string {
  const digits = wei.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits
    .slice(digits.length - decimals)
    .slice(0, places)
    .replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
