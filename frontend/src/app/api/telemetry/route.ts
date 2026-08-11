import {NextResponse} from "next/server";

import {backendFetch} from "@/lib/backend";
import {parsePrometheusText} from "@/lib/prometheus";
import {buildTelemetry, type HealthView} from "@/lib/telemetry";

/**
 * One scrape of the backend, shaped for the dashboard.
 *
 * Metrics and health are fetched together and INDEPENDENTLY: `/health/ready` fails whenever a chain
 * RPC is down, which is exactly the moment the metrics matter most, so one failing must not take
 * the other with it. A partial answer is the useful answer here.
 */
// Route handlers are uncached in Next 16, which is what a monitoring endpoint needs; no opt-out
// is required, and adding `force-dynamic` would only imply that caching was otherwise in play.
export async function GET() {
  const [metrics, health] = await Promise.all([
    backendFetch<string>("/metrics", {as: "text"}),
    backendFetch<HealthView>("/health/ready"),
  ]);

  // `/health/ready` returns 503 with a body when a chain is unhealthy — that body is the answer,
  // not an error, so a non-2xx health response still yields a view when it parses.
  const healthView = health.ok ? health.data : undefined;

  if (!metrics.ok) {
    return NextResponse.json(
      {
        connected: false,
        error: metrics.error,
        checkedAt: Date.now(),
        telemetry: null,
        health: healthView ?? null,
      },
      {status: 200},
    );
  }

  const snapshot = parsePrometheusText(metrics.data);
  return NextResponse.json({
    connected: true,
    checkedAt: Date.now(),
    scrapeLatencyMs: metrics.latencyMs,
    telemetry: buildTelemetry(snapshot, healthView),
  });
}
