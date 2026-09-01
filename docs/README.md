# Documentation

A self-hosted ERC-4337 paymaster and bundler: a verifying paymaster you own, a backend that decides
and signs sponsorships, and a bundler on your own infrastructure.

These documents have **two different audiences**, and mixing them up is the fastest way to read the
wrong page for twenty minutes. Almost everything here is written for the operator — the person
running the platform. Exactly one document is written for the customer.

## If you are integrating with a paymaster someone else runs

**[INTEGRATION.md](INTEGRATION.md)** — the only page you need. Sign up, fund a balance, mint a key,
call the SDK from your server, and the errors you will hit when something is wrong.

## If you are running the platform

Start here, in this order:

| Document | What it answers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit, and why the boundaries fall where they do |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Getting a working stack locally, running the tests, the layout |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploying contracts and the stack to a real chain |
| [OPERATIONS.md](OPERATIONS.md) | Day to day: policies, keys, onboarding chains and integrators |
| [SECURITY.md](SECURITY.md) | Threat model, trust boundaries, what an attacker can and cannot do |
| [MONITORING.md](MONITORING.md) | Metrics, alerts and tracing — what to watch and what it means |
| [RUNBOOKS.md](RUNBOOKS.md) | Named procedures for things that have gone wrong before |
| [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md) | Backups, restores, and losing a signer |
| [REMAINING.md](REMAINING.md) | Known gaps and planned work. A working document, not a spec |

## The five things that surprise people

Collected here because each one cost real debugging time, and each fails in a place that points
away from its cause.

**A paymaster must be STAKED, not merely funded.** The deposit pays for gas; the stake is what makes
a bundler willing to look at the paymaster at all, because both contracts read their own storage
during validation and ERC-7562 only permits that for a staked entity. An unstaked paymaster is not
"less safe", it is inert — rundler rejects every operation with `-32502` before anything reaches the
chain. See [DEPLOYMENT.md](DEPLOYMENT.md).

**The bundler needs an RPC that runs custom JavaScript tracers.** Safe-mode validation calls
`debug_traceCall` with a JS tracer, which Alchemy and Infura do not serve at any price — they
answer `-32600 invalid tracer value` — and free public endpoints do not serve `debug_*` at all.
QuickNode, Chainstack and a self-hosted geth/reth do. Check before committing to a provider:

```bash
./deploy/check-rpc.sh https://your-endpoint
```

The stack splits its RPC traffic by method so this scarce endpoint is only used for the ~3 calls per
operation that need it, rather than the ~369 that do not. See the README's RPC router section.

**`paymasterKind` must match the deployed contract.** `VerifyingPaymaster` and `TenantPaymaster`
use different EIP-712 domains and different `paymasterAndData` layouts, so their signatures are not
interchangeable. A mismatch is not a startup error; it is an on-chain `AA34` on every sponsorship.

**Policies are resolved per tenant.** `SponsorService` looks up the policy inside the *caller's*
tenant, deliberately, so one customer can never be served another's rules. A tenant with no policy
therefore cannot sponsor anything — which is why signup provisions one.

**Failed sponsorships consume quota.** A sponsorship reserves `maxCost` against the wallet's quota
when it is signed, and the reconciler only corrects that from a receipt once the operation *lands*.
Operations that are signed and never submitted leak their reservation permanently. This bites hard
while debugging: a wallet can exhaust a daily quota without a single success. See
[DEVELOPMENT.md](DEVELOPMENT.md).

## Where the source of truth is

Documentation drifts; these do not.

- **What is deployed** — `contracts/broadcast/<script>/<chainId>/run-latest.json`, written by the
  deploy itself. `./start.sh` reads the paymaster address from here rather than from anything typed.
- **What the backend is serving** — `GET /health/ready` reports every configured chain, its block
  height, and whether it is healthy.
- **What a policy actually allows** — the `policies` and `policy_rules` tables, per tenant. The
  dashboard and this documentation both describe them; only the rows decide.
