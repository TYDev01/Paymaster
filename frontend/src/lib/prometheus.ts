/**
 * A parser for the Prometheus text exposition format.
 *
 * The backend serves `/metrics` in that format and nothing else — there is no JSON metrics API, and
 * adding one to a service that spends money, purely so a dashboard has a friendlier shape, would be
 * a second surface to keep correct. Parsing the documented format here is the smaller change.
 *
 * It handles exactly what the backend emits (counters, gauges, and fixed-bucket histograms with
 * `_bucket`/`_sum`/`_count`), which is a deliberate subset: no exemplars, no native histograms, no
 * `_created` series. Anything unrecognised is skipped rather than guessed at, so a future metric
 * cannot silently be read as the wrong shape.
 */
export type MetricType = "counter" | "gauge" | "histogram" | "summary" | "untyped";

export interface Sample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface MetricFamily {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly samples: readonly Sample[];
}

export interface MetricsSnapshot {
  /** Epoch milliseconds at which the scrape was taken, from the reader's clock. */
  readonly scrapedAt: number;
  readonly families: Readonly<Record<string, MetricFamily>>;
}

/** `name{a="1",b="2"} 3` — the label section is optional and may contain escaped quotes. */
const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(.+)$/;

export function parsePrometheusText(text: string, scrapedAt = Date.now()): MetricsSnapshot {
  const families = new Map<string, {name: string; type: MetricType; help: string; samples: Sample[]}>();

  const family = (name: string) => {
    let existing = families.get(name);
    if (existing === undefined) {
      existing = {name, type: "untyped", help: "", samples: []};
      families.set(name, existing);
    }
    return existing;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (line.startsWith("#")) {
      const help = /^#\s+HELP\s+(\S+)\s+(.*)$/.exec(line);
      if (help !== null) {
        family(help[1]!).help = help[2]!;
        continue;
      }
      const type = /^#\s+TYPE\s+(\S+)\s+(\S+)$/.exec(line);
      if (type !== null) family(type[1]!).type = type[2]! as MetricType;
      continue;
    }

    const match = SAMPLE_LINE.exec(line);
    if (match === null) continue;

    const [, name, , labelSection, rawValue] = match;
    const value = parseSampleValue(rawValue!);
    if (value === undefined) continue;

    // Histogram series carry a suffix; they belong to the family that declared the TYPE.
    const base = name!.replace(/_(bucket|sum|count)$/, "");
    const owner = families.has(base) && families.get(base)!.type === "histogram" ? base : name!;

    family(owner).samples.push({name: name!, labels: parseLabels(labelSection), value});
  }

  return {
    scrapedAt,
    families: Object.fromEntries([...families].map(([name, f]) => [name, {...f, samples: f.samples}])),
  };
}

/** Prometheus permits `+Inf`, `-Inf` and `NaN` as values; a bare number otherwise. */
function parseSampleValue(raw: string): number | undefined {
  const token = raw.trim().split(/\s+/)[0] ?? "";
  if (token === "+Inf") return Number.POSITIVE_INFINITY;
  if (token === "-Inf") return Number.NEGATIVE_INFINITY;
  if (token === "NaN") return Number.NaN;
  const value = Number(token);
  return Number.isNaN(value) && token !== "NaN" ? undefined : value;
}

function parseLabels(section: string | undefined): Record<string, string> {
  if (section === undefined || section === "") return {};
  const labels: Record<string, string> = {};
  // Values may contain commas and escaped quotes, so this walks pairs rather than splitting on ",".
  const pair = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pair.exec(section)) !== null) {
    labels[match[1]!] = match[2]!.replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c));
  }
  return labels;
}

// ------------------------------------------------------------------------------------------------
// Reading a snapshot
// ------------------------------------------------------------------------------------------------

export function samplesOf(snapshot: MetricsSnapshot, name: string): readonly Sample[] {
  return snapshot.families[name]?.samples ?? [];
}

/** Sums a family, optionally filtered by labels. Returns 0 when the family is absent. */
export function sumOf(
  snapshot: MetricsSnapshot,
  name: string,
  match: Readonly<Record<string, string>> = {},
): number {
  return samplesOf(snapshot, name)
    .filter((s) => matches(s, match))
    .reduce((total, s) => total + s.value, 0);
}

/** The single value of a family filtered to one series, or undefined when it is not present. */
export function valueOf(
  snapshot: MetricsSnapshot,
  name: string,
  match: Readonly<Record<string, string>> = {},
): number | undefined {
  return samplesOf(snapshot, name).find((s) => matches(s, match))?.value;
}

/** Groups a family's samples by one label, summing within each group. */
export function sumByLabel(
  snapshot: MetricsSnapshot,
  name: string,
  label: string,
  match: Readonly<Record<string, string>> = {},
): {key: string; value: number}[] {
  const totals = new Map<string, number>();
  for (const sample of samplesOf(snapshot, name)) {
    if (!matches(sample, match)) continue;
    const key = sample.labels[label];
    if (key === undefined) continue;
    totals.set(key, (totals.get(key) ?? 0) + sample.value);
  }
  return [...totals].map(([key, value]) => ({key, value})).sort((a, b) => b.value - a.value);
}

/** Distinct values of a label across a family, sorted naturally so chain ids read in order. */
export function labelValues(snapshot: MetricsSnapshot, name: string, label: string): string[] {
  const seen = new Set<string>();
  for (const sample of samplesOf(snapshot, name)) {
    const value = sample.labels[label];
    if (value !== undefined) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
}

function matches(sample: Sample, match: Readonly<Record<string, string>>): boolean {
  return Object.entries(match).every(([key, value]) => sample.labels[key] === value);
}

/**
 * Interpolates a quantile from a cumulative histogram — the same maths `histogram_quantile` does.
 *
 * Worth knowing what this can and cannot tell you: the answer is only as precise as the bucket
 * boundaries, so a p99 that lands in the widest bucket is reported at that bucket's edge, not at
 * the true value. It returns undefined rather than a number when there are no observations, because
 * "no data" and "zero latency" are different answers and a dashboard must not conflate them.
 */
export function histogramQuantile(
  snapshot: MetricsSnapshot,
  name: string,
  quantile: number,
): number | undefined {
  const buckets = samplesOf(snapshot, name)
    .filter((s) => s.name.endsWith("_bucket"))
    .map((s) => ({le: Number(s.labels["le"] === "+Inf" ? Number.POSITIVE_INFINITY : s.labels["le"]), count: s.value}))
    .sort((a, b) => a.le - b.le);

  if (buckets.length === 0) return undefined;
  const total = buckets[buckets.length - 1]!.count;
  if (total === 0) return undefined;

  const target = quantile * total;
  let previousLe = 0;
  let previousCount = 0;

  for (const bucket of buckets) {
    if (bucket.count >= target) {
      if (!Number.isFinite(bucket.le)) return previousLe;
      const span = bucket.count - previousCount;
      if (span <= 0) return bucket.le;
      // Linear interpolation within the bucket, which is what Prometheus assumes.
      return previousLe + ((target - previousCount) / span) * (bucket.le - previousLe);
    }
    previousLe = bucket.le;
    previousCount = bucket.count;
  }
  return buckets[buckets.length - 1]!.le;
}
