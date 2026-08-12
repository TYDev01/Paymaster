"use client";

import {motion} from "motion/react";

import {EmptyState} from "./panel";
import {formatCount} from "@/lib/format";
import {seriesColor} from "./theme";

export interface BreakdownItem {
  readonly key: string;
  readonly value: number;
  readonly hint?: string;
}

/**
 * Magnitude by category, as horizontal bars.
 *
 * Horizontal rather than vertical because the categories are text of unpredictable length — policy
 * rule names — and horizontal bars give the label a full line instead of forcing a rotated axis.
 * Sorted by value, so the answer to "which rule is denying most" is the top row rather than a scan.
 *
 * Bars are hand-rolled rather than charted: one rect and one label per row is less machinery than a
 * chart library needs, and it makes the mark spec (≤24px thick, 4px rounded data-end, square at the
 * baseline) exact rather than approximate.
 *
 * Values are labelled at the tip, so the reader never has to measure a bar against an axis — and
 * because every value is labelled, there is no gridline to add.
 */
export function BreakdownBars({
  items,
  total,
  emptyTitle = "Nothing recorded yet",
  emptyDetail,
  colorFor,
  max = 6,
}: {
  items: readonly BreakdownItem[];
  total?: number;
  emptyTitle?: string;
  emptyDetail?: string;
  colorFor?: (item: BreakdownItem, index: number) => string;
  max?: number;
}) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  }

  // Past the cap, the tail folds into one row rather than generating more colors — a chart with
  // nine hues is a chart nobody can read, and the tail's identity is not what the reader is after.
  const shown = items.slice(0, max);
  const rest = items.slice(max);
  const restTotal = rest.reduce((sum, item) => sum + item.value, 0);
  const rows = restTotal > 0 ? [...shown, {key: `Other (${rest.length})`, value: restTotal}] : shown;

  const peak = Math.max(...rows.map((row) => row.value), 1);
  const sum = total ?? rows.reduce((acc, row) => acc + row.value, 0);

  return (
    <ul className="space-y-2.5">
      {rows.map((row, index) => {
        const share = sum === 0 ? 0 : row.value / sum;
        const width = `${Math.max((row.value / peak) * 100, 1.5)}%`;
        const isOther = row.key.startsWith("Other (");
        const color = isOther ? "#4a5350" : (colorFor?.(row, index) ?? seriesColor(index));

        return (
          <li key={row.key}>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="truncate font-mono text-[11px] text-ash-300" title={row.key}>
                {row.key}
              </span>
              <span className="tnum ml-auto shrink-0 text-xs font-medium text-ash-100">
                {formatCount(row.value)}
              </span>
              <span className="tnum w-11 shrink-0 text-right text-[11px] text-ash-600">
                {(share * 100).toFixed(0)}%
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-[2px] bg-oil-800">
              <motion.div
                className="h-full rounded-r-[4px]"
                style={{backgroundColor: color}}
                initial={{width: 0}}
                animate={{width}}
                transition={{duration: 0.45, ease: [0.22, 0.61, 0.36, 1]}}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
