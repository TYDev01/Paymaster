# Monitoring, alerting and tracing

What the paymaster exposes, what alerts on it, and what to do when one fires.

The system watches itself in three layers, and they are deliberately different in kind:

| Layer | Sees | Reacts |
| --- | --- | --- |
| **Metrics** (`/metrics`, Prometheus) | Rates, ratios, trends, absence | Prometheus rules → Alertmanager |
| **Direct alerts** (`Alerter` port) | Single observations the service itself makes: a deposit under threshold, an RPC circuit tripping, an IP crossing the abuse threshold | Log always, plus a pager when `ALERT_WEBHOOK_URL` is set |
| **Traces** (OTLP) | One request's path, end to end, with the policy decision on it | Nothing — traces are for investigation, not paging |

The split matters. The backend pages directly for conditions it can detect in one observation,
because routing those through Prometheus would add a scrape interval of delay to something it
already knows. Prometheus rules cover what a single observation cannot see — an error *ratio*, a
deposit *trend*, the *absence* of traffic, or the fact that the process is not being scraped at all.
Neither layer is redundant with the other, and only the funding alerts are deliberately duplicated
(as a backstop for the case where the backend's own alert egress is what is broken).

---

## Running the stack locally

```bash
docker compose --profile monitoring up
```

| Service | URL | Notes |
| --- | --- | --- |
| Prometheus | http://localhost:9090 | Scrapes the backend and rundler; loads `alerts.yml` |
| Grafana | http://localhost:3002 | Anonymous admin (dev only); dashboard auto-provisioned |
| OTel Collector | http://localhost:4318 | OTLP/HTTP in; logs spans by default |

Tracing stays off until you ask for it, because an exporter with no collector just logs failures:

```bash
echo 'OTEL_TRACES_ENABLED=true' >> .env
docker compose up -d backend
```

Configuration lives in [deploy/monitoring/](../deploy/monitoring/):

```
prometheus/prometheus.yml   scrape config (compose only; Kubernetes uses the ServiceMonitor)
prometheus/alerts.yml       the alert rules — canonical, shared with the Helm chart
grafana/dashboards/         dashboard JSON, provisioned read-only
grafana/provisioning/       datasource + dashboard provider
otel/collector.yaml         OTLP receiver; swap the exporter for Tempo/Jaeger/a vendor
```

## In Kubernetes

The Helm chart ships both objects, off by default because each needs the Prometheus Operator CRDs:

```bash
helm upgrade --install paymaster deploy/helm/paymaster \
  --set serviceMonitor.enabled=true \
  --set prometheusRule.enabled=true \
  --set-file prometheusRule.rulesYaml=deploy/monitoring/prometheus/alerts.yml
```

`--set-file` injects the same `alerts.yml` the compose stack loads, so there is exactly one copy of
the rules. A second copy inside `values.yaml` would drift, and drifted alert rules are worse than
absent ones — they read as coverage that is not there.

Tracing and paging are values:

```yaml
config:
  tracing:
    enabled: true
    endpoint: http://otel-collector.observability:4318
    sampleRatio: 0.1
  alerting:
    format: pagerduty
    minSeverity: critical
# The routing key and any credential-bearing URL are secrets, so they go through extraEnv:
extraEnv:
  - name: ALERT_WEBHOOK_URL
    value: https://events.pagerduty.com/v2/enqueue
  - name: ALERT_WEBHOOK_ROUTING_KEY
    valueFrom: {secretKeyRef: {name: paymaster-pagerduty, key: routingKey}}
```

---

## The metric set

All series are labelled only by bounded dimensions — chain id, rule name, outcome. Nothing is
labelled by an address, an API key, or an IP: those are caller-controlled, and a caller who can vary
a label can exhaust the scraper's memory.

| Metric | Type | Labels | Means |
| --- | --- | --- | --- |
| `paymaster_policy_decisions_total` | counter | `outcome` | Every policy evaluation, allowed or denied |
| `paymaster_policy_denials_total` | counter | `rule`, `code` | Which rule refused, and why |
| `paymaster_policy_evaluation_seconds` | histogram | — | Policy evaluation wall time |
| `paymaster_sponsorships_total` | counter | `chain`, `outcome` | `issued` / `denied` / `error` |
| `paymaster_gas_committed_wei_total` | counter | `chain` | Worst-case gas committed, in wei |
| `paymaster_chain_healthy` | gauge | `chain` | 1 when the RPC answers |
| `paymaster_chain_block_number` | gauge | `chain` | Latest observed head |
| `paymaster_chain_circuit_open` | gauge | `chain` | 1 while the breaker is fast-failing |
| `paymaster_deposit_wei` | gauge | `chain` | EntryPoint deposit |
| `paymaster_stake_wei` | gauge | `chain` | EntryPoint stake |
| `paymaster_funding_below_threshold` | gauge | `chain`, `kind` | `deposit` / `stake` / `read_error` |
| `paymaster_auth_failures_total` | counter | — | Authentication failures |
| `paymaster_ip_rejections_total` | counter | `reason` | Refused pre-auth: `throttled` / `blocked` |
| `paymaster_ip_blocks_total` | counter | — | IPs crossing the auth-failure threshold |

`outcome="denied"` is the service working correctly. Only `outcome="error"` is a fault — that
distinction is why the error-rate alert filters on it.

---

## Alert runbook

Each heading is the alert name; the Prometheus rules link here.

### PaymasterDown
Scrapes are failing. Check pods/containers are running and `/metrics` is reachable
(`METRICS_ENABLED` must be true). If the process is up but not scraped, the problem is the
ServiceMonitor selector or network policy, not the paymaster.

### PaymasterChainUnhealthy
Health probes for one chain fail. Sponsorship on that chain cannot be priced or validated;
`/health/ready` fails, so traffic sheds. Check the RPC provider first, then credentials/rate limits
in the `CHAINS` config. Other chains are unaffected — this is per-chain by design.

### PaymasterChainCircuitOpen
The breaker tripped after repeated RPC failures and is refusing reads for a cooldown. Almost always
downstream of `PaymasterChainUnhealthy`; fix the RPC and the breaker closes itself. Do not restart
to "clear" it — the breaker is protecting the service from a dependency that is still broken.

### PaymasterChainHeadStalled
The RPC answers but its block number is frozen: a lagging or forked node behind a load balancer.
Sponsorships are being priced against stale state. Fail over to another RPC URL for that chain.

### PaymasterDepositBelowThreshold
**Money.** The EntryPoint deposit for a chain is under its configured minimum. At zero, every
operation on that chain fails on-chain. Top up the deposit; then ask why it drained faster than
expected (check `PaymasterGasCommitmentSurge` and the denial panels — an over-permissive policy and
an attack look different).

### PaymasterStakeBelowThreshold
Bundlers enforcing the ERC-7562 reputation rules will reject operations from an under-staked
paymaster. Less urgent than the deposit — it degrades acceptance, it does not fail transactions
already accepted — but it is not optional in production. Add stake; the unstake delay means this
cannot be fixed instantly, so do not let it sit.

### PaymasterFundingUnreadable
The funding monitor cannot read deposit/stake for 10 minutes. The balance is **unknown**, not
known-good. Treat it as a potential deposit alert until you can read the value.

### PaymasterDepositExhaustionPredicted
At the last hour's burn rate the deposit empties within four hours. This is the alert that arrives
while there is still time to act. Top up, or reduce the spend caps in the active policy.

### PaymasterHighErrorRate
Over 5% of sponsorship requests failed internally (not denied — failed). Look at the logs for the
failing component: signer (KMS reachability), database (the sponsorship record is written before the
attestation is returned, deliberately), or chain RPC. A database outage manifests here rather than as
a silent unrecorded sponsorship, which is the intended trade.

### PaymasterPolicyEvaluationSlow
p99 policy evaluation above 250ms. Usually the quota store (Redis latency or a saturated connection)
or a rule that makes a chain call — `token-ownership` reads `balanceOf` on the RPC path.

### PaymasterNoSponsorshipsIssued
Up, scraped, and issuing nothing for 30 minutes. Either traffic genuinely stopped (upstream
integrator outage, DNS, gateway) or everything is being denied — check the denials-by-rule panel
before assuming the paymaster is fine. Delete this rule if idle periods are normal for you.

### PaymasterAuthFailureSpike
Sustained authentication failures. Either credential stuffing, or an integrator deployed a bad key.
The distinction is in the log: many source IPs is the first, one is the second. The pre-auth throttle
is already blocking the worst offenders; this tells you the campaign exists.

### PaymasterIpBlockSurge
Several IPs crossed the auth-failure threshold in 10 minutes — distributed, not one bad client. The
throttle handles the mechanics; the decision this alert asks for is whether to tighten
`IP_ABUSE_AUTH_FAILURE_THRESHOLD` or block upstream at the edge.

### PaymasterDenialSurge
One policy rule is denying heavily. A quota rule means a caller is over budget (expected, if noisy);
a blocklist rule means someone is probing what you refuse. Check which `rule` label fired.

### PaymasterGasCommitmentSurge
**Money.** Commitment rate above the configured tolerance. This is the rule standing between a policy
misconfiguration and a drained deposit. Verify the active policy's spend caps, then look for a single
`apiKeyId` dominating the sponsorship records. The threshold ships as a placeholder — tune it.

---

## Tracing

Enabled by `OTEL_TRACES_ENABLED` + `OTEL_EXPORTER_OTLP_ENDPOINT`. The service emits OTLP/HTTP JSON
directly, without the OpenTelemetry SDK: the wire format and the propagation header are what must be
standard, and both are. Any collector, Tempo, Jaeger or hosted vendor accepts it. The rationale for
not taking the SDK dependency is in [tracing.ts](../backend/src/monitoring/tracing.ts) — briefly, it
is a large tree that patches core modules at load time, inside a service that spends money.

What you get per request:

- an **HTTP server span** (`POST /paymaster/sponsor`) covering the whole request including the
  pre-auth throttle, so a request rejected at the edge still produces a span;
- a child **`sponsor` span** carrying `paymaster.chain_id`, `paymaster.policy_id`,
  `paymaster.outcome`, and either `paymaster.max_cost_wei` or the denial's rule and code.

A denial is recorded with attributes, not as a span error — it is the service working. Only internal
failures set the error status, so an error rate computed from traces means the same thing as the one
computed from metrics.

Incoming `traceparent` is honoured (a trace that starts in a wallet SDK continues here) and the
response carries our own, so a caller can correlate. Sampling is head-based and inherited by the
whole trace, including across the propagation header, so a sampled trace is never half-recorded.

Span names use the route template, never the raw URL: span names are a low-cardinality dimension in
every backend, and URLs are caller-controlled. `/health` and `/metrics` are not traced — a scraper
would otherwise be most of the trace volume.

---

## Alert delivery

`Alerter` is a port. The log sink is always composed; a webhook is added alongside it, never instead
of it, and `CompositeAlerter` isolates each sink so a pager outage degrades to a logged alert rather
than to no alert.

| `ALERT_WEBHOOK_FORMAT` | Delivery |
| --- | --- |
| `pagerduty` | Events API v2. `alert.key` is the `dedup_key`, so a resolution closes the incident the alert opened |
| `slack` | Incoming webhook. No resolution semantics, so a recovery message is posted instead |
| `generic` | Our JSON, optionally HMAC-signed exactly as inbound requests are (`ALERT_WEBHOOK_SIGNING_SECRET`) |

Delivery is bounded (per-attempt timeout, small retry count, no retry on 4xx — a bad routing key is a
configuration error, not a blip) so a hanging pager API cannot stall the monitor loop that detected
the problem. Alerts are edge-triggered by their producers: a condition fires when it becomes true,
re-fires after `FUNDING_MONITOR_REALERT_MS` if still unresolved, and resolves when it clears.

Set `ALERT_WEBHOOK_MIN_SEVERITY=critical` to page only for what stops sponsorship outright; warnings
still reach the log.

---

## What is deliberately not here

- **Alertmanager** is not configured in the compose stack. Routing, silencing and escalation are
  deployment decisions, and a dev stack that pages is a dev stack people mute. The rules are ready
  for one; point `alerting:` in `prometheus.yml` at it.
- **Log aggregation.** The service logs structured lines to stdout; shipping them is the platform's
  job, not the application's.
- **Metrics for per-IP or per-key dimensions.** Unbounded cardinality, caller-controlled. The
  identity lives in the alert and the log, where it belongs.
