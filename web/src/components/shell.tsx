"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {
  LuCoins,
  LuKeyRound,
  LuListChecks,
  LuLogOut,
  LuReceipt,
  LuShieldCheck,
  LuTriangleAlert,
  LuZap,
} from "react-icons/lu";
import type {ReactNode} from "react";

import {useAuth} from "@/components/auth-provider";
import {SignIn} from "@/components/sign-in";
import {formatDate, useAccountResource} from "@/lib/account";

const NAV = [
  {href: "/dashboard", label: "Overview", icon: LuZap},
  {href: "/dashboard/keys", label: "API keys", icon: LuKeyRound},
  {href: "/dashboard/policies", label: "Policies", icon: LuListChecks},
  {href: "/dashboard/funding", label: "Funding", icon: LuCoins},
  {href: "/dashboard/billing", label: "Billing", icon: LuReceipt},
] as const;

/**
 * The signed-in frame, and the gate in front of it.
 *
 * Every page here needs a session, so the gate lives once in the shell rather than being repeated
 * — and, more importantly, rather than being FORGOTTEN on a new page. The pages themselves are then
 * written as though a session exists, because inside this component one does.
 *
 * This is presentation only. The session cookie is httpOnly and the backend re-checks the tenant on
 * every request, so rendering a page without a session would show empty panels and 401s rather than
 * anyone else's data. The gate is for the customer's benefit, not the boundary's.
 */
export function Shell({children}: {children: ReactNode}) {
  const {session} = useAuth();
  const pathname = usePathname();

  if (session === undefined) return <SignIn />;

  return (
    <div className="flex min-h-screen bg-oil-950">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ash-800/60 bg-oil-900 sm:flex">
        <Link href="/" className="flex items-center gap-2.5 px-4 py-4 transition-opacity hover:opacity-80">
          <span className="grid size-7 place-items-center rounded-md bg-ash-200 text-oil-950">
            <LuZap className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ash-100">{session.tenant.name}</p>
            <p className="truncate text-[11px] text-ash-600">{session.tenant.role}</p>
          </div>
        </Link>

        <nav className="flex-1 px-2 py-2">
          <ul className="space-y-0.5">
            {NAV.map(({href, label, icon: Icon}) => {
              // Exact match for the index, prefix for the rest — otherwise /dashboard stays lit on
              // every child route and the nav never tells you where you are.
              const active = href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                      active ? "bg-oil-800 text-ash-100" : "text-ash-500 hover:bg-oil-800/50 hover:text-ash-300"
                    }`}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <SessionFooter />
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <RenewalBanner />
          {children}
        </div>
      </main>
    </div>
  );
}

interface SubscriptionSummary {
  readonly status: {
    readonly state: "active" | "grace" | "lapsed" | "none";
    readonly paidThrough?: number;
    readonly graceEndsAt?: number;
    readonly renewalDue: boolean;
  };
}

/**
 * The notice before a subscription lapses, on every page rather than only on Billing.
 *
 * The backend's notice sweep sends the same warning by webhook; this is the half that does not depend
 * on anyone having configured one. Rendered inside the session gate, so it never fetches for a
 * signed-out visitor, and silent on any error — a banner that fails must not replace the page.
 */
function RenewalBanner() {
  const pathname = usePathname();
  const billing = useAccountResource<SubscriptionSummary>("subscription");
  const status = billing.data?.status;
  if (status === undefined || pathname.startsWith("/dashboard/billing")) return null;

  let message: string | undefined;
  if (status.state === "lapsed") {
    message = "Your subscription has lapsed, so sponsorship is refused. Renew to restore it.";
  } else if (status.state === "grace") {
    message = `Your subscription has ended. Sponsorship stops on ${formatDate(status.graceEndsAt)} unless you renew.`;
  } else if (status.renewalDue) {
    message = `Your subscription ends on ${formatDate(status.paidThrough)}.`;
  }
  if (message === undefined) return null;

  const urgent = status.state !== "active";
  return (
    <Link
      href="/dashboard/billing"
      className={`mb-6 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] transition-colors ${
        urgent
          ? "border-critical/30 bg-critical/10 text-critical hover:bg-critical/15"
          : "border-warning/30 bg-warning/10 text-warning hover:bg-warning/15"
      }`}
    >
      <LuTriangleAlert className="size-3.5 shrink-0" aria-hidden />
      <span>
        {message} <span className="underline underline-offset-2">Go to billing</span>
      </span>
    </Link>
  );
}

function SessionFooter() {
  const {session, signOut} = useAuth();
  if (session === undefined) return null;

  return (
    <div className="border-t border-ash-800/60 px-4 py-3">
      <p className="truncate text-[11px] text-ash-600" title={session.subject}>
        {session.subject}
      </p>
      <button
        type="button"
        onClick={() => void signOut()}
        className="mt-2 flex items-center gap-1.5 text-[11px] text-ash-500 transition-colors hover:text-ash-300"
      >
        <LuLogOut className="size-3.5" aria-hidden />
        Sign out
      </button>
      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-ash-700">
        <LuShieldCheck className="mt-0.5 size-3 shrink-0" aria-hidden />
        Your session is held in a cookie this page cannot read, and is never stored in the browser.
      </p>
    </div>
  );
}
