import {describe, expect, it} from "vitest";

import {
  currentSpanContext,
  formatTraceparent,
  isValidSpanContext,
  noopTracer,
  parseTraceparent,
  withSpan,
} from "../src/monitoring/tracing.js";
import {OtlpTracer, encodeResourceSpans, type FetchLike, type FinishedSpan} from "../src/monitoring/otlpTracer.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("W3C trace context", () => {
  it("parses a well-formed traceparent and round-trips it", () => {
    const context = parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(context).toEqual({traceId: TRACE_ID, spanId: SPAN_ID, sampled: true});
    expect(formatTraceparent(context!)).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("reads the sampled flag from the low bit only", () => {
    // Flags is a bitfield; only bit 0 is `sampled`. `02` sets a different bit and must not sample.
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled).toBe(false);
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-03`)?.sampled).toBe(true);
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-02`)?.sampled).toBe(false);
  });

  it("accepts a future version by parsing the fields it defines", () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: true,
    });
  });

  it("rejects anything malformed rather than throwing on caller-supplied input", () => {
    const rejected = [
      undefined,
      "",
      "not-a-traceparent",
      `00-${TRACE_ID}-${SPAN_ID}`, // missing flags
      `ff-${TRACE_ID}-${SPAN_ID}-01`, // version ff is reserved as invalid
      `00-${"0".repeat(32)}-${SPAN_ID}-01`, // all-zero trace id
      `00-${TRACE_ID}-${"0".repeat(16)}-01`, // all-zero span id
      `00-${TRACE_ID.slice(0, 30)}-${SPAN_ID}-01`, // short trace id
      `00-${TRACE_ID.replace("4b", "zz")}-${SPAN_ID}-01`, // non-hex
    ];
    for (const header of rejected) expect(parseTraceparent(header)).toBeUndefined();
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseTraceparent(`  00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01  `)?.traceId).toBe(TRACE_ID);
  });
});

describe("withSpan", () => {
  function tracer(): OtlpTracer {
    return new OtlpTracer(exporterOptions(), {fetch: neverCalled, random: () => 0});
  }

  it("makes the span ambient so a nested span joins the same trace", async () => {
    const t = tracer();
    let childTraceId = "";
    let childParent = "";

    await withSpan(t, "outer", {}, async (outer) => {
      await withSpan(t, "inner", {}, async (inner) => {
        childTraceId = inner.context.traceId;
        // The ambient context inside the child is the child itself, and it descends from `outer`.
        expect(currentSpanContext()?.spanId).toBe(inner.context.spanId);
        childParent = outer.context.spanId;
      });
    });

    expect(childTraceId).toHaveLength(32);
    expect(childParent).toHaveLength(16);
    expect(t.pendingSpanCount).toBe(2);
  });

  it("clears the ambient context once the span is over", async () => {
    await withSpan(tracer(), "x", {}, async () => undefined);
    expect(currentSpanContext()).toBeUndefined();
  });

  it("records a thrown error, and rethrows it", async () => {
    const {tracer: t, exported} = capturingTracer();
    await expect(
      withSpan(t, "boom", {}, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    await t.flush();
    expect(exported[0]).toMatchObject({name: "boom", status: {code: 2, message: "Error: kaboom"}});
  });

  it("leaves an expected error unmarked, so a policy denial is not an outage", async () => {
    const {tracer: t, exported} = capturingTracer();
    class Denied extends Error {}
    await expect(
      withSpan(t, "sponsor", {expected: (e) => e instanceof Denied}, async () => {
        throw new Denied("denied");
      }),
    ).rejects.toBeInstanceOf(Denied);

    await t.flush();
    expect(exported[0]!["status"]).toEqual({});
  });

  it("ends the span exactly once even when the body ends it early", async () => {
    const t = tracer();
    await withSpan(t, "double", {}, async (span) => {
      span.end();
    });
    expect(t.pendingSpanCount).toBe(1);
  });
});

describe("noopTracer", () => {
  it("returns a span that records nothing and reports an invalid context", () => {
    const span = noopTracer.startSpan("x", {kind: "server"});
    span.setAttribute("k", "v");
    span.recordError(new Error("ignored"));
    span.end();
    expect(isValidSpanContext(span.context)).toBe(false);
  });
});

describe("OtlpTracer", () => {
  it("samples by ratio at the root, and never contradicts a parent", () => {
    const t = new OtlpTracer({...exporterOptions(), sampleRatio: 0}, {fetch: neverCalled, random: () => 0.5});

    const unsampled = t.startSpan("root");
    expect(unsampled.context.sampled).toBe(false);
    // An unsampled span still carries a real context, so a downstream service joins this trace
    // rather than starting a fresh one.
    expect(isValidSpanContext(unsampled.context)).toBe(true);

    const child = t.startSpan("child", {parent: {traceId: TRACE_ID, spanId: SPAN_ID, sampled: true}});
    expect(child.context.sampled).toBe(true);
    expect(child.context.traceId).toBe(TRACE_ID);
  });

  it("records nothing for an unsampled span", () => {
    const t = new OtlpTracer({...exporterOptions(), sampleRatio: 0}, {fetch: neverCalled, random: () => 0.9});
    t.startSpan("root").end();
    expect(t.pendingSpanCount).toBe(0);
  });

  it("drops spans past the queue cap instead of growing without bound", () => {
    const t = new OtlpTracer({...exporterOptions(), maxQueueSize: 2}, {fetch: neverCalled, random: () => 0});
    for (let i = 0; i < 10; i++) t.startSpan(`s${i}`).end();
    expect(t.pendingSpanCount).toBe(2);
  });

  it("exports in batches and empties the queue", async () => {
    const bodies: unknown[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {ok: true, status: 200};
    };
    const t = new OtlpTracer({...exporterOptions(), maxBatchSize: 2}, {fetch, random: () => 0});
    for (let i = 0; i < 5; i++) t.startSpan(`s${i}`).end();

    await t.flush();

    expect(bodies).toHaveLength(3); // 2 + 2 + 1
    expect(t.pendingSpanCount).toBe(0);
  });

  it("swallows an export failure: telemetry must not break the caller", async () => {
    const t = new OtlpTracer(exporterOptions(), {
      fetch: async () => {
        throw new Error("collector down");
      },
      random: () => 0,
    });
    t.startSpan("s").end();
    await expect(t.flush()).resolves.toBeUndefined();
  });

  it("appends the OTLP traces path when the endpoint is a base URL", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return {ok: true, status: 200};
    };
    for (const endpoint of ["http://collector:4318", "http://collector:4318/", "http://collector:4318/v1/traces"]) {
      const t = new OtlpTracer({...exporterOptions(), endpoint}, {fetch, random: () => 0});
      t.startSpan("s").end();
      await t.flush();
    }
    expect(urls).toEqual([
      "http://collector:4318/v1/traces",
      "http://collector:4318/v1/traces",
      "http://collector:4318/v1/traces",
    ]);
  });
});

describe("encodeResourceSpans", () => {
  const span: FinishedSpan = {
    name: "sponsor",
    kind: "server",
    context: {traceId: TRACE_ID, spanId: SPAN_ID, sampled: true},
    parentSpanId: "b7ad6b7169203331",
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    endTimeUnixNano: 1_700_000_000_012_000_000n,
    attributes: {"paymaster.chain_id": 8453, "paymaster.outcome": "issued", "http.aborted": false, ratio: 0.5},
    errorMessage: undefined,
  };

  it("encodes ids as hex and timestamps as strings, per the OTLP JSON mapping", () => {
    const encoded = encodeResourceSpans([span], {serviceName: "paymaster", serviceVersion: "1.2.3"}) as {
      resourceSpans: {resource: {attributes: unknown[]}; scopeSpans: {spans: Record<string, unknown>[]}[]}[];
    };
    const out = encoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;

    expect(out["traceId"]).toBe(TRACE_ID);
    expect(out["spanId"]).toBe(SPAN_ID);
    expect(out["parentSpanId"]).toBe("b7ad6b7169203331");
    expect(out["startTimeUnixNano"]).toBe("1700000000000000000");
    expect(out["endTimeUnixNano"]).toBe("1700000000012000000");
    expect(out["kind"]).toBe(2); // SPAN_KIND_SERVER
    expect(encoded.resourceSpans[0]!.resource.attributes).toEqual([
      {key: "service.name", value: {stringValue: "paymaster"}},
      {key: "service.version", value: {stringValue: "1.2.3"}},
    ]);
  });

  it("types each attribute value the way the collector expects", () => {
    const encoded = encodeResourceSpans([span], {serviceName: "paymaster"}) as {
      resourceSpans: {scopeSpans: {spans: {attributes: unknown[]}[]}[]}[];
    };
    expect(encoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes).toEqual([
      {key: "paymaster.chain_id", value: {intValue: "8453"}},
      {key: "paymaster.outcome", value: {stringValue: "issued"}},
      {key: "http.aborted", value: {boolValue: false}},
      {key: "ratio", value: {doubleValue: 0.5}},
    ]);
  });

  it("marks a failed span with STATUS_CODE_ERROR and omits the parent when there is none", () => {
    const encoded = encodeResourceSpans([{...span, parentSpanId: undefined, errorMessage: "Error: rpc timeout"}], {
      serviceName: "paymaster",
    }) as {resourceSpans: {scopeSpans: {spans: Record<string, unknown>[]}[]}[]};
    const out = encoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;

    expect(out["status"]).toEqual({code: 2, message: "Error: rpc timeout"});
    expect(out).not.toHaveProperty("parentSpanId");
  });
});

function exporterOptions() {
  return {
    endpoint: "http://collector:4318",
    serviceName: "paymaster",
    sampleRatio: 1,
    maxQueueSize: 1_000,
    maxBatchSize: 100,
    flushIntervalMs: 60_000,
    timeoutMs: 1_000,
  };
}

const neverCalled: FetchLike = async () => {
  throw new Error("export should not have been attempted");
};

/**
 * A tracer whose exports are captured. `exported` is filled by `flush()`, so a test asserts on the
 * spans exactly as a collector would receive them rather than on internal state.
 */
function capturingTracer(): {tracer: OtlpTracer; exported: Record<string, unknown>[]} {
  const exported: Record<string, unknown>[] = [];
  const tracer = new OtlpTracer(exporterOptions(), {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body) as {
        resourceSpans: {scopeSpans: {spans: Record<string, unknown>[]}[]}[];
      };
      exported.push(...body.resourceSpans[0]!.scopeSpans[0]!.spans);
      return {ok: true, status: 200};
    },
    random: () => 0,
  });
  return {tracer, exported};
}
