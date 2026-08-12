# Developer guide

Working on this codebase: how it is laid out, how to run it, how to test it, and the conventions
that will otherwise look arbitrary.

Architecture and the reasoning behind the structure is in [ARCHITECTURE.md](ARCHITECTURE.md); this
is the practical companion to it.

---

## Getting set up

Requires Node 22+ and [Foundry](https://book.getfoundry.sh/). The backend's tests use a real
Postgres, a real Redis and a real anvil, so install those too — they are not optional extras, they
are how most of the suite runs.

```bash
git clone --recurse-submodules <repo> && cd Paymaster
npm install
(cd contracts && forge build)          # the backend's differential tests read these artifacts
npm run bundler:fetch --workspace @paymaster/backend   # pinned rundler, checksummed
npm test
```

`forge build` first, always. Several backend suites load Foundry's build artifacts rather than a
checked-in ABI copy — deliberately, so a contract change breaks the tests that depend on its shape
instead of silently drifting from them.

### Running it

```bash
anvil                        # terminal 1
./deploy/local-setup.sh      # deploys everything, writes deploy/.env.local
set -a && . deploy/.env.local && set +a
npm run dev --workspace @paymaster/backend
```

`local-setup.sh` produces the whole on-chain world — Multicall3, EntryPoint v0.7, a factory, a
funded and staked paymaster, a smart account — and prints the config the backend, bundler and SDK
all consume. Or bring up the full stack with `docker compose up`, and add
`--profile monitoring` for Prometheus, Grafana and an OTel collector.

---

## Layout

```
contracts/    VerifyingPaymaster, its tests, and the deploy script
backend/      The sponsorship service (NestJS over Fastify, but see below)
sdk/          Framework-agnostic TypeScript client
web/          Public site + customer dashboard (Next.js, :3000). Standalone npm project
frontend/     Operator console (Next.js, :3003). A standalone npm project, NOT a root workspace
deploy/       Deploy runners, Helm chart, monitoring config, load tests
docs/         This documentation set
```

Inside `backend/src`:

| Directory | Holds |
| --- | --- |
| `api/` | Controllers, DTOs, guards, filters — the only framework-aware code |
| `policy/` | The rule engine, rules, quota stores, policy source and propagation |
| `signature/` | EIP-712 attestation, the signer port, KMS adapter, paymasterAndData codec |
| `chain/` | Chain registry, adapter, circuit breaker, gas maths |
| `db/` | Postgres adapters. Repositories, not an ORM |
| `monitoring/` | Metrics, alerting, tracing, background service host, leader lock |
| `reconciliation/` | Spend reconciler and its event source |
| `security/` | Request signing, IP throttle, the Fastify edge plugin |
| `config/` | Environment parsing and the bootstrap policy set |

---

The console is deliberately outside the npm workspaces and outside the root eslint/prettier config:
Next pins its own React and tooling, and hoisting those into a monorepo whose other packages keep a
small, audited dependency surface would couple two unrelated release cadences. It has its own
`npm install`, its own lint, and its own README.

## Conventions

These are the ones that look like preferences but are not.

**The domain has no framework in it.** NestJS decorators appear only in `api/`. Every provider is
registered in `app.module.ts` with an explicit token and factory — nothing is constructed by the
framework reflecting on constructor types. That is what lets the whole domain stay decorator-free,
and what lets tests build the same object graph without a container. Follow it: a decorator on a
policy rule would undo the property for everyone.

**Ports for anything external.** `SponsorshipSigner`, `QuotaStore`, `Alerter`, `Tracer`,
`KmsClient`, `PolicyBroadcast`, `LeaderLock`. Adapters implement them; the domain depends on the
interface. The seams are real — the KMS signer, the Redis quota store and the webhook alerter are
all drop-in replacements composed at the root.

**Dependencies are a security property.** This service spends money, so the Prometheus registry, the
JWT implementation, the OTLP tracer and the property-test generator are all hand-rolled rather than
imported. That is a deliberate trade of code for dependency surface, and it is why `npm audit
--omit=dev` runs in CI. Before adding a runtime dependency, ask whether the part you need is fifty
lines.

**Comments explain WHY.** The code says what it does. Comments carry the reasoning that is not
reconstructible from it — why the sponsorship record is written before the attestation is returned,
why quota release is best-effort, why an unsampled span still carries a real trace context. Do not
add comments that restate the line below them.

**Fail closed, and loudly at startup.** Nothing security-relevant has a default. An operator who
forgets the signer key gets a crash at boot, never a silently-generated throwaway key that makes
every sponsorship fail on chain in a way that looks like a contract bug.

---

## Testing

```bash
npm test                                  # everything
npm run test:coverage                     # with coverage
npx vitest run test/policy.test.ts         # one file
npx vitest --workspace @paymaster/backend  # watch
(cd contracts && forge test -vvv)
```

Backend coverage is **82.86% of statements** across 454 tests; the contract is at **100% of lines,
statements, branches and functions**, and CI fails if that drops.

The suite is layered, and the layers are not interchangeable:

| Suite | What it proves |
| --- | --- |
| Unit (`policy`, `jwt`, `metrics`, …) | Logic, in isolation, fast |
| `property.test.ts` | Value handling over thousands of generated inputs — packing, the codec, gas maths, quota windows |
| `differential.test.ts` | Our EIP-712 digest matches the deployed contract's, byte for byte |
| `db` / `redis` | Adapters against a REAL Postgres and Redis — Lua atomicity and int64 behaviour are exactly what a fake would get wrong |
| `api` / `sdk.integration` | The whole vertical slice against a real EntryPoint on anvil |
| `bundler.test.ts` | Against a real rundler, including that an UNSTAKED paymaster is rejected |
| `load.test.ts` | Quota correctness under 200-way concurrency against real Redis |
| `fork.test.ts` | Against a fork of mainnet: the real EntryPoint, real base fees, real state |

**Prefer a real dependency to a fake.** The reason is visible in what these tests catch: an
in-memory quota store cannot exercise the Lua atomicity that stops a quota over-granting under
concurrency, and a hand-written EntryPoint mock cannot tell you that your digest is wrong.

The fork test uses a public RPC by default and takes tens of seconds; set `FORK_TESTS=false` to skip
it locally. It runs in CI, because a skipped test proves nothing.

Writing a test: assert on the property, not the implementation, and put the WHY in the test name or
a comment. `expect(statuses[201]).toBe(50)` says little; the comment explaining that anything above
50 means the quota over-granted under contention says everything.

---

## Adding things

### A policy rule

1. Implement `PolicyRule` in `policy/rules/`. Declare its `cost` — `network` if it makes a chain
   call, so the engine can order evaluation cheapest-first.
2. Register it in `policyFactory.ts` with a Zod schema for its config.
3. **Fail closed.** A rule that cannot evaluate must deny. The rule decides whether to spend money;
   an error is not permission.
4. Test it in `policyFactory.test.ts` (config validation) and `policy.test.ts` (behaviour).

There is no runtime plugin loading, deliberately: untrusted code deciding whether to spend money is
a liability that outweighs the flexibility. The interface is the extension point; a new rule is
compiled in.

### A chain

Configuration only — see [OPERATIONS.md](OPERATIONS.md#chains). If a chain needs a code change,
something has leaked out of `ChainConfig` that belongs in it.

### A metric

Add it to `PaymasterMetrics`, which owns every series so names and labels stay consistent. **Label
only by bounded dimensions** — chain id, rule name, outcome. Never by an address, key or IP: a
caller who can vary a label can exhaust the scraper's memory.

### A migration

Add `backend/migrations/000N_name.sql`. They run in order at boot under a Postgres advisory lock, so
a rolling deploy runs each exactly once. Old and new pods coexist during a roll: migrations must be
backwards-compatible with the previous release.

---

## Before opening a PR

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
(cd contracts && forge fmt --check && forge test && forge coverage --no-match-coverage "(test|script)")
```

CI runs all of it, plus `npm audit --omit=dev --audit-level=high` and the contract coverage gate.

Then check the human parts:

- Does the change need a comment explaining *why*, not what?
- Does it change behaviour an operator would need to know about? [OPERATIONS.md](OPERATIONS.md) or
  [RUNBOOKS.md](RUNBOOKS.md).
- Does it add a failure mode? It needs a metric or an alert, and a runbook entry.
- Does it add an environment variable? `.env.example`, the Helm values, and the schema in
  `config/env.ts` — with a comment saying what breaks if it is wrong.
- Does it touch the signing path, policy evaluation, or anything that moves money? Say so
  explicitly in the PR description, and expect the review to be slower.
