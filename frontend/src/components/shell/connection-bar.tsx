"use client";

import {AnimatePresence, motion} from "motion/react";
import {LuRefreshCw, LuTriangleAlert} from "react-icons/lu";
import {useEffect, useState} from "react";

import {useTelemetry} from "@/hooks/use-telemetry";
import {formatAge, formatMillis} from "@/lib/format";
import {Button} from "@/components/ui/button";
import {Select, SelectContent, SelectItem, SelectTrigger} from "@/components/ui/select";
import {cn} from "@/lib/utils";

const INTERVALS = [
  {value: "2000", label: "2s"},
  {value: "5000", label: "5s"},
  {value: "15000", label: "15s"},
  {value: "60000", label: "1m"},
];

/**
 * Whether what you are looking at is current.
 *
 * The freshness clock ticks locally rather than only updating on each poll, so a backend that has
 * stopped answering shows its age climbing instead of freezing at "3s ago" — a frozen timestamp is
 * indistinguishable from a healthy one at a glance, which is exactly the wrong impression.
 */
export function ConnectionBar() {
  const {connected, error, lastSuccessAt, scrapeLatencyMs, loading, intervalMs, setIntervalMs, refresh} =
    useTelemetry();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const stale = lastSuccessAt !== undefined && now - lastSuccessAt > Math.max(15_000, intervalMs * 3);
  const state = loading && lastSuccessAt === undefined ? "connecting" : connected && !stale ? "live" : "down";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative grid size-2.5 shrink-0 place-items-center" aria-hidden>
          <span
            className={cn(
              "size-2 rounded-full",
              state === "live" ? "bg-good" : state === "connecting" ? "bg-ash-500" : "bg-critical",
            )}
          />
          {state === "live" ? (
            <motion.span
              className="absolute size-2 rounded-full bg-good"
              animate={{scale: [1, 2.4], opacity: [0.5, 0]}}
              transition={{duration: 2, repeat: Infinity, ease: "easeOut"}}
            />
          ) : null}
        </span>

        <div className="min-w-0 text-xs">
          <span className={cn("font-medium", state === "down" ? "text-critical" : "text-ash-200")}>
            {state === "live" ? "Live" : state === "connecting" ? "Connecting" : "Backend unreachable"}
          </span>
          <span className="mx-1.5 text-ash-700">·</span>
          <span className="tnum text-ash-500">
            {state === "down" && lastSuccessAt !== undefined
              ? `last data ${formatAge(lastSuccessAt, now)}`
              : `updated ${formatAge(lastSuccessAt, now)}`}
          </span>
          {scrapeLatencyMs !== undefined && state === "live" ? (
            <>
              <span className="mx-1.5 hidden text-ash-700 sm:inline">·</span>
              <span className="tnum hidden text-ash-600 sm:inline">scrape {formatMillis(scrapeLatencyMs)}</span>
            </>
          ) : null}
        </div>
      </div>

      <AnimatePresence>
        {error !== undefined && state === "down" ? (
          <motion.div
            initial={{opacity: 0, y: -4}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -4}}
            className="hidden min-w-0 items-center gap-1.5 rounded-md border border-critical/30 bg-critical/10 px-2 py-1 text-[11px] text-critical md:flex"
          >
            <LuTriangleAlert className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{error}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="ml-auto flex items-center gap-1.5">
        <Select value={String(intervalMs)} onValueChange={(value) => setIntervalMs(Number(value))}>
          <SelectTrigger size="sm" className="h-8 w-[74px] border-ash-800 bg-oil-850 text-xs" aria-label="Refresh interval">
            {/* The label is rendered here rather than through Select.Value: that component prints
                the raw item value, so the trigger read "5000" instead of "5s". */}
            <span data-slot="select-value" className="flex flex-1 text-left">
              {INTERVALS.find((option) => option.value === String(intervalMs))?.label ?? `${intervalMs}ms`}
            </span>
          </SelectTrigger>
          <SelectContent>
            {INTERVALS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="ghost" size="icon" className="size-8" onClick={refresh} aria-label="Refresh now">
          <LuRefreshCw className={cn("size-3.5", loading ? "animate-spin" : undefined)} />
        </Button>
      </div>
    </div>
  );
}
