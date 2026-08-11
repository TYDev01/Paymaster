"use client";

import {motion} from "motion/react";
import type {IconType} from "react-icons";
import {LuCircleAlert, LuCircleCheck, LuCircleHelp, LuTriangleAlert} from "react-icons/lu";

import {cn} from "@/lib/utils";
import type {Severity} from "@/lib/telemetry";
import {Sparkline} from "./sparkline";

/**
 * One number, given the space to be read at a glance.
 *
 * A stat tile rather than a chart is the right form when the data's job is a single headline: a
 * one-point "chart" is a number wearing axes. The optional sparkline adds the one thing the number
 * alone cannot carry — direction — without pretending to be a chart you can read values off.
 *
 * Status is never carried by color alone: every severity ships an ICON as well, so the tile is
 * readable in grayscale, under forced colors, and by a reader who cannot distinguish the hues.
 */
const SEVERITY_ICON: Record<Severity, IconType> = {
  good: LuCircleCheck,
  warning: LuTriangleAlert,
  serious: LuTriangleAlert,
  critical: LuCircleAlert,
  unknown: LuCircleHelp,
};

const SEVERITY_CLASS: Record<Severity, string> = {
  good: "text-good",
  warning: "text-warning",
  serious: "text-serious",
  critical: "text-critical",
  unknown: "text-ash-500",
};

export function StatTile({
  label,
  value,
  unit,
  caption,
  severity,
  icon: Icon,
  spark,
  sparkColor,
  delay = 0,
}: {
  label: string;
  value: string;
  unit?: string;
  caption?: string;
  severity?: Severity;
  icon?: IconType;
  spark?: readonly number[];
  sparkColor?: string;
  delay?: number;
}) {
  const SeverityIcon = severity === undefined ? undefined : SEVERITY_ICON[severity];

  return (
    <motion.div
      initial={{opacity: 0, y: 8}}
      animate={{opacity: 1, y: 0}}
      transition={{duration: 0.32, delay, ease: [0.22, 0.61, 0.36, 1]}}
      className="relative flex flex-col justify-between overflow-hidden rounded-lg border border-border bg-card p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]"
    >
      <div className="flex items-center gap-2">
        {Icon !== undefined ? <Icon className="size-3.5 shrink-0 text-ash-600" aria-hidden /> : null}
        <span className="truncate text-xs font-medium tracking-wide text-ash-400 uppercase">{label}</span>
        {SeverityIcon !== undefined ? (
          <SeverityIcon className={cn("ml-auto size-4 shrink-0", SEVERITY_CLASS[severity!])} aria-hidden />
        ) : null}
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        {/* Tabular figures: without them a changing digit shifts the ones beside it and the eye
            reads movement that is not in the data. */}
        <span className="tnum text-3xl leading-none font-semibold tracking-tight text-ash-100">{value}</span>
        {unit !== undefined ? <span className="text-sm text-ash-500">{unit}</span> : null}
      </div>

      {spark !== undefined && spark.length > 1 ? (
        <div className="mt-3 -mb-1">
          <Sparkline values={spark} color={sparkColor} />
        </div>
      ) : null}

      {caption !== undefined ? <p className="mt-2 text-[11px] leading-snug text-ash-600">{caption}</p> : null}
    </motion.div>
  );
}
