"use client";

import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";

import type {Telemetry} from "@/lib/telemetry";

/**
 * Polls the backend and keeps a rolling window of what it saw.
 *
 * The backend exports a Prometheus SNAPSHOT — counters and gauges as they stand right now. There is
 * no history in it, so this builds one the only honest way available: sample on an interval, keep
 * the samples, and difference consecutive counters to get rates.
 *
 * Two consequences that the UI states plainly rather than hiding:
 *
 *   * **Charts start empty.** A freshly opened page has one sample and no deltas, so there is
 *     nothing to draw yet. Back-filling it with invented points would make an idle service look
 *     busy and a busy one look idle.
 *   * **The window is per-browser-tab.** It is not a metrics store. For real history — across
 *     restarts, over days, with alert evaluation — Prometheus is scraping the same endpoint, and
 *     the Grafana dashboard in `deploy/monitoring/` is the tool for that.
 *
 * A counter that goes BACKWARDS means the process restarted and reset its counters. That sample is
 * dropped rather than reported as a negative rate.
 */
export interface TelemetrySample {
  readonly at: number;
  readonly telemetry: Telemetry;
}

export interface RatePoint {
  readonly at: number;
  readonly issued: number;
  readonly denied: number;
  readonly error: number;
  readonly authFailures: number;
  readonly gasCommittedWei: number;
}

export interface TelemetryState {
  readonly telemetry: Telemetry | undefined;
  readonly connected: boolean;
  readonly error: string | undefined;
  /** When the last successful scrape landed. Undefined until one has. */
  readonly lastSuccessAt: number | undefined;
  readonly checkedAt: number | undefined;
  readonly scrapeLatencyMs: number | undefined;
  readonly loading: boolean;
  /** Per-second rates, one point per interval since the page opened. Empty until two samples. */
  readonly rates: readonly RatePoint[];
  readonly history: readonly TelemetrySample[];
  readonly intervalMs: number;
  setIntervalMs: (ms: number) => void;
  refresh: () => void;
}

const MAX_SAMPLES = 120;

const TelemetryContext = createContext<TelemetryState | undefined>(undefined);

export function TelemetryProvider({children}: {children: React.ReactNode}) {
  const [telemetry, setTelemetry] = useState<Telemetry>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [lastSuccessAt, setLastSuccessAt] = useState<number>();
  const [checkedAt, setCheckedAt] = useState<number>();
  const [scrapeLatencyMs, setScrapeLatencyMs] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<TelemetrySample[]>([]);
  const [intervalMs, setIntervalMs] = useState(5_000);

  // Guards against overlapping polls: a slow backend must make the page update less often, never
  // queue requests until the browser drowns.
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch("/api/telemetry", {cache: "no-store"});
      const body = (await response.json()) as {
        connected: boolean;
        error?: string;
        checkedAt: number;
        scrapeLatencyMs?: number;
        telemetry: Telemetry | null;
      };

      setCheckedAt(body.checkedAt);
      setConnected(body.connected);
      setScrapeLatencyMs(body.scrapeLatencyMs);

      if (body.connected && body.telemetry !== null) {
        setTelemetry(body.telemetry);
        setLastSuccessAt(body.checkedAt);
        setError(undefined);
        setHistory((previous) => [...previous, {at: body.checkedAt, telemetry: body.telemetry!}].slice(-MAX_SAMPLES));
      } else {
        // The last good telemetry stays on screen, labelled with its age. Blanking the page on a
        // blip throws away the most recent thing anyone knew about the system.
        setError(body.error ?? "backend unreachable");
      }
    } catch (cause) {
      setConnected(false);
      setError(cause instanceof Error ? cause.message : String(cause));
      setCheckedAt(Date.now());
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The first poll is scheduled rather than called in the effect body. Calling it directly starts
    // a state update inside the effect, which React flags as a cascading render — and on a page that
    // re-renders every few seconds anyway, the extra pass is worth avoiding. A zero-delay timer runs
    // it on the next tick, which is immediate to a reader and out of the render path.
    const immediate = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      clearTimeout(immediate);
      clearInterval(timer);
    };
  }, [poll, intervalMs]);

  const rates = useMemo(() => computeRates(history), [history]);

  const value: TelemetryState = {
    telemetry,
    connected,
    error,
    lastSuccessAt,
    checkedAt,
    scrapeLatencyMs,
    loading,
    rates,
    history,
    intervalMs,
    setIntervalMs,
    refresh: () => void poll(),
  };

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

export function useTelemetry(): TelemetryState {
  const context = useContext(TelemetryContext);
  if (context === undefined) throw new Error("useTelemetry must be used inside a TelemetryProvider");
  return context;
}

function computeRates(history: readonly TelemetrySample[]): RatePoint[] {
  const points: RatePoint[] = [];

  for (let i = 1; i < history.length; i++) {
    const previous = history[i - 1]!;
    const current = history[i]!;
    const seconds = (current.at - previous.at) / 1000;
    if (seconds <= 0) continue;

    const delta = (now: number, before: number) => {
      // A decrease means the counter reset (a restart). There is no meaningful rate across that
      // boundary, so it is reported as a gap rather than as a spike or a negative.
      if (now < before) return Number.NaN;
      return (now - before) / seconds;
    };

    points.push({
      at: current.at,
      issued: delta(current.telemetry.sponsorships.issued, previous.telemetry.sponsorships.issued),
      denied: delta(current.telemetry.sponsorships.denied, previous.telemetry.sponsorships.denied),
      error: delta(current.telemetry.sponsorships.error, previous.telemetry.sponsorships.error),
      authFailures: delta(current.telemetry.abuse.authFailures, previous.telemetry.abuse.authFailures),
      gasCommittedWei: delta(current.telemetry.gasCommittedWei, previous.telemetry.gasCommittedWei),
    });
  }

  return points;
}

/** The most recent rate for one field, or undefined while the window is still filling. */
export function latestRate(rates: readonly RatePoint[], field: keyof Omit<RatePoint, "at">): number | undefined {
  for (let i = rates.length - 1; i >= 0; i--) {
    const value = rates[i]![field];
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}
