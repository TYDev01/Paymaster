import {Logger} from "@nestjs/common";

import type {BackgroundService} from "./backgroundService.js";
import {IntervalLoop} from "./intervalLoop.js";
import {
  SPAN_KIND_CODE,
  newSpanId,
  newTraceId,
  type AttributeValue,
  type Attributes,
  type Span,
  type SpanContext,
  type SpanKind,
  type StartSpanOptions,
  type Tracer,
} from "./tracing.js";

/**
 * A `Tracer` that batches finished spans and ships them as OTLP/HTTP JSON.
 *
 * OTLP over HTTP with a JSON body is a documented, stable wire format that every collector accepts
 * on `/v1/traces`. Producing it directly — rather than through the OTel SDK — costs this file and
 * buys a tracing path with no new dependencies, no load-time patching of `http`/`pg`/`dns`, and an
 * exporter whose failure modes are visible in one screen. See `tracing.ts` for the fuller rationale.
 *
 * Three properties are what make it safe to leave on in production:
 *
 *   * **Bounded memory.** The queue has a hard cap. Past it, spans are DROPPED and counted, never
 *     buffered without limit — an unreachable collector must not turn into an OOM in a service whose
 *     job is to keep sponsoring.
 *   * **Bounded blocking.** Nothing on the request path waits for an export. `end()` enqueues; a
 *     timer flushes. Every HTTP attempt carries a timeout.
 *   * **Head sampling, inherited.** The decision is taken once at the root of a trace and carried
 *     down (and across `traceparent`), so a sampled trace is complete rather than a scatter of
 *     unconnected spans.
 */
export interface OtlpTracerOptions {
  /** Collector base URL, e.g. `http://otel-collector:4318`. `/v1/traces` is appended if absent. */
  readonly endpoint: string;
  readonly serviceName: string;
  readonly serviceVersion?: string | undefined;
  /** Extra headers, e.g. an API token for a hosted backend. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Head-sampling probability in [0, 1]. 1 records every trace. */
  readonly sampleRatio: number;
  /** Hard cap on queued spans. Spans arriving at a full queue are dropped and counted. */
  readonly maxQueueSize: number;
  /** Spans per export request. */
  readonly maxBatchSize: number;
  readonly flushIntervalMs: number;
  readonly timeoutMs: number;
}

export type FetchLike = (
  url: string,
  init: {method: string; headers: Record<string, string>; body: string; signal: AbortSignal},
) => Promise<{ok: boolean; status: number}>;

/** A span that has ended, in the shape the encoder needs. Exported so the encoder can be unit-tested. */
export interface FinishedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly attributes: Record<string, AttributeValue>;
  readonly errorMessage: string | undefined;
}

/** A span still open: the mutable half of `FinishedSpan`. */
interface OpenSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  readonly startTimeUnixNano: bigint;
  readonly attributes: Record<string, AttributeValue>;
}

export class OtlpTracer implements Tracer, BackgroundService {
  readonly name = "otlp-tracer";

  readonly #options: OtlpTracerOptions;
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #nowNs: () => bigint;
  readonly #random: () => number;
  readonly #logger = new Logger("tracing");
  readonly #loop: IntervalLoop;

  #queue: FinishedSpan[] = [];
  #dropped = 0;
  #flushing = false;

  constructor(options: OtlpTracerOptions, deps: {fetch?: FetchLike; nowNs?: () => bigint; random?: () => number} = {}) {
    this.#options = options;
    this.#url = tracesUrl(options.endpoint);
    this.#fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.#nowNs = deps.nowNs ?? defaultNowNs;
    this.#random = deps.random ?? Math.random;
    this.#loop = new IntervalLoop("tracing", options.flushIntervalMs, () => this.flush());
  }

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    const parent = options.parent;
    // A child always inherits its parent's decision; only a root rolls the dice. That is what keeps
    // a sampled trace whole.
    const sampled = parent === undefined ? this.#random() < this.#options.sampleRatio : parent.sampled;
    const context: SpanContext = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      sampled,
    };

    // An unsampled span still carries a real, propagatable context — it just records nothing. This
    // is what lets a downstream service join the same (unsampled) trace instead of starting a new one.
    if (!sampled) return new UnrecordedSpan(context);

    return new RecordingSpan(
      {
        name,
        kind: options.kind ?? "internal",
        context,
        parentSpanId: parent?.spanId,
        startTimeUnixNano: this.#nowNs(),
        attributes: {...options.attributes},
      },
      (span) => this.#enqueue(span),
      this.#nowNs,
    );
  }

  start(): Promise<void> {
    return this.#loop.start();
  }

  async stop(): Promise<void> {
    this.#loop.stop();
    // A shutting-down pod holds the only copy of its last spans; drain before the process exits.
    await this.flush();
  }

  /** Exports everything queued, in batches. Never throws — a failed export is logged and dropped. */
  async flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      while (this.#queue.length > 0) {
        const batch = this.#queue.splice(0, this.#options.maxBatchSize);
        await this.#export(batch);
      }
      if (this.#dropped > 0) {
        this.#logger.warn(`dropped ${this.#dropped} span(s): export queue full (max ${this.#options.maxQueueSize})`);
        this.#dropped = 0;
      }
    } finally {
      this.#flushing = false;
    }
  }

  /** Queued but not yet exported. Exposed for tests. */
  get pendingSpanCount(): number {
    return this.#queue.length;
  }

  #enqueue(span: FinishedSpan): void {
    if (this.#queue.length >= this.#options.maxQueueSize) {
      this.#dropped += 1;
      return;
    }
    this.#queue.push(span);
  }

  async #export(batch: readonly FinishedSpan[]): Promise<void> {
    const body = JSON.stringify(encodeResourceSpans(batch, this.#options));
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {"content-type": "application/json", ...this.#options.headers},
        body,
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
      // Not retried: spans are diagnostics, and a retry queue in front of an unhealthy collector is
      // memory pressure on the service, traded for telemetry nobody is reading yet.
      if (!response.ok) this.#logger.warn(`span export rejected: HTTP ${response.status}`);
    } catch (error) {
      this.#logger.warn(`span export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A sampled span. Mutable while open; hands an immutable record to the exporter on `end()`. */
class RecordingSpan implements Span {
  readonly #record: OpenSpan;
  readonly #onEnd: (span: FinishedSpan) => void;
  readonly #nowNs: () => bigint;
  #errorMessage: string | undefined;
  #ended = false;

  constructor(record: OpenSpan, onEnd: (span: FinishedSpan) => void, nowNs: () => bigint) {
    this.#record = record;
    this.#onEnd = onEnd;
    this.#nowNs = nowNs;
  }

  get context(): SpanContext {
    return this.#record.context;
  }

  setAttribute(key: string, value: AttributeValue): void {
    if (!this.#ended) this.#record.attributes[key] = value;
  }

  recordError(error: unknown): void {
    if (this.#ended) return;
    this.#errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  end(): void {
    // Idempotent: `withSpan` ends in a finally, and defensive call sites sometimes end early. A
    // double end would export the same span twice and corrupt the trace.
    if (this.#ended) return;
    this.#ended = true;
    this.#onEnd({
      name: this.#record.name,
      kind: this.#record.kind,
      context: this.#record.context,
      parentSpanId: this.#record.parentSpanId,
      startTimeUnixNano: this.#record.startTimeUnixNano,
      endTimeUnixNano: this.#nowNs(),
      attributes: this.#record.attributes,
      errorMessage: this.#errorMessage,
    });
  }
}

/** An unsampled span: propagates a context, records nothing, allocates nothing further. */
class UnrecordedSpan implements Span {
  constructor(readonly context: SpanContext) {}
  setAttribute(): void {}
  recordError(): void {}
  end(): void {}
}

/**
 * Builds the OTLP `ExportTraceServiceRequest` JSON body.
 *
 * Pure, and exported, because this is the part that must match a specification rather than a
 * behaviour — a unit test comparing against the documented encoding is worth more than any amount
 * of integration wiring. Note the OTLP JSON deviations from stock protobuf-JSON that trip people up:
 * `traceId`/`spanId` are HEX strings (not base64), and the 64-bit nanosecond timestamps are STRINGS.
 */
export function encodeResourceSpans(
  spans: readonly FinishedSpan[],
  resource: {serviceName: string; serviceVersion?: string | undefined},
): unknown {
  const resourceAttributes: Attributes = {
    "service.name": resource.serviceName,
    ...(resource.serviceVersion === undefined ? {} : {"service.version": resource.serviceVersion}),
  };

  return {
    resourceSpans: [
      {
        resource: {attributes: encodeAttributes(resourceAttributes)},
        scopeSpans: [
          {
            scope: {name: "paymaster"},
            spans: spans.map((span) => ({
              traceId: span.context.traceId,
              spanId: span.context.spanId,
              ...(span.parentSpanId === undefined ? {} : {parentSpanId: span.parentSpanId}),
              name: span.name,
              kind: SPAN_KIND_CODE[span.kind],
              startTimeUnixNano: span.startTimeUnixNano.toString(),
              endTimeUnixNano: span.endTimeUnixNano.toString(),
              attributes: encodeAttributes(span.attributes),
              // STATUS_CODE_ERROR = 2, STATUS_CODE_UNSET = 0. Never OK(1): the spec reserves that
              // for an explicit assertion of success, which an unremarkable span is not making.
              status: span.errorMessage === undefined ? {} : {code: 2, message: span.errorMessage},
            })),
          },
        ],
      },
    ],
  };
}

function encodeAttributes(attributes: Attributes): unknown[] {
  return Object.entries(attributes).map(([key, value]) => ({key, value: encodeAttributeValue(value)}));
}

function encodeAttributeValue(value: AttributeValue): unknown {
  if (typeof value === "string") return {stringValue: value};
  if (typeof value === "boolean") return {boolValue: value};
  // OTLP carries integers as 64-bit, which JSON encodes as a string; only non-integers are doubles.
  return Number.isInteger(value) ? {intValue: String(value)} : {doubleValue: value};
}

function tracesUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

/**
 * Wall-clock nanoseconds.
 *
 * `Date.now()` is milliseconds, which would collapse the sub-millisecond spans this service mostly
 * produces into zero-duration. Anchoring the monotonic clock to one wall-clock reading gives real
 * nanosecond deltas on an absolute timeline — and, unlike repeated `Date.now()` calls, cannot go
 * backwards mid-span when NTP steps the clock.
 */
const TIME_ORIGIN_NS = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

function defaultNowNs(): bigint {
  return TIME_ORIGIN_NS + process.hrtime.bigint();
}
