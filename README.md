# Self-Hosted ERC-4337 Paymaster + Bundler Platform

A production-oriented, fully self-hosted ERC-4337 (EntryPoint **v0.7**) account-abstraction
platform: a verifying paymaster you own end to end, a sponsorship backend that decides and signs,
and a self-hosted bundler. No dependency on any hosted paymaster or bundler service.

```
Wallet ──▶ SDK ──▶ Bundler (rundler) ──▶ EntryPoint ──▶ EVM chain
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
| [contracts/](contracts/) | Foundry project: `VerifyingPaymaster.sol`, deploy script, 22 tests |
| [backend/](backend/) | NestJS sponsorship + admin API, policy/signature engines, DB, Redis |
| [sdk/](sdk/) | Framework-agnostic TypeScript SDK + runnable example |
| [deploy/](deploy/) | `local-setup.sh` (one-command devnet), rundler chain spec |
| [docker-compose.yml](docker-compose.yml) | Dev stack: postgres, redis, anvil, bundler, backend |
| [docs/](docs/) | Architecture, security, threat model |

## Quickstart (local)

Requires Foundry, Node ≥ 22, PostgreSQL 16, Redis, and the rundler binary.

```bash
# 1. Install deps and fetch the pinned, checksum-verified bundler binary
npm install
npm run bundler:fetch --workspace @paymaster/backend

# 2. Start a local chain and stand up a complete devnet:
#    Multicall3, EntryPoint, factory, a funded + STAKED paymaster, a SimpleAccount, an API key.
anvil &
./deploy/local-setup.sh
set -a && source deploy/.env.local && set +a

# 3. Start the bundler and the backend (see deploy/.env.local for the values)
#    then run the end-to-end example:
cd sdk && npx tsx examples/sponsor-and-send.ts
#    -> success: true; account balance (unchanged, it paid nothing): 0 wei
```

The Docker Compose stack ([docker-compose.yml](docker-compose.yml)) packages the same components;
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#deployment).

## Testing

```bash
# Contracts (Foundry): 22 tests, incl. a full EntryPoint + SimpleAccount flow
cd contracts && forge test

# Backend + SDK: 331 tests, incl. real Postgres, Redis, EntryPoint, and a real bundler.
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
| VerifyingPaymaster contract | ✅ 22 tests, mutation-checked |
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

**Not yet done — required before production:**

- **KMS-backed signer.** The signer key is currently held in process memory; the `SponsorshipSigner`
  port is shaped for a KMS/HSM adapter, which does not exist yet.
- **JWT admin auth**, request signing, circuit breakers, pre-auth IP throttling.
- **Deposit manager** — the chain adapter can read funding, but nothing monitors it on a timer or
  alerts on a low balance yet.
- **Spend-cap reconciliation.** Spend caps charge the worst-case `maxCost`, not actual gas cost
  (which is always lower). Closing this needs a loop reading `UserOperationEvent`.
- **Monitoring** beyond rundler's built-in Prometheus metrics; **Kubernetes/Helm**.
- **ESLint/Prettier** config; **test coverage has not been measured** (do not trust a coverage claim
  that has not been produced).
- **The Docker Compose stack has not been run end-to-end** in this environment (no Docker daemon);
  its individual components all run outside Docker.
- Most of the documentation set (runbooks, disaster recovery, Helm, operator/maintenance guides).

## License

MIT (this project's own code). One licensing consideration to resolve before commercial
distribution: `VerifyingPaymaster` inherits `BasePaymaster` from
[eth-infinitism/account-abstraction](https://github.com/eth-infinitism/account-abstraction), which
is **GPL-3.0**, so the deployed contract is a derivative work under that license. This is common
across ERC-4337 paymasters but is a real obligation, not a footnote — get counsel before shipping.
rundler (Apache-2.0) is run as a separate process, not linked, so it does not carry this concern.
