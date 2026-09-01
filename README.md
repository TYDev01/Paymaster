# Self-Hosted ERC-4337 Paymaster + Bundler Platform

A production-oriented, fully self-hosted ERC-4337 (EntryPoint **v0.7**) account-abstraction
platform: a verifying paymaster you own end to end, a sponsorship backend that decides and signs,
and a self-hosted bundler. No dependency on any hosted paymaster or bundler service.

```
Wallet ──▶ SDK ──▶ Bundler (rundler) ──▶ RPC router ──▶ EntryPoint ──▶ EVM chain
                └──▶ Paymaster API ──▶ (policy + signature) ──▶ paymasterAndData
```

## What this is

- **VerifyingPaymaster** (Solidity) — sponsors a UserOperation when an authorised backend signer
  has attested to it, bound by EIP-712 to one chain and one deployment. Rotatable signer set,
  emergency pause, two-step ownership.
- **Sponsorship backend** (TypeScript / NestJS / viem) — a policy engine that decides *whether* to
  sponsor and a signature engine that produces the on-chain attestation, behind an authenticated
  HTTP API. PostgreSQL for durable state, Redis for cross-replica quotas.
- **Bundler** — [rundler](https://github.com/alchemyplatform/rundler) (Alchemy's open-source Rust
  bundler, Apache-2.0/MIT), run on our own infrastructure. Not a hosted service.
- **SDK** (TypeScript) — framework-agnostic client that drives both the paymaster and the bundler
  in one call.

## Design stance: verify against the real thing

Every layer is tested against real infrastructure, not mocks:

- the signature engine's digest is asserted equal to the **deployed EntryPoint's** own `getHash`;
- `maxCost` is bracketed against a **real EntryPoint's** prefund requirement to the wei;
- quota atomicity is proven against a **real Redis**, and the schema against a **real PostgreSQL**;
- the paymaster is accepted — and an unstaked one **rejected** — by a **real bundler** running full
  trace validation;
- the SDK drives the **real backend and real bundler** to land an operation on-chain.

Where a test *could* pass while the system is wrong, that gap is closed by mutation: the load-bearing
tests have each been shown to fail when the code they guard is broken. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Repository layout

| Path | What |
| --- | --- |
| [contracts/](contracts/) | Foundry project: `VerifyingPaymaster.sol`, `TenantPaymaster.sol`, deploy script |
| [backend/](backend/) | NestJS sponsorship + admin API, policy/signature engines, DB, Redis |
| [sdk/](sdk/) | Framework-agnostic TypeScript SDK + runnable example |
| [web/](web/) | The public site and the CUSTOMER dashboard (Next.js), on `:3000`. `/` explains the product; `/dashboard` is the signed-in account |
| [frontend/](frontend/) | The OPERATOR console (Next.js), on `:3003`: live metrics, chains, funding, alerts |
| [deploy/](deploy/) | Multi-chain deploy + verification, the RPC router, an endpoint checker, Helm chart, monitoring config, k6 load test |
| [docker-compose.yml](docker-compose.yml) | Stack: postgres, redis, rpc-router, bundler (Sepolia), backend |
| [docs/](docs/) | Indexed at [docs/README.md](docs/README.md): integration, architecture, security, deployment, operations, runbooks, DR, monitoring, development |

### Ports, locally

Two Next apps, a bundler and a Grafana all want a port in the low 3000s, so they are assigned
rather than left to collide:

| Port | What |
| --- | --- |
| 3000 | `web/` — the public site and `/dashboard`. It owns 3000 because that is the address a person types |
| 3001 | Bundler (rundler) |
| 3002 | Grafana |
| 3003 | `frontend/` — the operator console |
| 3100 | Backend API on the HOST. Inside its container it still listens on 3000, so nothing in Kubernetes changed |

### The RPC router, and why the bundler needs one

Rundler validates in safe mode, which enforces the ERC-7562 storage rules — the rules that make the
paymaster's stake load-bearing. That requires `debug_traceCall` **with a custom JavaScript tracer**,
and that one requirement narrows the field sharply:

| Provider | `debug_traceCall` | Custom JS tracer |
| --- | --- | --- |
| QuickNode, Chainstack, self-hosted geth/reth | yes | **yes** |
| Alchemy, Infura | yes, built-in tracers only | no — `-32600 invalid tracer value` |
| Free public endpoints | no — `-32601` | no |

The providers that qualify tend to meter hardest. QuickNode's free tier allows 15 requests/second,
and rundler issues far more than that — measured at **369 ordinary reads per sponsored operation
against 3 trace calls**. The endpoint that can validate gets exhausted by traffic that has nothing
to do with validating.

[deploy/rpc-router/](deploy/rpc-router/) splits the traffic by method: `debug_*` and `trace_*` go to
the tracing provider, everything else to a second endpoint that never needs debug support. Both can
be free tiers. Configure with `RPC_URL` (tracing) and `ALCHEMY_RPC_URL` (everything else) in
`contracts/.env`.

Before committing to a provider, check it:

```bash
./deploy/check-rpc.sh https://your-endpoint
```

Two more free-tier settings live in [docker-compose.yml](docker-compose.yml) and are documented
there: `USER_OPERATION_EVENT_BLOCK_DISTANCE` (rundler's default searches block 0→latest, which
every provider rejects) and `RUST_LOG` (rundler logs nothing by default, which makes every
submission failure opaque).

`web/` and `frontend/` are separate deployments on purpose. The operator console's server holds
`PAYMASTER_ADMIN_KEY`, which reads and writes every tenant; the customer app authenticates as the
signed-in customer and never has that credential in its process at all.

## Quickstart (local)

```bash
./start.sh
```

That is the whole thing: it checks the toolchain, installs what is missing, brings up the chain,
deploys the contracts onto it, writes the backend's `.env`, starts the stack, and starts both web
apps. It is idempotent — a second run redeploys nothing that is still on chain — and it leaves any
port it finds already served alone rather than fighting whoever owns it.

```bash
./start.sh status        # what is up, and where
./start.sh stop          # stop everything it started (data volumes are kept)
./start.sh --skip-checks # do not read Sepolia at boot (offline, or the RPC is rate limiting)
./start.sh --monitoring  # add Prometheus, Grafana and the OTel collector
./start.sh --no-ui       # backend stack only
```

The stack runs against **Ethereum Sepolia**, not a local chain. `start.sh` does not deploy: it
reads the paymaster out of `contracts/.env` (or the broadcast receipt), checks on chain that it has
code, a deposit and enough stake for the bundler's floor, and generates `CHAINS` from what it found
rather than from anything transcribed.

Postgres and Redis are remapped automatically if their host ports are taken, because nothing in the
stack reaches them that way — the backend uses the compose network. A conflict on the bundler's
3001 is reported instead: that one IS addressed by name from the host.

### First, deploy a paymaster to Sepolia

`start.sh` deliberately will not do this for you: it spends real ETH, and a boot script should not.
Deploy once, and every later boot reads the result back.

```bash
cp contracts/.env.example contracts/.env
$EDITOR contracts/.env      # DEPLOYER_KEY (funded), PAYMASTER_OWNER, PAYMASTER_SIGNER

cd contracts
set -a && source .env && set +a
forge script script/DeployPaymaster.s.sol:DeployPaymaster \
  --rpc-url "$RPC_URL" --broadcast --verify --private-key "$DEPLOYER_KEY"
```

Budget roughly `STAKE_WEI + DEPOSIT_WEI + ~0.007 ETH` of gas. The deploy funds and stakes in the
same broadcast, because a paymaster is non-functional without both.

### Doing it by hand

Requires Foundry, Node ≥ 22, PostgreSQL 16, Redis, and the rundler binary.

```bash
# 1. Install deps and fetch the pinned, checksum-verified bundler binary
npm install
npm run bundler:fetch --workspace @paymaster/backend

# 2. Point the stack at Sepolia. Both are required — compose refuses to start without them.
#    BUNDLER_SIGNER_KEY is an EOA that PAYS for the bundles it submits, in real Sepolia ETH.
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
export BUNDLER_SIGNER_KEY=0x...

# 3. Start the bundler and the backend, then run the end-to-end example against Sepolia:
cd sdk && SMART_ACCOUNT=0x... ACCOUNT_OWNER_KEY=0x... API_KEY=... npx tsx examples/sponsor-and-send.ts
#    -> success: true; account balance (unchanged, it paid nothing): 0 wei
```

The smart account is yours to provide — on Sepolia nothing deploys one for you. It need not hold a
balance (that is the point of the paymaster), but it must already be deployed or validation fails
with AA20.

### Or the whole thing in Docker

```bash
# CHAINS names the paymaster, so it must exist on chain before the backend starts — the backend
# validates CHAINS at boot and refuses a chain whose EntryPoint has no code.
docker compose up -d                       # postgres, redis, bundler, backend

cd sdk && npx tsx examples/sponsor-and-send.ts
```

`./start.sh` writes `.env` for you; by hand, it needs `CHAINS`, `SPONSORSHIP_SIGNER_KEY`,
`BOOTSTRAP_API_KEY`, `SEPOLIA_RPC_URL`, `BUNDLER_SIGNER_KEY` and `MIN_STAKE_VALUE`.

Add `--profile monitoring` for Prometheus, Grafana (:3002) and an OTel collector. If the host
already runs Postgres or Redis, set `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` in `.env` — nothing
inside the stack uses those host ports.

## Testing

```bash
# Contracts (Foundry): 35 tests, incl. a full EntryPoint + SimpleAccount flow and the deploy script.
# 100% line/statement/branch/function coverage, enforced in CI.
cd contracts && forge test

# Backend + SDK: 474 tests, incl. real Postgres, Redis, EntryPoint, a real bundler, 200-way
# concurrency against real Redis, 2,000-case property tests, and a fork of Ethereum mainnet.
# Integration suites self-skip when their infra (rundler binary, postgres, redis) is absent.
npm test
```

## Supported chains

Ethereum, BNB Smart Chain, Polygon, Arbitrum, Base, Optimism — and any other EVM chain that has the
canonical v0.7 EntryPoint (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`, identical on every chain).
Adding a chain is configuration only; there is no per-chain code.

## Status

This is a substantial, working implementation with an important set of caveats. It is **not yet
something to point at mainnet without the hardening listed below.**

**Implemented and verified against real infrastructure:**

| Area | State |
| --- | --- |
| VerifyingPaymaster contract | ✅ 35 tests, mutation-checked, 100% covered |
| Signature engine | ✅ differential vs deployed EntryPoint |
| Policy engine (allow/block/quota/spend caps, hot reload) | ✅ |
| Chain adapter + config-only onboarding | ✅ |
| Authenticated API (API keys + RBAC) | ✅ |
| PostgreSQL persistence + migrations | ✅ vs real Postgres |
| Redis cross-replica quotas | ✅ vs real Redis |
| Admin API + hot reload | ✅ |
| Self-hosted bundler integration | ✅ vs real rundler |
| TypeScript SDK + example | ✅ full-stack e2e |
| Deploy script + local devnet | ✅ runs end to end |
| CI (contracts + backend + SDK) | ✅ |
| KMS-backed signer (key never in process) | ✅ |
| JWT admin auth, request signing, circuit breakers, IP throttling | ✅ |
| Deposit/stake monitor + spend-cap reconciliation | ✅ |
| Metrics, alert rules, Grafana, OTLP tracing, pager sink | ✅ see [docs/MONITORING.md](docs/MONITORING.md) |
| Kubernetes / Helm chart | ✅ linted + rendered, with value validation |
| Multi-chain deploy + explorer verification | ✅ exercised against a live node |
| Cross-replica policy propagation + leader lock | ✅ vs real Redis |
| Load, property-based and forked-chain tests | ✅ incl. mainnet fork vs the real EntryPoint |
| Documentation set | ✅ see [docs/](docs/) |
| Operations console (Next.js) | ✅ reads the real /metrics, /health and admin API |
| Docker Compose stack | ✅ booted end to end, incl. the monitoring profile |

Coverage is measured against the full suite — Postgres, Redis, a test-spawned anvil, rundler and a mainnet fork
included — not estimated:

| | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| Contracts | 100% | 100% | 100% | 100% |
| Backend | 82.86% | 82.86% | 89.14% | 83.85% |

**Not built — a different product shape:** this is a SINGLE-TENANT paymaster (one operator, one
shared deposit per chain, keys minted by that operator), which is what td.md and td2.md specify. The
self-service SaaS shape — signup, per-tenant API keys, per-tenant funded balances, billing — needs a
tenant model and a credit ledger that do not exist yet. Scoped in
[docs/REMAINING.md](docs/REMAINING.md#-not-built-the-multi-tenant-saas-product).

**Not yet done — deployment decisions rather than missing work:**

- **Alertmanager routing** is not configured; routing, silencing and escalation are per-deployment.
- Two alert-rule thresholds ship as `TUNE` placeholders that need real traffic to set.

Full detail, including what was deliberately *not* built and why, is in
[docs/REMAINING.md](docs/REMAINING.md).

## Documentation

Start at **[docs/README.md](docs/README.md)** — it routes by audience, because all but one of these
are written for the person RUNNING the platform rather than the person integrating with it.

| | |
| --- | --- |
| [docs/README.md](docs/README.md) | Index, and the five things that surprise people |
| [INTEGRATION.md](docs/INTEGRATION.md) | **For customers**: sign up, fund, mint a key, call the SDK |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Structure, and the reasoning behind it |
| [SECURITY.md](docs/SECURITY.md) | Security guide and threat model |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment, in order, with a checklist |
| [OPERATIONS.md](docs/OPERATIONS.md) | Policies, keys, chains, funding, maintenance, upgrades |
| [RUNBOOKS.md](docs/RUNBOOKS.md) | Incident procedures |
| [DISASTER-RECOVERY.md](docs/DISASTER-RECOVERY.md) | What survives what, and what does not |
| [MONITORING.md](docs/MONITORING.md) | Metrics, alerts, tracing, paging |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Working on the codebase |
| [openapi.yaml](backend/openapi.yaml) | API reference |

## License

MIT (this project's own code). One licensing consideration to resolve before commercial
distribution: `VerifyingPaymaster` inherits `BasePaymaster` from
[eth-infinitism/account-abstraction](https://github.com/eth-infinitism/account-abstraction), which
is **GPL-3.0**, so the deployed contract is a derivative work under that license. This is common
across ERC-4337 paymasters but is a real obligation, not a footnote — get counsel before shipping.
rundler (Apache-2.0) is run as a separate process, not linked, so it does not carry this concern.
