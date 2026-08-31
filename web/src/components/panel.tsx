"use client";

import {LuCircleAlert, LuInfo, LuLoader} from "react-icons/lu";
import type {ReactNode} from "react";

/**
 * The furniture every account page shares.
 *
 * Extracted because the three pages under /dashboard differ in what they show and not in how they
 * behave: each loads one resource, each can fail, and each has an empty state that has to explain
 * itself rather than showing a bare "no data". Keeping those in one place is what stops the empty
 * states drifting into three different tones of voice.
 */
export function PageHeader({title, lede}: {title: string; lede: string}) {
  return (
    <header>
      <h1 className="text-lg font-semibold text-ash-100">{title}</h1>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ash-500">{lede}</p>
    </header>
  );
}

export function Panel({title, action, children}: {title?: string; action?: ReactNode; children: ReactNode}) {
  return (
    <section className="rounded-lg border border-ash-800 bg-oil-900">
      {title === undefined && action === undefined ? null : (
        <div className="flex items-center justify-between gap-3 border-b border-ash-800/60 px-4 py-3">
          {title === undefined ? <span /> : <h2 className="text-sm font-medium text-ash-200">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Busy({label}: {label: string}) {
  return (
    <p className="flex items-center gap-2 px-4 py-6 text-sm text-ash-500">
      <LuLoader className="size-4 animate-spin" aria-hidden />
      {label}
    </p>
  );
}

/**
 * A failure, stated as a failure.
 *
 * Deliberately not styled as an empty state. "You have no keys" and "we could not read your keys"
 * lead a customer to opposite actions, and rendering the second as the first invites them to mint a
 * duplicate of a key they already have.
 */
export function ErrorNote({message, onRetry}: {message: string; onRetry?: () => void}) {
  return (
    <div className="flex flex-wrap items-start gap-2 px-4 py-4 text-[12px] leading-relaxed text-critical">
      <LuCircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-critical/30 px-2 py-1 text-[11px] transition-colors hover:bg-critical/10"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** An empty state that says WHY it is empty, and what to do about it. */
export function Empty({children}: {children: ReactNode}) {
  return <div className="px-4 py-6 text-[12px] leading-relaxed text-ash-500">{children}</div>;
}

export function Note({children}: {children: ReactNode}) {
  return (
    <p className="flex gap-2 rounded-md border border-ash-800 bg-oil-900/60 px-3 py-2 text-[11px] leading-relaxed text-ash-500">
      <LuInfo className="mt-0.5 size-3.5 shrink-0 text-ash-600" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** A definition row. Used wherever a page is really a list of labelled facts. */
export function Field({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ash-800/40 px-4 py-2.5 last:border-b-0">
      <dt className="text-[11px] uppercase tracking-wide text-ash-600">{label}</dt>
      <dd className="min-w-0 text-sm text-ash-200">{children}</dd>
    </div>
  );
}

export function Mono({children, title}: {children: ReactNode; title?: string}) {
  return (
    <span className="font-mono text-[12px] break-all text-ash-300" {...(title === undefined ? {} : {title})}>
      {children}
    </span>
  );
}
