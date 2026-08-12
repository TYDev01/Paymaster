"use client";

import {Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis} from "recharts";

import {SERIES_BY_OUTCOME, VIZ} from "./theme";
import {EmptyState} from "./panel";
import {formatRate} from "@/lib/format";

export interface RateSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

/**
 * Rates over time, stacked.
 *
 * Stacked rather than overlaid because the sum is meaningful here: issued + denied + error is the
 * total request rate, so the silhouette answers "how busy are we" while the bands answer "doing
 * what". Overlaid lines would answer only the second question and make the first a mental addition.
 *
 * A 2px surface-colored gap separates the bands, which is what makes adjacent fills read as
 * distinct without drawing a border around either — a stroke would add ink that is not data.
 *
 * Gaps in the data are real and stay visible: a counter that reset (a backend restart) produces
 * NaN, `connectNulls` is off, and the line breaks rather than drawing a straight segment across a
 * period nobody observed.
 */
export function RateChart({
  data,
  series,
  unit = "/s",
  height = 240,
  emptyTitle = "Waiting for the second sample",
  emptyDetail,
}: {
  data: readonly Record<string, number>[];
  series: readonly RateSeries[];
  unit?: string;
  height?: number;
  emptyTitle?: string;
  emptyDetail?: string;
}) {
  if (data.length === 0) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  }

  /**
   * Which series actually have height in this window.
   *
   * In a stack, a series that is zero everywhere still traces a line — along the top edge of the
   * band below it, drawn afterwards and therefore painted OVER it. That made "error: 0" appear as a
   * red line at the denied band's height: the chart showed an error rate of ~4/s while the error
   * count was zero. A zero-height band gets no stroke and no fill, so it cannot impersonate the
   * series beneath it. It stays in the legend, and the tooltip still reports its zero, so nothing
   * is hidden — only the misleading mark is.
   */
  const hasHeight = new Set(
    series
      .filter((s) => data.some((point) => Number.isFinite(point[s.key]) && (point[s.key] ?? 0) > 0))
      .map((s) => s.key),
  );

  return (
    <div>
      {/* A legend is always present for two or more series: identity must never rest on color
          alone. One series needs none — the panel title already names what is plotted. */}
      {series.length > 1 ? (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                className="size-2 rounded-[2px]"
                style={{backgroundColor: s.color, opacity: hasHeight.has(s.key) ? 1 : 0.35}}
                aria-hidden
              />
              <span className={hasHeight.has(s.key) ? "text-xs text-ash-400" : "text-xs text-ash-600"}>
                {s.label}
                {hasHeight.has(s.key) ? "" : " · none"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div style={{height}}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data as Record<string, number>[]} margin={{top: 4, right: 8, bottom: 0, left: -8}}>
          <defs>
            {series.map((s) => (
              // A wash, not a block: ~10% at the top fading out, so overlapping context stays
              // readable through it.
              <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>

          <CartesianGrid stroke={VIZ.grid} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="at"
            tickFormatter={(value: number) =>
              new Date(value).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"})
            }
            stroke={VIZ.axis}
            tick={{fill: VIZ.axisText, fontSize: 11}}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={[0, (max: number) => (max <= 0 ? 1 : max * 1.1)]}
            allowDecimals
            stroke={VIZ.axis}
            tick={{fill: VIZ.axisText, fontSize: 11}}
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={(value: number) => formatRate(value, "")}
          />
          <Tooltip
            cursor={{stroke: VIZ.axis, strokeWidth: 1}}
            content={({active, payload, label}) => {
              if (active !== true || payload === undefined || payload.length === 0) return null;
              return (
                <div className="rounded-md border border-ash-800 bg-oil-800 px-3 py-2 text-xs shadow-lg">
                  <div className="mb-1.5 text-[11px] text-ash-500">
                    {new Date(label as number).toLocaleTimeString()}
                  </div>
                  <ul className="space-y-1">
                    {payload.map((entry) => (
                      <li key={String(entry.dataKey)} className="flex items-center gap-2">
                        <span
                          className="size-2 shrink-0 rounded-[2px]"
                          style={{backgroundColor: entry.color}}
                          aria-hidden
                        />
                        <span className="text-ash-400">
                          {series.find((s) => s.key === entry.dataKey)?.label ?? String(entry.dataKey)}
                        </span>
                        <span className="tnum ml-auto font-medium text-ash-100">
                          {formatRate(entry.value as number, unit)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            }}
          />
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stackId="rate"
              stroke={hasHeight.has(s.key) ? s.color : "none"}
              strokeWidth={hasHeight.has(s.key) ? VIZ.lineWidth : 0}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={hasHeight.has(s.key) ? `url(#fill-${s.key})` : "none"}
              // The 2px surface gap between stacked bands.
              activeDot={{r: VIZ.dotRadius, stroke: VIZ.surface, strokeWidth: VIZ.ringWidth}}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}

export const OUTCOME_SERIES: readonly RateSeries[] = [
  {key: "issued", label: "Issued", color: SERIES_BY_OUTCOME["issued"]!},
  {key: "denied", label: "Denied", color: SERIES_BY_OUTCOME["denied"]!},
  {key: "error", label: "Error", color: SERIES_BY_OUTCOME["error"]!},
];
