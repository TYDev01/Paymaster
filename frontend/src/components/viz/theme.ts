/**
 * Chart parameters, in one place.
 *
 * The series hexes are the validated categorical steps for a dark surface, checked against THIS
 * app's chart surface (#0d1010) with the palette validator: lightness band, chroma floor, CVD
 * separation, normal-vision floor and 3:1 contrast all pass.
 *
 * Two rules these encode, both of which are safety rather than taste:
 *
 *   * **Assign slots in fixed order and never cycle.** A ninth series does not get a generated
 *     hue; it folds into "Other". Cycling produces two identical colors in one chart.
 *   * **Color follows the entity, not its rank.** `SERIES_BY_OUTCOME` binds a color to a meaning,
 *     so filtering a series out never repaints the survivors — "denied" is the same color whether
 *     or not "error" is on screen.
 *
 * Status colors are reserved and never used as a series color, so a red mark always means a fault.
 */
export const SERIES = [
  "#3987e5", // 1 blue
  "#d95926", // 2 orange
  "#199e70", // 3 aqua
  "#c98500", // 4 yellow
  "#d55181", // 5 magenta
  "#008300", // 6 green
  "#9085e9", // 7 violet
  "#e66767", // 8 red
] as const;

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export const VIZ = {
  surface: "#0d1010",
  grid: "#1c2321",
  axis: "#4a5350",
  axisText: "#848d8a",
  /** 2px line, round caps — thin marks, per the mark spec. */
  lineWidth: 2,
  /** Area fills are a wash at ~10%, never a saturated block. */
  areaOpacity: 0.1,
  /** Dots ≥ 8px so they are hoverable, with a 2px surface ring where they overlap. */
  dotRadius: 4,
  ringWidth: 2,
  barRadius: 4,
  maxBarThickness: 24,
} as const;

/**
 * Outcome → color, bound to the MEANING rather than to a position in a list.
 *
 * "denied" gets a neutral-ish slot on purpose: a denial is the policy engine working, not a fault,
 * and painting it in the status red would make correct behaviour read as an incident on every
 * dashboard it appears on.
 */
export const SERIES_BY_OUTCOME: Record<string, string> = {
  issued: SERIES[2], // aqua — the good path
  denied: SERIES[3], // yellow — a decision, not a failure
  error: STATUS.critical, // the only genuine fault of the three
};

/** Deterministic slot for an arbitrary key (a rule name, a chain id), stable across renders. */
export function seriesColor(index: number): string {
  return SERIES[index % SERIES.length]!;
}
