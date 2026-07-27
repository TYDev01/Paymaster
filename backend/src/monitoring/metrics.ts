/**
 * A minimal Prometheus metrics registry.
 *
 * Deliberately not `prom-client`: the backend exports a small, fixed set of metrics, and a
 * hand-rolled registry keeps the dependency surface of a money-spending service smaller and its
 * output format something we control exactly. It implements just what that fixed set needs —
 * labelled counters and gauges, and a fixed-bucket histogram — and renders the Prometheus text
 * exposition format.
 *
 * Label cardinality is the one hazard of a metrics system, so every metric here is labelled only by
 * bounded dimensions (chain id, rule name, outcome) — never by anything caller-controlled like an
 * address or IP, which would let a caller blow up memory by varying it.
 */

type Labels = Readonly<Record<string, string | number>>;

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const inner = entries
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
  return `{${inner}}`;
}

/** Stable key for a label set, order-independent, for the per-series map. */
function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

interface Metric {
  render(): string;
}

class Counter implements Metric {
  readonly #series = new Map<string, {labels: Labels; value: number}>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = seriesKey(labels);
    const existing = this.#series.get(key);
    if (existing === undefined) this.#series.set(key, {labels, value: amount});
    else existing.value += amount;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const {labels, value} of this.#series.values()) lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    return lines.join("\n");
  }
}

class Gauge implements Metric {
  readonly #series = new Map<string, {labels: Labels; value: number}>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number, labels: Labels = {}): void {
    this.#series.set(seriesKey(labels), {labels, value});
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const {labels, value} of this.#series.values()) lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    return lines.join("\n");
  }
}

class Histogram implements Metric {
  readonly #series = new Map<string, {labels: Labels; buckets: number[]; sum: number; count: number}>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: readonly number[],
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = seriesKey(labels);
    let series = this.#series.get(key);
    if (series === undefined) {
      series = {labels, buckets: new Array(this.bounds.length).fill(0), sum: 0, count: 0};
      this.#series.set(key, series);
    }
    series.sum += value;
    series.count += 1;
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= this.bounds[i]!) series.buckets[i]! += 1;
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.#series.values()) {
      for (let i = 0; i < this.bounds.length; i++) {
        lines.push(`${this.name}_bucket${renderLabels({...s.labels, le: this.bounds[i]!})} ${s.buckets[i]}`);
      }
      lines.push(`${this.name}_bucket${renderLabels({...s.labels, le: "+Inf"})} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  readonly #metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    return this.#track(new Counter(name, help));
  }

  gauge(name: string, help: string): Gauge {
    return this.#track(new Gauge(name, help));
  }

  histogram(name: string, help: string, bounds: readonly number[]): Histogram {
    return this.#track(new Histogram(name, help, bounds));
  }

  #track<T extends Metric>(metric: T): T {
    this.#metrics.push(metric);
    return metric;
  }

  /** The full exposition, ready to serve at /metrics. Trailing newline as Prometheus expects. */
  render(): string {
    return `${this.#metrics.map((m) => m.render()).join("\n\n")}\n`;
  }
}

export type {Counter, Gauge, Histogram};
