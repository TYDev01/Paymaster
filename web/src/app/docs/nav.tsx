"use client";

import {useEffect, useState} from "react";
import {LuMenu, LuX} from "react-icons/lu";

/**
 * The documentation sidebar.
 *
 * Grouped by AUDIENCE rather than by document, because that is the real division: almost everything
 * written about this system is for the operator running it, and exactly one path through it belongs
 * to the customer integrating. Filenames alone hide that, and reading the wrong half is a
 * twenty-minute mistake.
 */
const GROUPS = [
  {
    label: "Start",
    items: [
      {href: "#overview", label: "Overview"},
      {href: "#surprises", label: "Five surprises"},
    ],
  },
  {
    label: "Integrate",
    items: [
      {href: "#integrate", label: "The five steps"},
      {href: "#funding", label: "Funding a balance"},
      {href: "#sdk", label: "Calling the SDK"},
      {href: "#errors", label: "Error reference"},
      {href: "#production", label: "Going to production"},
    ],
  },
  {
    label: "Operate",
    items: [
      {href: "#architecture", label: "Architecture"},
      {href: "#rpc", label: "The RPC problem"},
      {href: "#deploy", label: "Deploying"},
      {href: "#truth", label: "Source of truth"},
    ],
  },
] as const;

const ALL = GROUPS.flatMap((g) => g.items.map((i) => i.href.slice(1)));

export function DocsNav() {
  const [active, setActive] = useState<string>(ALL[0] ?? "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Position-based rather than IntersectionObserver: a heading that is scrolled just past the top
    // is the section you are READING, and an observer reports it as no longer intersecting. Taking
    // the last heading above the fold matches what is actually on screen.
    function sync() {
      const y = window.scrollY + 96;
      let current = ALL[0] ?? "";
      for (const id of ALL) {
        const el = document.getElementById(id);
        if (el !== null && el.offsetTop <= y) current = id;
      }
      setActive(current);
    }

    let queued = false;
    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        sync();
        queued = false;
      });
    }

    sync();
    window.addEventListener("scroll", onScroll, {passive: true});
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close contents" : "Open contents"}
        aria-expanded={open}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-ash-800 bg-oil-800 px-4 py-2.5 text-[12px] text-ash-200 shadow-lg transition-colors hover:border-ash-700 lg:hidden"
      >
        {open ? <LuX className="size-4" aria-hidden /> : <LuMenu className="size-4" aria-hidden />}
        Contents
      </button>

      {/* The scrim only exists while the drawer is open, so it can never swallow clicks on the page. */}
      {open ? (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-20 bg-oil-950/70 lg:hidden"
        />
      ) : null}

      <nav
        className={`fixed inset-y-0 left-0 z-20 w-60 overflow-y-auto border-r border-ash-800/60 bg-oil-900 px-4 pb-16 pt-6 transition-transform lg:sticky lg:top-14 lg:z-0 lg:h-[calc(100vh-3.5rem)] lg:translate-x-0 lg:bg-transparent ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {GROUPS.map((group) => (
          <div key={group.label} className="mb-7">
            <p className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ash-600">
              {group.label}
              <span className="h-px flex-1 bg-ash-800" aria-hidden />
            </p>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const on = active === item.href.slice(1);
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={on ? "true" : undefined}
                    className={`rounded border-l-2 px-2.5 py-1 text-[13px] transition-colors ${
                      on
                        ? "border-l-[color:var(--phosphor)] bg-oil-800 text-ash-100"
                        : "border-l-transparent text-ash-500 hover:bg-oil-800/60 hover:text-ash-200"
                    }`}
                  >
                    {item.label}
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </>
  );
}
