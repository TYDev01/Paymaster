# Remaining Work

Status of what is left to implement, measured against [td.md](../td.md) and [td2.md](../td2.md).
Every item here has been flagged during the build; nothing is aspirational filler. Items are grouped
by whether they **block production**, are **spec-required but non-blocking**, or are **hardening**.

Legend: 🔴 blocks production · 🟡 spec-required, not blocking · 🟢 hardening / nice-to-have

---

## Blocks production

### 🔴 KMS-backed signer
The sponsorship signing key is held in process heap memory (`LocalSponsorshipSigner`), reachable from
a core dump. The `SponsorshipSigner` port is already shaped for this — a KMS/HSM adapter is an
additive change, not a refactor.
- **Where:** `backend/src/signature/signer.ts` (port exists), needs a new `KmsSponsorshipSigner`.
- **Done when:** the signer key never enters the Node process; signing is a KMS API call.

### 🔴 Docker Compose stack verified end-to-end
`docker-compose.yml` parses (`docker compose config` is clean) and every component runs outside
Docker, but the composed stack has **never been booted** — no Docker daemon in the build environment.
- **Done when:** `docker compose up` brings up postgres+redis+anvil+bundler+backend and the SDK
  example sponsors an op against it. Needs the images to build and the healthchecks to pass.

### 🔴 Deposit / stake monitor + low-balance alerting
`ChainAdapter.getPaymasterFunding()` can read deposit and stake against configured thresholds, but
nothing calls it on a timer or alerts. A drained deposit silently stops all sponsorship; an
under-staked paymaster is silently unbundleable.
- **Where:** new background service consuming `ChainAdapter`; wire to alerting.
- **Done when:** deposit/stake below threshold fires an alert before sponsorship fails.

### 🔴 Spend-cap reconciliation loop
Spend caps charge worst-case `maxCost`, not actual gas cost (which is always lower — proven in
`maxCost.test.ts`). Caps therefore run conservative and drift the longer they run.
- **Where:** new loop reading `UserOperationEvent` from each chain, correlating by
  `(chainId, sender, nonce)` to the `sponsorships` table, truing up Redis counters.
- **Done when:** spend counters reflect actual on-chain cost, not the worst-case reservation.

---

## Spec-required, not yet done

### 🟡 JWT admin authentication
td.md lists "JWT admin auth" explicitly. Today admin auth is API-key + RBAC only. JWT would add
short-lived operator sessions distinct from long-lived integration keys.

### 🟡 Token-ownership policy rule
td.md lists "token ownership requirements". The `network` cost tier and the chain adapter both exist
for it; the rule itself was never written. It needs an on-chain `balanceOf` read during evaluation.
- **Where:** new rule in `backend/src/policy/rules/`, registered in `policyFactory.ts`.

### 🟡 Kubernetes / Helm
td2.md asks for Kubernetes/Helm for production. Nothing exists. The backend is stateless (state in
Postgres+Redis) so this is charts + config, not app changes. Migrations already serialise across
replicas via a Postgres advisory lock.

### 🟡 Monitoring stack (Prometheus / Grafana / OpenTelemetry)
td.md lists all three. The bundler (rundler) already exports Prometheus metrics; the **backend
exports none**. Needs: a `/metrics` endpoint, the metrics td.md enumerates (gas sponsored, failed
sponsorships, success rate, latency, chain/RPC health, deposit/stake), Grafana dashboards, OTel
tracing, and the alert rules (low deposit, RPC failure, high error rate, attack detection).

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

### 🟢 ESLint + Prettier
td.md requires both. `forge fmt` covers Solidity. TypeScript has **no linter or formatter config** —
only `tsc` strictness. Add flat-config ESLint + Prettier and a CI check.

### 🟢 Measure test coverage
td.md targets 95%+. Coverage has **never been measured**. Do not cite a number that has not been
produced. Add `vitest --coverage` + `forge coverage` and report real figures before claiming any.

### 🟢 Additional security controls (td.md list)
- Request signing (HMAC over request bodies)
- Circuit breakers (per-chain, on repeated RPC failure)
- Pre-authentication IP throttling — the per-IP quota runs *after* auth, so it does not protect the
  auth path itself
- Redis-backed abuse/attack detection distinct from quotas

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

**Spend caps over-reserve.** Until the reconciliation loop above exists, a spend cap charges the
worst-case `maxCost` at sponsorship time. Real cost is always lower, so callers hit their cap sooner
than a true daily budget would imply. This is safe (it errs toward spending less) but is not exact.
