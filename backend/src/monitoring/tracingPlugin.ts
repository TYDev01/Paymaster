import type {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";

import {enterSpanContext, formatTraceparent, parseTraceparent, type Span, type Tracer} from "./tracing.js";

/**
 * Registers HTTP server spans as Fastify hooks.
 *
 * One span per request, started before anything else runs and ended when the response is sent, with
 * the incoming `traceparent` as its parent — so a trace that began in the caller's wallet SDK
 * continues here rather than restarting. The span is made ambient (`enterSpanContext`) in the same
 * hook, which is what lets the sponsorship span deep inside the service find its parent without any
 * intermediate function carrying a context argument.
 *
 * Registered as a Fastify hook rather than a Nest interceptor for the same reason the security
 * layer is: hooks bracket the ENTIRE request, including the pre-auth throttle and body parsing, so
 * a request rejected at the edge still produces a span. An interceptor would only see what reached
 * a route handler, which excludes exactly the requests worth investigating.
 *
 * The route TEMPLATE (`/sponsor/:id`) is used as the span name where Fastify knows it, never the
 * raw URL: a span name is a low-cardinality dimension in every tracing backend, and raw URLs are
 * caller-controlled. `/health` and `/metrics` are skipped — a scraper hitting /metrics every 15s
 * would otherwise be the overwhelming majority of the trace volume.
 */
const SKIP_PREFIXES = ["/health", "/metrics"];

interface TracedRequest extends FastifyRequest {
  paymasterSpan?: Span;
}

export function registerTracing(fastify: FastifyInstance, tracer: Tracer): void {
  fastify.addHook("onRequest", async (request: TracedRequest, reply: FastifyReply) => {
    if (shouldSkip(request.url)) return;

    const parent = parseTraceparent(headerValue(request, "traceparent"));
    const span = tracer.startSpan(`${request.method} ${routeOf(request)}`, {
      kind: "server",
      parent,
      attributes: {
        "http.request.method": request.method,
        "url.path": pathOf(request.url),
        "network.peer.address": request.ip,
      },
    });

    request.paymasterSpan = span;
    enterSpanContext(span.context);
    // Returned so a caller (or a sidecar proxy) can correlate their request with our trace, and so
    // an operator handed a response header can find the trace without knowing our internals.
    void reply.header("traceparent", formatTraceparent(span.context));
  });

  fastify.addHook("onResponse", async (request: TracedRequest, reply: FastifyReply) => {
    const span = request.paymasterSpan;
    if (span === undefined) return;
    span.setAttribute("http.response.status_code", reply.statusCode);
    // 5xx is our failure; 4xx is the caller's and leaves the span unset, which is the convention —
    // otherwise every rejected credential would surface as a service error on a dashboard.
    if (reply.statusCode >= 500) span.recordError(new Error(`HTTP ${reply.statusCode}`));
    span.end();
  });

  // A request the client abandons never reaches onResponse; without this its span would stay open
  // and be lost at shutdown.
  fastify.addHook("onRequestAbort", async (request: TracedRequest) => {
    const span = request.paymasterSpan;
    if (span === undefined) return;
    span.setAttribute("http.aborted", true);
    span.end();
  });
}

function shouldSkip(url: string): boolean {
  const path = pathOf(url);
  return SKIP_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function pathOf(url: string): string {
  return url.split("?")[0] ?? url;
}

/** The route template when Fastify has matched one, else the path. Never the query string. */
function routeOf(request: FastifyRequest): string {
  const routeOptions = (request as {routeOptions?: {url?: string}}).routeOptions;
  return routeOptions?.url ?? pathOf(request.url);
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
