import type {PolicyEvaluation, PolicyObserver} from "../policy/engine.js";
import type {IpThrottleMetrics} from "../security/ipThrottle.js";
import type {FundingResult} from "./fundingMonitor.js";
import {MetricsRegistry, type Counter, type Gauge, type Histogram} from "./metrics.js";

/**
 * The backend's metric set — td.md's list, made concrete.
 *
 * One facade owns every series so their names and labels stay consistent and so the wiring points
 * (the policy engine observer, the sponsor path, the funding monitor) depend on intent-named methods
 * rather than on the registry's primitives. It doubles as a `PolicyObserver`, which is how per-rule
 * denial counts and evaluation latency are captured without the engine knowing about metrics.
 *
 * The bundler (rundler) already exports its own Prometheus metrics; these are the sponsorship-layer
 * metrics that only the backend can see: which policy denied, how much was committed, whether each
 * chain's funding is healthy.
 */
export class PaymasterMetrics implements PolicyObserver, IpThrottleMetrics {
  readonly registry: MetricsRegistry;

  readonly #decisions: Counter;
  readonly #denials: Counter;
  readonly #evalDuration: Histogram;
  readonly #sponsorships: Counter;
  readonly #gasCommitted: Counter;
  readonly #chainHealthy: Gauge;
  readonly #chainBlock: Gauge;
  readonly #deposit: Gauge;
  readonly #stake: Gauge;
  readonly #fundingBelow: Gauge;
  readonly #circuit: Gauge;
  readonly #authFailures: Counter;
  readonly #ipRejections: Counter;
  readonly #ipBlocks: Counter;

  constructor(registry: MetricsRegistry = new MetricsRegistry()) {
    this.registry = registry;
    this.#decisions = registry.counter("paymaster_policy_decisions_total", "Policy evaluations by outcome.");
    this.#denials = registry.counter("paymaster_policy_denials_total", "Policy denials by rule and code.");
    this.#evalDuration = registry.histogram(
      "paymaster_policy_evaluation_seconds",
      "Policy evaluation wall time.",
      [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    );
    this.#sponsorships = registry.counter("paymaster_sponsorships_total", "Sponsorship requests by chain and outcome.");
    this.#gasCommitted = registry.counter(
      "paymaster_gas_committed_wei_total",
      "Worst-case gas committed to sponsorships, in wei, by chain.",
    );
    this.#chainHealthy = registry.gauge("paymaster_chain_healthy", "1 if the chain RPC is healthy, else 0.");
    this.#chainBlock = registry.gauge("paymaster_chain_block_number", "Latest observed block number per chain.");
    this.#deposit = registry.gauge("paymaster_deposit_wei", "Paymaster EntryPoint deposit per chain, in wei.");
    this.#stake = registry.gauge("paymaster_stake_wei", "Paymaster EntryPoint stake per chain, in wei.");
    this.#fundingBelow = registry.gauge(
      "paymaster_funding_below_threshold",
      "1 when deposit/stake is below its configured threshold, else 0.",
    );
    this.#circuit = registry.gauge(
      "paymaster_chain_circuit_open",
      "1 when a chain's RPC circuit breaker is not closed (open or half-open), else 0.",
    );
    // The abuse series. Deliberately unlabelled by IP: an attacker chooses their source address, so
    // an ip label would let them mint unbounded series and exhaust the scraper's memory. The rate of
    // these counters is what an attack-detection rule needs; WHICH ip is in the alert and the log.
    this.#authFailures = registry.counter(
      "paymaster_auth_failures_total",
      "Authentication failures, counted for abuse detection.",
    );
    this.#ipRejections = registry.counter(
      "paymaster_ip_rejections_total",
      "Requests rejected pre-authentication, by reason (throttled or blocked).",
    );
    this.#ipBlocks = registry.counter(
      "paymaster_ip_blocks_total",
      "IPs newly blocked for crossing the auth-failure threshold.",
    );
  }

  /** IpThrottleMetrics: a request refused before authentication ran. */
  recordIpRejection(reason: "throttled" | "blocked"): void {
    this.#ipRejections.inc({reason});
  }

  /**
   * IpThrottleMetrics: one authentication failure, and whether it was the one that tripped a block.
   * The block counter is the sharp signal — failures happen; a block means someone is grinding.
   */
  recordAuthFailure(blocked: boolean): void {
    this.#authFailures.inc();
    if (blocked) this.#ipBlocks.inc();
  }

  /** Reflects a chain RPC circuit-breaker state change. 0 = closed (healthy), 1 = open/half-open. */
  recordCircuitState(chainId: number, state: "closed" | "open" | "half-open"): void {
    this.#circuit.set(state === "closed" ? 0 : 1, {chain: chainId});
  }

  /** PolicyObserver: called for every evaluation. Counts outcomes, denials per rule, and latency. */
  onDecision(evaluation: PolicyEvaluation, durationMs: number): void {
    // The engine emits a synthetic evaluation for a failed reservation release; do not double count.
    if (evaluation.policyId === "<release>") return;
    this.#decisions.inc({outcome: evaluation.decision.allowed ? "allowed" : "denied"});
    this.#evalDuration.observe(durationMs / 1000);
    if (!evaluation.decision.allowed) {
      this.#denials.inc({rule: evaluation.decision.rule, code: evaluation.decision.code});
    }
  }

  /** Records the result of a sponsorship request at the service boundary. */
  recordSponsorship(chainId: number, outcome: "issued" | "denied" | "error", committedWei = 0n): void {
    this.#sponsorships.inc({chain: chainId, outcome});
    if (outcome === "issued" && committedWei > 0n) {
      // Counter values are JS numbers; a per-op wei value fits a float64 with ample headroom
      // (a costly op is ~1e15 wei, far below 2^53), and the total is monotonic, which is all a
      // counter promises.
      this.#gasCommitted.inc({chain: chainId}, Number(committedWei));
    }
  }

  /** Reflects one health probe into the chain gauges. */
  recordChainHealth(chainId: number, healthy: boolean, blockNumber: bigint | undefined): void {
    this.#chainHealthy.set(healthy ? 1 : 0, {chain: chainId});
    if (blockNumber !== undefined) this.#chainBlock.set(Number(blockNumber), {chain: chainId});
  }

  /** Reflects the funding monitor's per-chain results into the deposit/stake gauges. */
  recordFunding(results: readonly FundingResult[]): void {
    for (const result of results) {
      if (!result.ok) {
        this.#fundingBelow.set(1, {chain: result.chainId, kind: "read_error"});
        continue;
      }
      const {chainId, funding} = result;
      this.#deposit.set(Number(funding.deposit), {chain: chainId});
      this.#stake.set(Number(funding.stake), {chain: chainId});
      this.#fundingBelow.set(funding.depositBelowThreshold ? 1 : 0, {chain: chainId, kind: "deposit"});
      this.#fundingBelow.set(funding.stakeBelowThreshold ? 1 : 0, {chain: chainId, kind: "stake"});
      this.#fundingBelow.set(0, {chain: chainId, kind: "read_error"});
    }
  }
}
