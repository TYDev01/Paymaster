"use client";

import Link from "next/link";
import {LuArrowRight, LuCoins, LuKeyRound, LuReceipt} from "react-icons/lu";

import {useAuth} from "@/components/auth-provider";

/**
 * What a customer needs to do next, in the order they need to do it.
 *
 * Deliberately not a metrics dashboard. A new account has no metrics, and charts that are empty
 * because nothing has happened yet look identical to charts that are empty because something is
 * broken. The three steps below are the actual path from "signed up" to "sponsoring".
 */
export default function OverviewPage() {
  const {session} = useAuth();
  if (session === undefined) return null;

  return (
    <>
      <h1 className="text-lg font-semibold text-ash-100">Welcome to {session.tenant.name}</h1>
      <p className="mt-1 text-sm leading-relaxed text-ash-500">
        Three things stand between you and a sponsored transaction. They can be done in any order,
        but nothing is sponsored until all three are true.
      </p>

      <ol className="mt-6 space-y-3">
        <Step
          href="/dashboard/keys"
          icon={LuKeyRound}
          index={1}
          title="Mint an API key"
          detail="Your dApp calls the paymaster with this. It is shown once, at creation, and never again — we store only its hash, so a leaked key is revoked rather than recovered."
        />
        <Step
          href="/dashboard/funding"
          icon={LuCoins}
          index={2}
          title="Fund your balance"
          detail="Gas comes out of a balance you own on chain, per chain. Only your operations spend it, and that is enforced by the contract rather than by our bookkeeping."
        />
        <Step
          href="/dashboard/billing"
          icon={LuReceipt}
          index={3}
          title="Start a subscription"
          detail="Platform access is a prepaid period, separate from gas. If it lapses, sponsorship stops — your balance, keys and history stay exactly where they are."
        />
      </ol>
    </>
  );
}

function Step({
  href,
  icon: Icon,
  index,
  title,
  detail,
}: {
  href: string;
  icon: React.ComponentType<{className?: string}>;
  index: number;
  title: string;
  detail: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="group flex gap-3 rounded-lg border border-ash-800 bg-oil-900 p-4 transition-colors hover:border-ash-700 hover:bg-oil-800/60"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-ash-800 bg-oil-950 text-ash-400">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[10px] font-medium tabular-nums text-ash-700">{index}</span>
            <span className="text-sm font-medium text-ash-100">{title}</span>
            <LuArrowRight
              className="size-3.5 text-ash-700 transition-transform group-hover:translate-x-0.5 group-hover:text-ash-500"
              aria-hidden
            />
          </span>
          <span className="mt-1 block text-[11px] leading-relaxed text-ash-500">{detail}</span>
        </span>
      </Link>
    </li>
  );
}
