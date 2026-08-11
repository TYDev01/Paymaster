# Remaining Work

Status of what is left to implement, measured against [td.md](../td.md) and [td2.md](../td2.md).
Every item here has been flagged during the build; nothing is aspirational filler. Items are grouped
by whether they **block production**, are **spec-required but non-blocking**, or are **hardening**.

Legend: 🔴 blocks production · 🟡 spec-required, not blocking · 🟢 hardening / nice-to-have ·
🔵 beyond the current spec · ✅ done this pass

---

## Completed: deploy, Redis, testing and documentation pass

- ✅ **Multi-chain deploy runner + contract verification** — and, in running it against a real
  chain, a genuine bug in the existing deploy script: staking as the deployer after handing
  ownership to a multisig reverted, leaving a funded but unstaked paymaster. Details below.
- ✅ **Contract coverage to 100%**, with a CI floor that fails the build on any regression.
- ✅ **The two Redis uses that were needed** — cross-replica policy propagation (a real multi-replica
  bug) and a leader lock that stops N replicas paging N times. The other two td.md lists are
  documented as deliberately not built.
- ✅ **Load, property-based and forked-chain tests** — including a sponsored operation executed by
  the real EntryPoint on a fork of mainnet, and a demonstration that a quota of 50 grants exactly 50
  under 200-way concurrency.
- ✅ **The full documentation set** — deployment, operations, runbooks, disaster recovery, developer
  guide.

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

**Nothing on td.md's or td2.md's lists is now outstanding.** Every item is either done — including
the Docker Compose stack, booted and verified end to end, and the Helm chart, now linted and
rendered — or listed under "Deliberately NOT built" with its reasoning. What remains are
deployment-specific decisions: Alertmanager routing, and tuning two alert thresholds to real traffic.

Both the image and the chart are now built and rendered in CI (the `deploy-artifacts` job), because
every defect found in them survived precisely as long as nothing built them.

---

## 🔵 Not built: the multi-tenant SaaS product

**This is the largest open item, and it is a change of product shape rather than a feature.** What
exists today is a SINGLE-TENANT paymaster: one operator, one shared deposit per chain, one policy
set, and API keys minted by that operator through an authenticated admin API. td.md and td2.md
describe exactly that, and it is built.

The intended product is different: a self-service platform where a dApp developer signs up, gets
their own API key, funds their own balance, and spends only what they funded. Everything below is
what separates the two.

### Why the Funding page has no "Fund" button

The button is the easy part; it would be dishonest without the ledger behind it.

`deposit()` on the paymaster is deliberately not owner-gated and `receive()` forwards a bare
transfer into the EntryPoint deposit, so anyone can already top it up from a wallet. But there is
**one deposit per chain, shared by every caller**. With no per-tenant accounting, a customer who
funded it would be funding the pool that everyone else spends from — their money would subsidise
other tenants, and nothing in the system could tell you whose balance had been consumed.

So the missing piece is not UI. It is a **balance that belongs to someone**.

### What has to exist first

In dependency order — each item needs the ones above it.

1. **A tenant model.** Organisations, users, membership, and a tenant id on every row that can be
   attributed. There is no such concept anywhere in the codebase today (`grep tenant` returns
   nothing), and retrofitting one touches every admin query.
2. **Authentication for humans.** The current auth is machine-to-machine: API keys, plus optional
   operator JWTs. Privy would sit in front as the human identity provider (social login + embedded
   wallet), exchanged for a session bound to a tenant. The existing `JwtService` is a reasonable
   place for that session to land; the API-key path stays exactly as it is for the dApp's server.
3. **Self-service key issuance.** Keys are currently minted by an operator holding `key:write`, and
   the roles (`sponsor`/`viewer`/`admin`) are operator-shaped. A tenant needs to mint keys scoped to
   its OWN tenant and nothing else, which means a new role and — critically — tenant scoping
   enforced in the store, not in the controller. A missing `WHERE tenant_id = $1` in one query is a
   cross-tenant data leak.
4. **A credit ledger.** The hard part, and the one that decides the product.

   The chain gives us one deposit per paymaster address, so per-tenant on-chain deposits would mean
   a paymaster contract per tenant — expensive to deploy, stake and monitor, and it multiplies the
   stake requirement by the tenant count. The workable shape is the standard one: **a shared
   on-chain deposit plus an off-chain credit ledger**. A tenant funds their balance (crypto transfer
   or card), sponsorship debits it, and the operator keeps the shared deposit topped up.

   That makes the ledger financially load-bearing, and it has to be exact:
   - debits must be **reserved** at signing time and **trued up** to actual on-chain cost, which is
     the same two-phase shape the spend caps already use;
   - a tenant at zero must be refused **fail-closed**, because past zero the operator is paying;
   - the ledger must reconcile against the on-chain deposit, or slow drift becomes unexplained loss.
5. **Billing.** Usage metering, a pricing model (gas at cost plus margin, or a subscription), an
   invoice, and a payment rail. Also the operational question of what happens when a card fails
   while operations are in flight.
6. **Tenant-scoped policy.** Today a policy is global and edited by the operator. A tenant needs to
   edit its own policy, bounded by platform limits it cannot raise — nested limits, not a flat set.
7. **The frontend for all of it.** Signup, org management, keys, funding, usage, invoices. The
   current console is an OPERATOR view and read-only by design; this is a second, tenant-facing
   surface with write paths and wallet connection.

### What it can build on

The foundations are better than they look, because per-key attribution already exists:

- `sponsorships` records `api_key_id`, `max_cost_wei` and — once the reconciler has run —
  `actual_gas_cost_wei`, indexed by `(api_key_id, created_at)`. That is a usage meter already.
- `SpendReconciler` already trues reserved cost up to actual on-chain cost. A credit ledger needs
  exactly that mechanism, pointed at a balance instead of a window counter.
- `QuotaRule` already supports an `apiKey` subject, so per-key spend limits work today.
- The policy engine's reserve/release shape is the right one for debiting a balance.

The genuinely new work is the tenant boundary, the balance itself, and billing.

### Decisions needed before any of it is built

These are product and legal calls, not technical ones, and they change the design:

- **Custody.** A shared deposit funded by customers means the operator holds customer funds. That is
  a regulatory question in most jurisdictions before it is an engineering one.
- **Funding rail.** Crypto only (simplest, no card processor, but the balance is a deposit the
  operator custodies) or fiat via a processor (a different compliance surface).
- **Pricing.** Gas at cost plus margin, prepaid credits, or a subscription with an included
  allowance — each implies a different ledger.
- **Isolation.** One shared paymaster contract for all tenants (cheap, but every tenant shares a
  reputation and a pause switch) or one per large tenant (isolated, far more to operate).

Until those are settled, building the ledger would be guessing at the thing hardest to change later.

---

## Blocks production

### ✅ KMS-backed signer — DONE
The signing key no longer has to live in process heap: setting `SPONSORSHIP_SIGNER_KMS_KEY_ID` selects
`KmsSponsorshipSigner`, which signs via a KMS API call and never sees key material.
- **Added:** `backend/src/signature/kmsSigner.ts` (`KmsClient` port + signer), `awsKmsClient.ts`
  (AWS adapter, dynamic-imported optional dep), wired in `app.module.ts`; env enforces exactly one of
  the local key or the KMS key. Tested in `test/kmsSigner.test.ts`.

### ✅ Docker Compose stack verified end-to-end — DONE
`docker compose up` now brings up postgres + redis + anvil + bundler + backend, all five healthy,
and the SDK example sponsors a real operation through it: mined, `success: true`, paid from the
paymaster's deposit, account balance unchanged. The `--profile monitoring` stack was booted too —
Prometheus scraping all three targets with all 15 alert rules loaded, Grafana with its datasource
and dashboard provisioned, and the OTel collector receiving spans.

**Booting it found five defects, none of which any other test could have caught.** They are listed
because they are the argument for why "it parses" is not "it runs":

1. **The image could not build.** `COPY --from=deps /app/backend/node_modules` referenced a path npm
   never creates — it hoists workspace dependencies to the root — so the build failed outright.
2. **The image could not start.** The runtime `CMD` was `npx tsx backend/src/main.ts`, but `tsx` is
   a devDependency and the image is built `--omit=dev`. Fixed properly rather than by shipping tsx:
   there is now a real `tsc` emit step (`tsconfig.build.json`) and the runtime runs `node
   backend/dist/main.js`, which is what the Dockerfile's own "no compiler, no dev dependencies"
   comment always claimed.
3. **The bundler could never become healthy.** Its healthcheck used `wget`, which the rundler image
   does not ship (nor `curl`). The container sat in `health: starting` forever, and anything waiting
   on `condition: service_healthy` for it would have hung indefinitely rather than failed. Replaced
   with a real JSON-RPC round trip over bash's `/dev/tcp`.
4. **The bundler and backend disagreed about the EntryPoint.** `deploy/rundler/chain.toml` pins the
   canonical v0.7 address; `local-setup.sh` deployed the EntryPoint wherever `forge create` landed.
   That is precisely the silent mismatch chain.toml's own comment warns about — the backend signs
   attestations bound to one EntryPoint while the bundler submits to another, and every sponsorship
   fails with an opaque AA34. Fixed by placing the local EntryPoint at the canonical address
   (`anvil_setCode`), which also makes the devnet match every real chain.
5. **A fresh database had no policies at all.** With `DATABASE_URL` set, policies come from the
   database and the in-code bootstrap set is never consulted — so the documented quickstart failed
   with "no policy with id default", naming a policy nobody had been told to create. Added
   `BOOTSTRAP_DEFAULT_POLICY` (off by default; seeds only into an EMPTY policy table, so it can
   never overwrite or resurrect an operator's policy), mirroring how `BOOTSTRAP_API_KEY` already
   solves the same chicken-and-egg for credentials.

Also fixed on the way: host port bindings are now overridable (a developer machine very often
already runs Postgres on 5432), and a comment inside an unquoted heredoc in `local-setup.sh` used
backticks — so bash executed `source` with no argument on every run.

Note the ordering the stack requires, which is now documented in the README: the backend validates
`CHAINS` at startup and refuses to serve a chain whose EntryPoint has no code, so contracts must
exist before it boots. `docker compose up -d anvil` → `./deploy/local-setup.sh` → put the generated
`CHAINS` in `.env` (with `http://anvil:8545` for the container network) → `docker compose up`.

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

### ✅ Kubernetes / Helm — DONE (linted, rendered, and validated)
A chart at `deploy/helm/paymaster` (Deployment, Service, ConfigMap, optional Secret, HPA, PDB,
ServiceMonitor, Ingress, ServiceAccount). The backend's statelessness shows through: it is a plain
Deployment with no init ordering, because migrations self-serialise via the advisory lock. Liveness
(`/health/live`) and readiness (`/health/ready`) are separate so an RPC outage sheds traffic without
restart-looping; the root filesystem is read-only with an in-memory `/tmp`; secrets are bring-your-own
by default (chart-managed only for dev). Rendered YAML is documented in `deploy/helm/paymaster/README.md`.

`helm lint` and `helm template` now run in CI, and rendering the chart found three configurations
that produced valid YAML and a broken cluster:

- **The default install was broken.** The Deployment mounts a Secret via `envFrom`, but the default
  values (`create: false`, `existingSecret: ""`) never create one — so pods sat in
  `CreateContainerConfigError`, a failure that says nothing about secrets.
- **`config.chains` defaults to empty**, which renders `CHAINS: ""`; the backend rejects it at
  startup. The single most likely first-install mistake produced a crash loop.
- **`config.alerting.format=pagerduty`** rendered happily without a routing key, which the backend
  also rejects at startup — three container restarts away from the value that caused it.

All three now fail at `helm template` time with a sentence naming what is missing
(`templates/_validate.tpl`), which is the same posture the backend takes with its own environment:
fail closed, at startup, naming the variable.

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

### ✅ Remaining Redis uses — DONE (the two that were needed)
td.md lists four Redis uses beyond quotas. Two were real gaps and are built; two would have been
cargo cult and are in "Deliberately NOT built" below with their reasoning.

- **Policy propagation ("policy cache")** — this was a genuine multi-replica BUG, not an
  optimisation. `PolicySource` holds the policy set in memory and an admin write reloaded only the
  replica that served it, so behind a load balancer an operator who added a sender to a blocklist had
  blocked them on a fraction of traffic, with no way to tell which fraction. Now every replica
  reloads on a timer (`POLICY_RELOAD_INTERVAL_MS`, the correctness guarantee, which holds without
  Redis) and a Redis pub/sub announcement makes a change land in milliseconds (the optimisation).
  `policyBroadcast.ts`, `policyReloader.ts`; bursts are coalesced and overlapping reloads serialise
  so the newest state wins. Tested in `test/policyPropagation.test.ts` and against a real Redis in
  `test/redis.test.ts`.
- **Distributed lock management** — `RedisLeaderLock` (`monitoring/leaderLock.ts`), a lease with
  atomic renew/release Lua scripts. It gates PAGER DELIVERY only: three replicas seeing one drained
  deposit previously raised three alerts, and a resolve from one could close an incident the others
  still held open. Monitoring itself is never gated (a chain unreachable from one pod is a real
  condition) and neither is the log sink. The reconciler is deliberately not gated either — it
  already claims rows atomically, so a lock would make it single-threaded for no gain. Tested
  against a real Redis, including lease expiry and takeover.

### ✅ Documentation set — DONE
Every document on td.md's list now exists:

| Document | Covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Structure and the reasoning behind it |
| [SECURITY.md](SECURITY.md) | Security guide and threat model |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production deployment, in dependency order, with a checklist |
| [OPERATIONS.md](OPERATIONS.md) | Operator guide: policies, keys, chains, funding, maintenance schedule, upgrades |
| [RUNBOOKS.md](RUNBOOKS.md) | Incident procedures — the stop button, spend runaway, leaked keys, dependency outages |
| [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md) | What survives what, RTO/RPO, and what is genuinely unrecoverable |
| [MONITORING.md](MONITORING.md) | Metric catalogue, a runbook entry per alert, tracing, pager config |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Developer guide: layout, conventions, the test layering, how to add a rule/chain/metric/migration |
| [backend/openapi.yaml](../backend/openapi.yaml) | API reference |

The maintenance guide is a section of OPERATIONS.md rather than its own file — weekly/monthly/
quarterly tasks and the upgrade procedure read as part of operating the thing, not as a separate
discipline.

---

## Hardening / quality

### ✅ ESLint + Prettier — DONE
Flat-config ESLint (`eslint.config.js`, typescript-eslint recommended + prettier compat) and Prettier
(`.prettierrc.json`, tuned to the house style; prose left alone) are in place, with root `lint` /
`format` / `format:check` scripts and CI steps in `.github/workflows/test.yml`. The whole tree passes
both.

### ✅ Measure test coverage — DONE, both workspaces
The full suite runs in this environment — 454 backend tests across 29 files (Postgres, Redis, anvil,
rundler and a mainnet fork included) and 35 contract tests — so these are measured, not estimated:

| | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| Contracts (`VerifyingPaymaster.sol`) | 100% | 100% | 100% | 100% |
| Backend (`src/`) | 82.86% | 82.86% | 89.14% | 83.85% |

`forge coverage` is now wired into CI with a **100% floor** on the contract, so any new uncovered
path fails the build. Reaching it found two genuinely untested behaviours worth having: `receive()`
forwarding a bare ETH transfer into the EntryPoint deposit (the automated-refill path — ETH stopping
at the contract's own balance would look like a successful top-up and pay for nothing), and
`removeSigner` rejecting an address that was never authorised (a silent no-op would let an operator
believe they had revoked a key they had actually mistyped).

The backend gaps are honest ones: `awsKmsClient.ts` (16% — needs real KMS), `securityPlugin.ts`
(0% — Fastify hook wiring, exercised only through a booted server), `chainEventSource.ts` (36%).

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

### ✅ Load / fuzz / forked-chain tests — DONE
All four of td.md's categories, and each targets a property the existing suite could not reach.

- **Forked chain** (`test/fork.test.ts`) — forks Ethereum mainnet at head and runs a sponsored
  operation through the REAL EntryPoint at its canonical address, at a real base fee. It confirms
  the assumption everything else takes on faith: that `0x0000...032` really is EntryPoint v0.7 and
  behaves as the vendored copy does, that our deposit and stake register on the real ledger, and
  that the paymaster's deposit pays while the account's balance does not move. Runs against a public
  RPC by default, so it is not silently skipped.
- **Load / concurrency** (`test/load.test.ts`) — 200 concurrent sponsorship requests against a quota
  of 50, backed by a real Redis. Exactly 50 are granted and 150 cleanly refused with 429, zero 5xx.
  That is the check-then-increment over-grant bug `RedisQuotaStore`'s Lua script exists to prevent,
  demonstrated under real contention rather than argued from the code. Throughput is printed as an
  observation, deliberately not asserted — an RPS threshold on a CI runner is either meaningless or
  flaky.
- **Property-based / fuzz** (`test/property.test.ts`) — 2,000 generated cases per property over the
  code where one wrong bit is a wrong amount of money: uint128 packing round-trips and refuses
  overflow rather than truncating, the paymasterAndData codec round-trips every field and rejects
  every truncated prefix, worst-case cost is monotonic in gas (a non-monotonic cost would let a
  caller split spending to stay under a cap while spending more), and quota windows tile time with
  no gaps or overlaps. A fixed seed, so failures replay; the failing case is printed.
- **Real load testing** (`deploy/load/k6-sponsor.js`) — a k6 ramp for a DEPLOYED instance, where TLS,
  connection limits and the database under sustained write are what actually break. Not run here: it
  spends real money by design, and the header says so.

### ✅ Contract deployment verification + multi-chain runner — DONE
`deploy/deploy-chains.sh` deploys, funds, stakes and source-verifies on every configured chain from
one command, then prints the backend's `CHAINS` configuration generated from the broadcast receipts
— so the config cannot disagree with what is actually on chain. It preflights every chain before
broadcasting to any (a missing RPC URL on the sixth chain must not leave you half-deployed across
five), is idempotent, and fails soft per chain. `deploy/verify-contracts.sh` re-runs verification
alone, because an explorer being down is not a reason to re-run a deploy that already spent gas.

**Running it against a real chain found a real bug in the existing deploy script.** `addStake` is
`onlyOwner`, and the script constructed the paymaster owned by `PAYMASTER_OWNER` before staking it
as the deployer — so every deploy where the owner is a multisig, which is the documented production
recommendation, reverted `OwnableUnauthorizedAccount` AFTER deploying the contract and making the
deposit, leaving a funded but UNSTAKED paymaster that every conforming bundler rejects. It was
invisible until now because every existing path sets the owner to the deployer. Fixed by deploying
owned by the deployer, funding and staking, then handing over via `Ownable2Step` — which also means
a mistyped owner leaves control with the deployer instead of burning the contract. Regression-tested
in `contracts/test/DeployPaymaster.t.sol`, and the deploy config is now a struct rather than raw env
reads so the tests do not fight over the shared process environment.

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
- **Redis nonce cache** — td.md lists one; there is nothing for it to cache. The EntryPoint owns
  nonces and is authoritative, and the paymaster never needs to know one before signing: an
  attestation binds to the operation's nonce through the EIP-712 digest, so a stale cached nonce
  could only produce an attestation that fails on chain. A cache here would add a way to be wrong
  about something we do not need to be right about.
- **Temporary signature store** — attestations are stateless by construction. The paymaster recovers
  the signer from `paymasterAndData` during validation; nothing on either side needs to look one up
  afterwards. Storing them would create a second, expiring copy of something the caller already holds
  and the chain will verify independently — and a store of live sponsorship signatures is a target
  with no compensating benefit.
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
