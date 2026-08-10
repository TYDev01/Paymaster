import {AsyncLocalStorage} from "node:async_hooks";
import {randomBytes} from "node:crypto";

/**
 * Distributed tracing, as a port — plus W3C trace-context plumbing.
 *
 * td.md asks for OpenTelemetry tracing. What that means in practice is two things: spans that carry
 * a W3C `traceparent` so this service's work joins the caller's trace, and an OTLP exporter that
 * ships them. Both are implemented here and in `otlpTracer.ts` rather than pulled in from the OTel
 * SDK, for the same reason the Prometheus registry is hand-rolled: this is a service that spends
 * money, its dependency surface is a security property, and the OTel Node SDK is a large tree that
 * monkey-patches core modules at load time. The wire format (OTLP/HTTP JSON) and the propagation
 * header (W3C trace-context) are the parts that must be standard, and they are — any OTel Collector,
 * Tempo, Jaeger or Honeycomb endpoint accepts what this produces.
 *
 * The domain never sees this file's implementation, only `Tracer`/`Span`. Tracing disabled is
 * `noopTracer`, whose spans allocate nothing and do nothing, so instrumented code paths pay
 * essentially nothing when tracing is off.
 */
export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

/** OTLP span kind codes. Only the three this service produces are named. */
export const SPAN_KIND_CODE = {internal: 1, server: 2, client: 3} as const;
export type SpanKind = keyof typeof SPAN_KIND_CODE;

export interface SpanContext {
  /** 32 lowercase hex characters. */
  readonly traceId: string;
  /** 16 lowercase hex characters. */
  readonly spanId: string;
  /**
   * Head sampling decision, taken at the root and inherited by every descendant — including across
   * the propagation header, so a trace is never half-recorded.
   */
  readonly sampled: boolean;
}

export interface Span {
  readonly context: SpanContext;
  setAttribute(key: string, value: AttributeValue): void;
  /** Marks the span failed and records the message. */
  recordError(error: unknown): void;
  end(): void;
}

export interface StartSpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
  /** Explicit parent. When omitted the ambient context (see `withSpan`) is used. */
  readonly parent?: SpanContext | undefined;
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span;
}

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

/** The context every no-op span reports: valid in shape, invalid per the spec, never propagated. */
export const INVALID_SPAN_CONTEXT: SpanContext = {
  traceId: INVALID_TRACE_ID,
  spanId: INVALID_SPAN_ID,
  sampled: false,
};

const NOOP_SPAN: Span = {
  context: INVALID_SPAN_CONTEXT,
  setAttribute: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

/** The tracer used when tracing is disabled. Shared and immutable — it holds no state. */
export const noopTracer: Tracer = {startSpan: () => NOOP_SPAN};

export function isValidSpanContext(context: SpanContext): boolean {
  return context.traceId !== INVALID_TRACE_ID && context.spanId !== INVALID_SPAN_ID;
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Ambient span context.
 *
 * Tracing's ergonomics depend on a child span finding its parent without every function in between
 * taking a context parameter. Node's `AsyncLocalStorage` provides exactly that, in core, with no
 * dependency and no monkey-patching — which is why the OTel SDK is not needed for this either.
 */
const ambient = new AsyncLocalStorage<SpanContext>();

export function currentSpanContext(): SpanContext | undefined {
  return ambient.getStore();
}

/**
 * Makes `context` ambient for the remainder of the current async execution.
 *
 * Used by the HTTP hook, where there is no callback to wrap: Fastify's `onRequest` runs inside the
 * request's async resource, so entering here covers the handler and everything it awaits. Prefer
 * `withSpan` anywhere a callback exists — it has a defined exit, this does not.
 */
export function enterSpanContext(context: SpanContext): void {
  ambient.enterWith(context);
}

export interface WithSpanOptions extends StartSpanOptions {
  /**
   * Errors this accepts are rethrown but do NOT mark the span failed.
   *
   * Some throws are the service working: a policy denial is a decision, not a fault. Without this
   * distinction every rejected sponsorship would show up as an error in the tracing backend, and an
   * error rate that is mostly correct behaviour is an error rate nobody can alert on.
   */
  readonly expected?: (error: unknown) => boolean;
}

/**
 * Runs `fn` inside a new span, with that span ambient for anything it calls.
 *
 * Ends the span exactly once whatever happens, and records a thrown error before rethrowing it —
 * so an instrumented call site cannot leak a span or silently lose a failure, which are the two
 * bugs hand-written instrumentation reliably produces.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  options: WithSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, {...options, parent: options.parent ?? currentSpanContext()});
  try {
    return await ambient.run(span.context, () => fn(span));
  } catch (error) {
    if (options.expected?.(error) !== true) span.recordError(error);
    throw error;
  } finally {
    span.end();
  }
}

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Parses a W3C `traceparent`.
 *
 * Returns undefined for anything malformed or all-zero rather than throwing: an untrusted header
 * from an arbitrary client must never be able to fail a request. A rejected header simply means
 * this service starts a new trace.
 *
 * Versions above `00` are accepted for their first four fields, as the spec requires, so a future
 * version's extra fields do not break propagation.
 */
export function parseTraceparent(header: string | undefined): SpanContext | undefined {
  if (header === undefined) return undefined;
  const value = header.trim().toLowerCase();
  // A version above `00` may append `-<field>` after the first four; the spec says parse the prefix.
  const candidate = value.length > 55 && value[55] === "-" && !value.startsWith("00-") ? value.slice(0, 55) : value;
  const match = TRACEPARENT_PATTERN.exec(candidate);
  if (match === null) return undefined;

  const [version, traceId, spanId, flags] = [match[1]!, match[2]!, match[3]!, match[4]!];
  if (version === "ff") return undefined; // Reserved as invalid by the spec.
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return undefined;

  return {traceId, spanId, sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01};
}

export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}
