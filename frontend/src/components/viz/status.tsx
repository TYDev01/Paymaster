"use client";

import type {IconType} from "react-icons";
import {LuCircleAlert, LuCircleCheck, LuCircleHelp, LuTriangleAlert} from "react-icons/lu";

import {cn} from "@/lib/utils";
import type {Severity} from "@/lib/telemetry";

const ICON: Record<Severity, IconType> = {
  good: LuCircleCheck,
  warning: LuTriangleAlert,
  serious: LuTriangleAlert,
  critical: LuCircleAlert,
  unknown: LuCircleHelp,
};

const TONE: Record<Severity, {text: string; border: string; bg: string; dot: string}> = {
  good: {text: "text-good", border: "border-good/25", bg: "bg-good/10", dot: "bg-good"},
  warning: {text: "text-warning", border: "border-warning/25", bg: "bg-warning/10", dot: "bg-warning"},
  serious: {text: "text-serious", border: "border-serious/25", bg: "bg-serious/10", dot: "bg-serious"},
  critical: {text: "text-critical", border: "border-critical/25", bg: "bg-critical/10", dot: "bg-critical"},
  unknown: {text: "text-ash-400", border: "border-ash-700", bg: "bg-oil-800", dot: "bg-ash-500"},
};

/**
 * A state, shown as icon + label + color — never color alone.
 *
 * Status hues are reserved (good / warning / serious / critical) and never reused as a series
 * color, so a red pill on this page always means a fault and never means "the fourth chain".
 */
export function StatusPill({
  severity,
  label,
  className,
}: {
  severity: Severity;
  label: string;
  className?: string;
}) {
  const Icon = ICON[severity];
  const tone = TONE[severity];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone.border,
        tone.bg,
        tone.text,
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

/** The compact form for a dense table cell, where a pill would be too heavy. */
export function StatusDot({severity, label}: {severity: Severity; label: string}) {
  const tone = TONE[severity];
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("size-2 shrink-0 rounded-full", tone.dot)} aria-hidden />
      <span className={cn("text-xs", severity === "unknown" ? "text-ash-500" : "text-ash-200")}>{label}</span>
    </span>
  );
}
