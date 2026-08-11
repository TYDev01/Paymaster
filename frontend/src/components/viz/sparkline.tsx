"use client";

import {VIZ} from "./theme";

/**
 * Direction, not values.
 *
 * A sparkline deliberately carries no axes, no gridlines and no labels: it answers "which way is
 * this going" beside a number that answers "where is it now". Adding scale furniture would invite
 * reading values off it, which at this size would be reading noise.
 *
 * Non-finite points (a counter reset) break the path rather than being interpolated across, for the
 * same reason the full charts do it: a straight line across an unobserved gap is a claim.
 */
export function Sparkline({
  values,
  color = VIZ.axisText,
  height = 28,
}: {
  values: readonly number[];
  color?: string;
  height?: number;
}) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return null;

  const max = Math.max(...finite);
  const min = Math.min(...finite, 0);
  const span = max - min || 1;
  const width = 100;
  const step = width / (values.length - 1);

  // Split into runs of finite points so a reset shows as a break in the line.
  const runs: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      if (current.length > 1) runs.push(current.join(" "));
      current = [];
      return;
    }
    const x = index * step;
    const y = height - ((value - min) / span) * (height - 4) - 2;
    current.push(`${current.length === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
  });
  if (current.length > 1) runs.push(current.join(" "));
  if (runs.length === 0) return null;

  const lastFiniteIndex = values.findLastIndex((value) => Number.isFinite(value));
  const lastX = lastFiniteIndex * step;
  const lastY = height - ((values[lastFiniteIndex]! - min) / span) * (height - 4) - 2;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-7 w-full"
      role="img"
      aria-label={`Trend, most recent value ${values[lastFiniteIndex]}`}
    >
      {runs.map((path, index) => (
        <path
          key={index}
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={VIZ.lineWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {/* The end point, ringed in the surface color so it stays legible over the line. */}
      <circle cx={lastX} cy={lastY} r={2.5} fill={color} stroke={VIZ.surface} strokeWidth={VIZ.ringWidth} />
    </svg>
  );
}
