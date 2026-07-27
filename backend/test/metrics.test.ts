import {describe, expect, it} from "vitest";

import {MetricsRegistry} from "../src/monitoring/metrics.js";
import {PaymasterMetrics} from "../src/monitoring/paymasterMetrics.js";
import type {FundingResult} from "../src/monitoring/fundingMonitor.js";
import type {PaymasterFunding} from "../src/chain/chainAdapter.js";
import type {PolicyEvaluation} from "../src/policy/engine.js";
import {deny} from "../src/policy/context.js";

describe("MetricsRegistry", () => {
  it("renders counters in Prometheus text format with labels", () => {
    const reg = new MetricsRegistry();
    const c = reg.counter("things_total", "Things.");
    c.inc({kind: "a"});
    c.inc({kind: "a"});
    c.inc({kind: "b"}, 3);
    const out = reg.render();
    expect(out).toContain("# TYPE things_total counter");
    expect(out).toContain('things_total{kind="a"} 2');
    expect(out).toContain('things_total{kind="b"} 3');
  });

  it("renders a histogram with cumulative buckets, sum and count", () => {
    const reg = new MetricsRegistry();
    const h = reg.histogram("dur_seconds", "Durations.", [0.1, 1]);
    h.observe(0.05);
    h.observe(0.5);
    h.observe(2);
    const out = reg.render();
    expect(out).toContain('dur_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('dur_seconds_bucket{le="1"} 2');
    expect(out).toContain('dur_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain("dur_seconds_count 3");
    expect(out).toContain("dur_seconds_sum 2.55");
  });

  it("escapes quotes and backslashes in label values", () => {
    const reg = new MetricsRegistry();
    reg.counter("x_total", "X.").inc({name: 'a"b\\c'});
    expect(reg.render()).toContain('x_total{name="a\\"b\\\\c"} 1');
  });
});

describe("PaymasterMetrics", () => {
  function evaluation(over: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
    return {decision: {allowed: true}, policyId: "p", evaluated: [], ...over};
  }

  it("counts allowed and denied decisions and per-rule denials", () => {
    const m = new PaymasterMetrics();
    m.onDecision(evaluation(), 2);
    m.onDecision(evaluation({decision: deny("sender-blocklist", "SENDER_BLOCKED", "x")}), 1);
    const out = m.registry.render();
    expect(out).toContain('paymaster_policy_decisions_total{outcome="allowed"} 1');
    expect(out).toContain('paymaster_policy_decisions_total{outcome="denied"} 1');
    expect(out).toContain('paymaster_policy_denials_total{rule="sender-blocklist",code="SENDER_BLOCKED"} 1');
  });

  it("ignores the synthetic release evaluation", () => {
    const m = new PaymasterMetrics();
    m.onDecision(evaluation({policyId: "<release>", decision: deny("q", "RULE_ERROR", "x")}), 0);
    expect(m.registry.render()).not.toContain("paymaster_policy_denials_total{");
  });

  it("records sponsorship outcomes and committed gas", () => {
    const m = new PaymasterMetrics();
    m.recordSponsorship(8453, "issued", 10n ** 15n);
    m.recordSponsorship(8453, "denied");
    const out = m.registry.render();
    expect(out).toContain('paymaster_sponsorships_total{chain="8453",outcome="issued"} 1');
    expect(out).toContain('paymaster_sponsorships_total{chain="8453",outcome="denied"} 1');
    expect(out).toContain('paymaster_gas_committed_wei_total{chain="8453"} 1000000000000000');
  });

  it("reflects funding results into deposit/stake and threshold gauges", () => {
    const m = new PaymasterMetrics();
    const funding: PaymasterFunding = {
      chainId: 8453,
      deposit: 5n,
      stake: 7n,
      staked: true,
      unstakeDelaySec: 0,
      depositBelowThreshold: true,
      stakeBelowThreshold: false,
    };
    const results: FundingResult[] = [{chainId: 8453, ok: true, funding}];
    m.recordFunding(results);
    const out = m.registry.render();
    expect(out).toContain('paymaster_deposit_wei{chain="8453"} 5');
    expect(out).toContain('paymaster_funding_below_threshold{chain="8453",kind="deposit"} 1');
    expect(out).toContain('paymaster_funding_below_threshold{chain="8453",kind="stake"} 0');
  });
});
