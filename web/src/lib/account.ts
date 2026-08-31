"use client";

import {useCallback, useEffect, useState} from "react";

/**
 * Reading and writing the customer's own account, from the browser.
 *
 * Every call goes to this app's own `/api/account/*` route handlers rather than to the paymaster
 * backend. That is not indirection for its own sake: the session that authorises these lives in an
 * httpOnly cookie the browser cannot read, so only the server can attach it. See lib/session.ts.
 *
 * Failures are values here, matching the rest of the app. A dashboard whose panels throw on a 502
 * replaces the one thing a customer came for — the state of their account — with a stack trace.
 */
export interface Resource<T> {
  readonly data: T | undefined;
  /** A caveat the backend attached to the rows, e.g. that sponsorships are commitments, not spend. */
  readonly note: string | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  reload(): void;
}

interface Envelope<T> {
  data?: T;
  note?: string;
  error?: string;
}

export function useAccountResource<T>(resource: string): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // Incremented by `reload`, and a dependency of the fetch below. A counter rather than a boolean
  // so two reloads in a row are two fetches: minting a key then reloading must not be a no-op
  // because the flag was already set.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const response = await fetch(`/api/account/${resource}`, {cache: "no-store"});
        const body = (await response.json().catch(() => ({}))) as Envelope<T>;
        if (cancelled) return;
        if (!response.ok) {
          throw new Error(body.error ?? `request failed (${response.status})`);
        }
        // Committed together, and only after the awaits, so no state write can tear this effect
        // down while it is still reading. The sign-in bridge learned that the hard way.
        setData(body.data);
        setNote(body.note);
        setError(undefined);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [resource, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return {data, note, error, loading, reload};
}

/** A write against the account. Throws with the backend's own message, which is customer-facing. */
export async function postAccountResource<T>(resource: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/account/${resource}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as Envelope<T>;
  if (!response.ok) throw new Error(parsed.error ?? `request failed (${response.status})`);
  if (parsed.data === undefined) throw new Error("the server returned no data");
  return parsed.data;
}

/** Unix seconds as a date a person can read. `undefined` is a dash, never today's date. */
export function formatDate(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
