import type {Metadata} from "next";
import Link from "next/link";
import {LuZap} from "react-icons/lu";

import {DocsNav} from "./nav";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Integrate with the paymaster, or run one: funding a balance, minting a key, the SDK, the error reference, and the operational traps worth knowing before you hit them.",
};

/**
 * The docs shell.
 *
 * A layout rather than markup inside the page so the sidebar keeps its scroll position and its
 * scrollspy state across navigations, and so the page itself stays a server component — the content
 * is static, and shipping it as one would mean shipping every paragraph to the browser as JS.
 */
export default function DocsLayout({children}: {children: React.ReactNode}) {
  return (
    <div className="min-h-screen bg-oil-950">
      <header className="sticky top-0 z-30 border-b border-ash-800/60 bg-oil-950/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid size-7 place-items-center rounded-md bg-ash-200 text-oil-950">
                <LuZap className="size-4" aria-hidden />
              </span>
              <span className="text-sm font-semibold text-ash-100">Paymaster</span>
            </Link>
            <span className="text-ash-700" aria-hidden>
              /
            </span>
            <span className="text-sm text-ash-400">Docs</span>
          </div>
          <Link
            href="/dashboard"
            className="rounded-md bg-ash-200 px-3.5 py-1.5 text-sm font-medium text-oil-950 transition-colors hover:bg-ash-100"
          >
            Sign in
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-10 px-4 sm:px-6">
        <DocsNav />
        <main className="min-w-0 flex-1 py-10 lg:py-14">{children}</main>
      </div>
    </div>
  );
}
