"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {motion} from "motion/react";
import {LuMenu, LuZap} from "react-icons/lu";
import {useState} from "react";

import {NAV_ITEMS} from "./nav";
import {ConnectionBar} from "./connection-bar";
import {cn} from "@/lib/utils";
import {Sheet, SheetContent, SheetTitle, SheetTrigger} from "@/components/ui/sheet";
import {Button} from "@/components/ui/button";

/**
 * The frame: a persistent rail, a status bar that is always visible, and the page.
 *
 * The connection bar is deliberately in the frame rather than on any one page. Every number in this
 * app is only as trustworthy as the scrape it came from, so "when did we last hear from the
 * backend" has to be on screen wherever you navigate — a stale dashboard that looks live is the
 * failure mode this whole app exists to avoid.
 */
export function AppShell({children}: {children: React.ReactNode}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
        <Brand />
        <NavList onNavigate={() => undefined} />
        <RailFooter />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-oil-950/80 px-4 backdrop-blur-md">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger
              render={
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                  <LuMenu className="size-5" />
                </Button>
              }
            />
            <SheetContent side="left" className="w-64 border-border bg-sidebar p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <Brand />
              <NavList onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>

          <ConnectionBar />
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
      <span className="grid size-7 place-items-center rounded-md bg-ash-100 text-oil-950">
        <LuZap className="size-4" aria-hidden />
      </span>
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight text-ash-100">Paymaster</div>
        <div className="text-[11px] text-ash-500">ERC-4337 · v0.7</div>
      </div>
    </div>
  );
}

function NavList({onNavigate}: {onNavigate: () => void}) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 space-y-0.5 p-2">
      {NAV_ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active ? "text-ash-100" : "text-ash-400 hover:bg-oil-800 hover:text-ash-200",
            )}
          >
            {active ? (
              // One shared layout id, so the marker slides between items instead of blinking out
              // and in. Movement here is a wayfinding cue, not decoration.
              <motion.span
                layoutId="nav-active"
                className="absolute inset-0 rounded-md border border-ash-800 bg-oil-800"
                transition={{type: "spring", stiffness: 420, damping: 34}}
              />
            ) : null}
            <Icon className={cn("relative size-4 shrink-0", active ? "text-ash-100" : "text-ash-500")} aria-hidden />
            <span className="relative truncate font-medium">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function RailFooter() {
  return (
    <div className="border-t border-border p-3">
      <p className="text-[11px] leading-relaxed text-ash-600">
        Read-only. Policy and key changes go through the admin API, not this console.
      </p>
    </div>
  );
}
