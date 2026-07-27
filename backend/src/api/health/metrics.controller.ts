import {Controller, Get, Header, Inject, Optional} from "@nestjs/common";

import {PaymasterMetrics} from "../../monitoring/paymasterMetrics.js";

export const PAYMASTER_METRICS = Symbol("PAYMASTER_METRICS");

/**
 * Prometheus scrape endpoint.
 *
 * Unauthenticated on purpose: metrics carry no secrets (every series is labelled only by chain id,
 * rule name, and outcome — never by a caller identity or an address), and a scraper reaching it
 * before it has credentials is the common deployment. Operators who want it private restrict it at
 * the ingress, which is where network-level access control belongs.
 *
 * The metrics provider is optional so a deployment can disable it; when absent the endpoint reports
 * that plainly rather than 500ing a scraper.
 */
@Controller("metrics")
export class MetricsController {
  constructor(@Optional() @Inject(PAYMASTER_METRICS) private readonly metrics: PaymasterMetrics | null = null) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  scrape(): string {
    // `== null` catches both the disabled sentinel (useValue: null) and an absent provider.
    if (this.metrics == null) return "# metrics are disabled\n";
    return this.metrics.registry.render();
  }
}
