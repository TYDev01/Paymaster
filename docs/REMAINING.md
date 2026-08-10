# Remaining Work

Status of what is left to implement, measured against [td.md](../td.md) and [td2.md](../td2.md).
Every item here has been flagged during the build; nothing is aspirational filler. Items are grouped
by whether they **block production**, are **spec-required but non-blocking**, or are **hardening**.

Legend: 🔴 blocks production · 🟡 spec-required, not blocking · 🟢 hardening / nice-to-have ·
✅ done this pass

---

## Completed: monitoring pass

- ✅ **Full monitoring stack** — Prometheus alert rules, a provisioned Grafana dashboard, OTLP
  tracing with W3C propagation, a real pager sink (PagerDuty / Slack / signed webhook) behind the
  existing `Alerter` port, abuse metrics for attack detection, and a `--profile monitoring` compose
  stack. Detail in the monitoring section below; operator documentation in
  [docs/MONITORING.md](MONITORING.md).
- ✅ **`testEnv` helper** (`test/support/env.ts`) — the three hand-written `Env` literals in the test
  suite are gone. They had to be edited whenever a variable was added, which made adding one look
  like it broke the tests; the helper runs the real schema instead.

## Completed: hardening pass

- ✅ **KMS-backed signer** — `KmsSponsorshipSigner` over a `KmsClient` port, with an `AwsKmsClient`
  adapter. The key never enters the process; DER→`r‖s‖v` conversion, low-`s` normalisation and `v`
  recovery are done in-process and proven bit-for-bit identical to the local signer.
- ✅ **Deposit / stake monitor + alerting** — `FundingMonitor` polls every chain's funding on a
  timer and edge-triggers alerts (`Alerter` port, `LoggingAlerter` default) before sponsorship fails.
- ✅ **Spend-cap reconciliation loop** — `SpendReconciler` reads `UserOperationEvent`s, correlates by
  `(chainId, sender, nonce)`, and trues the exact quota counters up to actual on-chain cost.
- ✅ **Token-ownership policy rule** — `TokenOwnershipRule` (`network` cost), registered in
  `policyFactory.ts`, fail-closed, with per-chain token addresses.
- ✅ **Backend `/metrics`** — a Prometheus endpoint and the core metric set (decisions, denials by
  rule, sponsorships, gas committed, chain health, deposit/stake).
- ✅ **ESLint + Prettier + coverage tooling** — flat-config ESLint, Prettier, `vitest --coverage`,
  wired into CI. Coverage numbers are deliberately not cited until the full suite is run.

The four items above that block production are struck through below; the rest of each section is the
work that remains.

---

## Blocks production

### ✅ KMS-backed signer — DONE
The signing key no longer has to live in process heap: setting `SPONSORSHIP_SIGNER_KMS_KEY_ID` selects
`KmsSponsorshipSigner`, which signs via a KMS API call and never sees key material.
- **Added:** `backend/src/signature/kmsSigner.ts` (`KmsClient` port + signer), `awsKmsClient.ts`
  (AWS adapter, dynamic-imported optional dep), wired in `app.module.ts`; env enforces exactly one of
  the local key or the KMS key. Tested in `test/kmsSigner.test.ts`.

### 🔴 Docker Compose stack verified end-to-end
`docker-compose.yml` parses (`docker compose config` is clean) and every component runs outside
Docker, but the composed stack has **never been booted** — no Docker daemon in the build environment.
- **Done when:** `docker compose up` brings up postgres+redis+anvil+bundler+backend and the SDK
  example sponsors an op against it. Needs the images to build and the healthchecks to pass.

### ✅ Deposit / stake monitor + low-balance alerting — DONE
`FundingMonitor` (`backend/src/monitoring/fundingMonitor.ts`) polls every chain's funding on a timer,
edge-triggers alerts through the `Alerter` port (deposit = critical, stake = warning, unreadable =
critical), and feeds the deposit/stake metrics. Runs as a `BackgroundService` tied to the app
lifecycle. Tested in `test/fundingMonitor.test.ts`.

### ✅ Spend-cap reconciliation loop — DONE
`SpendReconciler` (`backend/src/reconciliation/spendReconciler.ts`) reads each chain's settled
`UserOperationEvent`s, atomically claims the matching `sponsorships` row (migration 0003 adds the
columns + checkpoint table), and calls `QuotaRule.trueUp` to refund the over-reservation into the
exact counter/window that charged it. Every ambiguity biases conservative. Tested in
`test/spendReconciler.test.ts`. Note the wallet/chain/global/apiKey caps reconcile; per-IP and
per-target spend caps stay conservative because a sponsorship row does not record IP or target.

---

## Spec-required, not yet done

### ✅ JWT admin authentication — DONE
`JwtService` (`backend/src/auth/jwt.ts`) mints and verifies short-lived HS256 session tokens
(`node:crypto`, no library — so the security-critical parts, rejecting `alg:none` and constant-time
signature checks, are readable in full). `POST /admin/auth/token` (`auth.controller.ts`) exchanges an
API key for a session carrying the caller's OWN roles — never an escalation. `ApiKeyGuard` now
accepts either credential, disambiguated by shape (a `pm_*` key vs a JWT). Enabled by
`ADMIN_JWT_SECRET`; disabled cleanly (endpoint 503s) when unset. Tested in `test/jwt.test.ts`.

### ✅ Token-ownership policy rule — DONE
`TokenOwnershipRule` (`backend/src/policy/rules/tokenOwnership.ts`) reads `balanceOf` via a
`TokenBalanceReader` port (`ChainRegistryTokenBalanceReader` over the real chains), gates sponsorship
on an ERC-20/721 holding, and fails closed. Registered in `policyFactory.ts` with a `token-ownership`
schema (single token or per-chain map, minimum balance). Tested in `test/policyFactory.test.ts`.

### ✅ Kubernetes / Helm — DONE
A chart at `deploy/helm/paymaster` (Deployment, Service, ConfigMap, optional Secret, HPA, PDB,
ServiceMonitor, Ingress, ServiceAccount). The backend's statelessness shows through: it is a plain
Deployment with no init ordering, because migrations self-serialise via the advisory lock. Liveness
(`/health/live`) and readiness (`/health/ready`) are separate so an RPC outage sheds traffic without
restart-looping; the root filesystem is read-only with an in-memory `/tmp`; secrets are bring-your-own
by default (chart-managed only for dev). Rendered YAML is documented in `deploy/helm/paymaster/README.md`.
Not linted here — `helm` is not installed in this environment — so run `helm lint` / `helm template`
before first use.

### ✅ Monitoring stack (Prometheus / Grafana / OpenTelemetry) — DONE
Documented end to end in [docs/MONITORING.md](MONITORING.md), including a runbook entry per alert.

- **Metrics** — `/metrics` exports policy decisions, denials by rule, sponsorships by outcome, gas
  committed, chain health, deposit/stake, plus the abuse series added this pass
  (`paymaster_auth_failures_total`, `paymaster_ip_rejections_total`, `paymaster_ip_blocks_total`),
  which is what gives the attack-detection rules a rate to threshold against. Nothing is labelled by
  an address, key or IP — caller-controlled labels are an unbounded-cardinality hazard.
- **Alert rules** — `deploy/monitoring/prometheus/alerts.yml`: 15 rules over availability, funding,
  errors and abuse, covering exactly what a single observation cannot see (rates, ratios, trends,
  absence). The backend keeps paging directly for what it can see itself, so the two do not
  double-page; only the funding rules are duplicated deliberately, as a backstop for the case where
  the backend's own alert egress is broken. Shipped to Kubernetes by a `PrometheusRule` template
  that injects that same file via `--set-file`, so there is one copy of the rules, not two.
- **Grafana** — `deploy/monitoring/grafana/`: a provisioned dashboard (sponsorship, chain health,
  funding, abuse) with a datasource and a read-only dashboard provider.
- **Pager sink** — `WebhookAlerter` (`backend/src/monitoring/webhookAlerter.ts`) delivers over
  PagerDuty Events API v2 (the alert key is the dedup key, so a resolution closes the incident the
  alert opened), Slack, or a generic HMAC-signed JSON endpoint. Composed *alongside* `LoggingAlerter`,
  never instead of it. Tested in `test/webhookAlerter.test.ts`.
- **Tracing** — OTLP/HTTP JSON with W3C trace-context propagation, written directly rather than
  through the OTel SDK (`tracing.ts`, `otlpTracer.ts`, `tracingPlugin.ts`). Server span per request,
  child span per sponsorship carrying chain, policy and outcome; head sampling inherited across the
  whole trace; bounded queue and bounded blocking. Tested in `test/tracing.test.ts`.
- **Local stack** — `docker compose --profile monitoring up` brings up Prometheus, Grafana and an
  OTel collector. Configuration-only: the backend exports metrics and spans whether or not they run.

Still open: **Alertmanager routing** is not configured (routing/silencing/escalation are deployment
decisions, and the compose stack deliberately does not page), and the `PaymasterGasCommitmentSurge`
and `PaymasterDenialSurge` thresholds ship as placeholders that must be tuned to real traffic.

### 🟡 Remaining Redis uses
Redis currently backs quotas only. td.md also lists: nonce cache, policy cache, temporary-signature
store, distributed lock management. None are built (and some may not be needed — see "Deliberately
not built").

### 🟡 Documentation set
[docs/ARCHITECTURE.md](ARCHITECTURE.md), [docs/SECURITY.md](SECURITY.md) (security guide + threat
model), and [backend/openapi.yaml](../backend/openapi.yaml) exist. Still to write, from td.md's list:
- Deployment guide (production, beyond the local quickstart)
- Runbooks
- Disaster recovery
- Maintenance guide
- Operator guide
- Developer guide (beyond the README)

---

## Hardening / quality

### ✅ ESLint + Prettier — DONE
Flat-config ESLint (`eslint.config.js`, typescript-eslint recommended + prettier compat) and Prettier
(`.prettierrc.json`, tuned to the house style; prose left alone) are in place, with root `lint` /
`format` / `format:check` scripts and CI steps in `.github/workflows/test.yml`. The whole tree passes
both.

### 🟡 Measure test coverage — MEASURED (backend), contracts pending
The full backend suite now runs in this environment — 420 tests across 24 files, including the
Postgres, Redis, anvil and rundler-backed ones — so a real figure can be cited:

| | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Backend (`src/`) | 80.99% | 89.07% | 83.03% | 80.99% |

Measured with `npm run test:coverage` (`vitest run --coverage`, `@vitest/coverage-v8`). The gaps are
where you would expect them and are honest ones: `awsKmsClient.ts` (16% — needs real KMS),
`securityPlugin.ts` (0% — Fastify hook wiring, exercised only through a booted server),
`chainEventSource.ts` (36%). `forge coverage` for the contracts is still to add.

### ✅ Additional security controls (td.md list) — DONE
All four, under `backend/src/security/` (tested in `test/{circuitBreaker,ipThrottle,requestSignature}.test.ts`):
- **Request signing** — `RequestSignatureVerifier` checks an HMAC-SHA256 over
  `timestamp\nMETHOD\npath\nrawBody` with a freshness window bounding replay; enforced at the Fastify
  edge (`securityPlugin.ts`) on mutating requests when `REQUEST_SIGNING_SECRET` is set. Uses Nest's
  `rawBody` so it verifies the exact bytes, not a re-serialisation.
- **Circuit breakers** — a per-chain `CircuitBreaker` wraps every RPC read in `ChainAdapter`; after a
  run of failures it fast-fails for a cooldown (and `health` reports the chain unhealthy without a
  call), opening/closing through the shared `Alerter` and a `paymaster_chain_circuit_open` gauge.
- **Pre-authentication IP throttling** — an `onRequest` Fastify hook runs the `IpThrottle` before any
  auth code, so a flood is cut off ahead of the credential check the per-IP policy quota sits behind.
- **Redis-backed abuse detection** — `IpThrottle` counts auth failures per IP (fed by `ApiKeyGuard`)
  in the shared quota store and blocks an IP past a threshold for the rest of the window, alerting
  once on the transition. Distinct from quotas: it shares the store, not the counters.

### 🟢 Load / fuzz / forked-chain tests
td.md lists load testing, property-based tests, fuzz testing, forked-chain tests. Contracts have
Foundry fuzz tests; the backend has none of load/fork. No k6/artillery load suite.

### 🟢 Contract deployment verification
The deploy script does not yet run `forge verify-contract` against block explorers, and there is no
multi-chain deploy runner (deploy to all six target chains from one command).

---

## Deliberately NOT built (with rationale)

These appear in td.md but were judged wrong to build as specified. Listed so the decision is explicit
and reversible, not silently skipped.

- **`gas_usage`, `daily_limits` tables** — these are quota counters. A write per request on a hot row
  would be the system's bottleneck. They belong in Redis (where quotas already are), not Postgres.
- **`users`, `wallets` tables** — the paymaster has no users (API keys belong to customers) and a
  wallet is just an address. A table adds nothing until something needs metadata about one.
- **`transactions` table** — overlaps `sponsorships` and the chain itself.
- **`token_configs`, `allowlists`, `blocklists` tables** — these are policy *configuration*, already
  expressed as rule config inside `policies` / `policy_rules`. Separate tables would need their own
  consistency story for no gain.
- **`admins`, `chains` tables** — legitimately missing. `admins` awaits JWT auth; `chains` are still
  env config (which is why "enable/disable chain" is not yet in the admin API). Build when needed.
- **Dynamic policy-plugin loading** — td.md says "custom policy plugins". The `PolicyRule` interface
  *is* the extension point, but a new rule must be compiled in. Runtime plugin loading (untrusted
  code deciding whether to spend money) is a security liability that outweighs the flexibility.

---

## Known correctness caveat (documented, not a bug)

**Some spend caps still over-reserve.** A spend cap charges the worst-case `maxCost` at sponsorship
time; real cost is always lower. `SpendReconciler` now trues the wallet, chain, global and apiKey
caps back up to actual on-chain cost, so those are exact once an operation settles. The **per-IP and
per-target** spend caps stay conservative, because a `sponsorships` row records neither the client IP
nor the call target and so cannot be correlated back to the counter that charged it. Callers on those
two caps hit their limit sooner than a true daily budget would imply — safe (it errs toward spending
less), but not exact.
