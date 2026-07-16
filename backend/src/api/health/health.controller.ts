import {Controller, Get, HttpCode, HttpStatus, Inject, Res} from "@nestjs/common";
import type {FastifyReply} from "fastify";

import type {ChainRegistry} from "../../chain/chainRegistry.js";
import type {PolicySource} from "../../policy/policySource.js";

export const HEALTH_DEPS = Symbol("HEALTH_DEPS");

export interface HealthDeps {
  readonly chains: ChainRegistry;
  readonly policies: PolicySource;
}

/**
 * Liveness and readiness.
 *
 * Split because they answer different questions and a load balancer acts on them differently.
 * Liveness: is the process wedged and in need of a restart? Readiness: should traffic come here
 * right now? Conflating them means an RPC outage restarts every pod in a loop, turning a
 * degradation into an outage.
 */
@Controller("health")
export class HealthController {
  constructor(@Inject(HEALTH_DEPS) private readonly deps: HealthDeps) {}

  /** Liveness: the process is running. Deliberately checks nothing external. */
  @Get("live")
  @HttpCode(HttpStatus.OK)
  live(): {status: "ok"} {
    return {status: "ok"};
  }

  /**
   * Readiness: we can actually serve a sponsorship.
   *
   * Returns 503 when no chain is reachable, so the load balancer stops sending traffic here while
   * leaving the process alive to recover. Reports per-chain detail either way, because "which
   * chain is down" is the first question an operator asks.
   */
  @Get("ready")
  async ready(@Res({passthrough: true}) reply: FastifyReply): Promise<ReadinessReport> {
    const chains = await Promise.all(this.deps.chains.adapters.map((adapter) => adapter.health()));
    const enabled = chains.filter((c) => this.deps.chains.has(c.chainId));

    const policiesLoaded = this.deps.policies.generation > 0;
    const anyChainHealthy = enabled.some((c) => c.healthy);
    const ready = policiesLoaded && anyChainHealthy;

    if (!ready) void reply.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ready ? "ready" : "not_ready",
      policies: {loaded: policiesLoaded, generation: this.deps.policies.generation},
      chains: chains.map((c) => ({
        chainId: c.chainId,
        healthy: c.healthy,
        blockNumber: c.blockNumber?.toString(),
        latencyMs: Math.round(c.latencyMs),
        error: c.error,
      })),
    };
  }
}

export interface ReadinessReport {
  readonly status: "ready" | "not_ready";
  readonly policies: {loaded: boolean; generation: number};
  readonly chains: readonly {
    chainId: number;
    healthy: boolean;
    blockNumber: string | undefined;
    latencyMs: number;
    error: string | undefined;
  }[];
}
