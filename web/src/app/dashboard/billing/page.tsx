"use client";

import {Busy, Empty, ErrorNote, Field, Mono, Note, PageHeader, Panel} from "@/components/panel";
import {formatDate, useAccountResource} from "@/lib/account";

/**
 * The subscription: whether it is paid, until when, and what has been paid.
 *
 * There is no "Start a subscription" button, and its absence is deliberate rather than unfinished.
 * Recording a payment extends a period and is gated on `billing:write`, which only the platform
 * role holds — a browser session holds `tenant_admin` and never that. A button here could only ever
 * produce a 403, so the page says who to ask instead.
 */
interface SubscriptionStatus {
  readonly state: "active" | "grace" | "lapsed" | "none";
  readonly plan?: string;
  readonly paidThrough?: number;
  readonly graceEndsAt?: number;
  readonly allowsSponsorship: boolean;
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
      "Past the grace window, so sponsorship is refused. Your balance, keys and history are untouched and come straight back when a payment is recorded.",
  },
  none: {
    label: "No subscription",
    tone: "text-ash-400",
    detail: "No subscription has ever been recorded for this account.",
  },
};

export default function BillingPage() {
  const billing = useAccountResource<Billing>("subscription");
  const status = billing.data?.status;
  const payments = billing.data?.payments ?? [];

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
              {/* The one combination that looks like a contradiction and is not. */}
              {status.state === "none" && status.allowsSponsorship ? (
                <p className="mt-2 text-[12px] leading-relaxed text-ash-500">
                  Sponsorship is permitted anyway because this deployment allows accounts with no
                  subscription — which is why &ldquo;no subscription&rdquo; is a distinct state from
                  &ldquo;lapsed&rdquo; rather than a synonym for it.
                </p>
              ) : null}
            </div>
          </Panel>

          <Panel title="Payments">
            {payments.length === 0 ? (
              <Empty>
                Nothing recorded yet. A payment extends the paid period from the moment it is
                recorded, and each one is listed here with the period it bought.
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

          <Note>
            Payments are recorded by the platform operator, not from this page: extending a period
            needs <code className="font-mono text-ash-400">billing:write</code>, which a dashboard
            session deliberately never holds. To start or renew a subscription, contact your
            operator — they record it against your account and this page updates.
          </Note>
        </>
      )}
    </div>
  );
}
