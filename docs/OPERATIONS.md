# Operator guide

Day-to-day operation: managing policies and keys, onboarding chains and integrators, and the routine
maintenance that keeps the paymaster funded and current.

Incidents are in [RUNBOOKS.md](RUNBOOKS.md). Alerts are in [MONITORING.md](MONITORING.md). First
deployment is in [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Authenticating

Two credentials, same guard, disambiguated by shape.

**API keys** (`pm_live_…` / `pm_test_…`) are long-lived and belong to an integrator or an operator.
**Session tokens** are short-lived JWTs for interactive admin work — you exchange a key for one and
it carries the caller's OWN roles, never more:

```bash
TOKEN=$(curl -sX POST $URL/admin/auth/token -H "Authorization: Bearer $ADMIN_KEY" | jq -r .token)
curl $URL/admin/policies -H "Authorization: Bearer $TOKEN"
```

Available only when `ADMIN_JWT_SECRET` is set; the endpoint returns 503 otherwise. Prefer sessions
for anything interactive — a session leaked from a shell history expires on its own.

Roles carry permissions; checks are on permissions, never on roles:

| Role | Can |
| --- | --- |
| `sponsor` | Request sponsorship |
| `viewer` | Read policies, keys, sponsorships, audit |
| `admin` | Everything, including writing policies and minting keys |

---

## Policies

A policy is an ordered set of rules. Every rule must allow; the first denial refuses the request and
names itself, which is what makes a denial diagnosable.

```bash
curl -X POST $URL/admin/policies -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "id": "acme",
    "name": "Acme Wallet",
    "enabled": true,
    "rules": [
      {"ruleType": "chain-enabled", "config": {"chainIds": [8453, 10]}},
      {"ruleType": "sender-blocklist", "config": {"addresses": []}},
      {"ruleType": "quota", "config": {"name": "acme-wallet-daily", "subject": "wallet",
        "unit": "operations", "limit": 100, "windowSeconds": 86400}},
      {"ruleType": "quota", "config": {"name": "acme-global-daily", "subject": "global",
        "unit": "wei", "limit": "500000000000000000", "windowSeconds": 86400}}
    ]
  }'
```

Writes are validated before they are stored — a rule whose config cannot build is rejected, so the
policy set in the database is always loadable. The write then reloads this replica and announces the
change to the others.

**Order rules cheapest-first.** Rules have a declared cost, and a `network` rule (`token-ownership`
reads `balanceOf` over RPC) should sit behind the cheap ones so an obvious denial never pays for a
chain call.

**Always include a global spend cap.** Per-wallet and per-key caps bound individual callers; only a
global cap bounds the total. Without one, a policy with many callers has no ceiling.

**Deleting a policy that an API key pins to is refused** (409). Repoint the key first. That
restriction exists because a key whose pinned policy vanished would otherwise fall back to naming
any policy it liked.

Reload every replica now, rather than waiting for the timer:

```bash
curl -X POST $URL/admin/policies/reload -H "Authorization: Bearer $TOKEN"
```

### Propagation and its limits

Policy changes converge across replicas within `POLICY_RELOAD_INTERVAL_MS` (default 30s), and within
milliseconds when Redis is available to carry the announcement. A failed reload leaves the previous
set in place — serving a slightly stale policy beats a paymaster that stops sponsoring because the
database blipped.

Note the asymmetry, because it cuts the wrong way for revocation: **a blocklist addition does not
take effect until a reload succeeds.** For urgent revocation, pause on chain — that is immediate.

---

## API keys

```bash
# Mint. The secret is returned ONCE and never again; only its hash is stored.
curl -X POST $URL/admin/keys -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"acme-production","environment":"live","roles":["sponsor"],"policyId":"acme"}'

curl $URL/admin/keys -H "Authorization: Bearer $TOKEN"          # list (prefixes only)
curl -X DELETE $URL/admin/keys/<id> -H "Authorization: Bearer $TOKEN"   # revoke
```

Pin integrator keys to a policy (`policyId`). An unpinned key may name any policy in its request,
which is right for your own keys and wrong for someone else's.

**Rotation, without an outage:** mint the replacement, hand it over, confirm traffic has moved
(`GET /admin/sponsorships?apiKeyId=…`), then revoke the old one. Revocation is a flag, so history
survives and the audit trail stays intact.

Set `expiresAt` on anything temporary. An expiry that arrives on its own is worth more than a
reminder to revoke something later.

---

## Chains

Onboarding a chain is configuration plus a deploy — the canonical EntryPoint v0.7 is at the same
address on every supported chain, which is what makes this true.

1. Add it to `deploy/chains.json`.
2. `./deploy/deploy-chains.sh --chains <id>` — deploys, funds, stakes, verifies.
3. Accept ownership from the multisig.
4. Add the generated entry to `CHAINS` and roll the backend.
5. Add the chain to the policies that should serve it (`chain-enabled`).

At startup the registry asserts every RPC serves the chain its config claims, before accepting
traffic. A mismatch there would make every sponsorship on that chain fail with an opaque AA34, so it
is a startup failure instead.

**Disabling a chain** is `enabled: false` plus a roll. There is no admin endpoint for it — chains
are env config, deliberately, because enabling one requires a deployed and staked paymaster on it,
which is not something an API call can arrange.

---

## Funding

The deposit pays for sponsored gas and is the thing that runs out.

```bash
cast call <paymaster> "getDeposit()(uint256)" --rpc-url $RPC_URL
cast send <paymaster> "deposit()" --value 1ether --rpc-url $RPC_URL   # anyone may refill
cast send <paymaster> --value 1ether --rpc-url $RPC_URL               # a bare send works too
```

Refilling is deliberately not owner-gated, so an automated top-up can run under a key that is not
the owner's. Bare transfers are forwarded to the deposit rather than sitting on the contract.

`minDepositWei` in `CHAINS` is what the funding monitor alerts against. Set it to cover more than
the time it takes you to notice and act — a threshold that fires with twenty minutes of runway is a
threshold that fires during the night for nothing, or too late.

**Withdrawing stake is slow by design.** `unlockStake()`, wait out the unstake delay, then
`withdrawStake(address)`. Plan exits; you cannot do this quickly.

---

## Routine maintenance

### Weekly

- Deposit runway per chain: at the current burn rate, how long? (`predict_linear` on
  `paymaster_deposit_wei` is the same question the alert asks.)
- Denial rates by rule — a rule denying steadily is either an integrator with a problem or a policy
  that no longer matches reality.
- Audit log for admin writes nobody remembers making.

### Monthly

- Rotate any key older than your policy allows.
- Re-verify `owner()` is the expected multisig on every chain. Cheap, and the one silent change that
  would be catastrophic.
- Confirm a Postgres restore actually works — see [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md).
- Check `npm audit --omit=dev` and Foundry/dependency updates.

### Quarterly

- Rotate the sponsorship signer: add the new signer, roll the backend, remove the old one once its
  attestations have expired. Rehearsing this when nothing is wrong is what makes it usable when
  something is.
- Rehearse the multisig: execute `pause()`/`unpause()` on a low-traffic chain.
- Re-tune the alert thresholds marked `TUNE` against the traffic you now actually have.

### Upgrades

**Backend** is a rolling deploy. Migrations self-serialise under a Postgres advisory lock, so N pods
run each migration exactly once; no init container, no migration job. Old and new pods coexist
during the roll, so migrations must be backwards-compatible with the previous version — add columns,
do not rename them in the same release.

**Contracts are not upgradeable.** There is no proxy: an upgradeable paymaster means whoever can
upgrade it can redirect the deposit, and that trade is not worth it here. A new version is a new
deployment — deploy, fund, stake, accept ownership, switch `CHAINS`, then drain the old one's
deposit once its outstanding attestations have expired.

---

## Reading the sponsorship records

```bash
curl "$URL/admin/sponsorships?chainId=8453&limit=50" -H "Authorization: Bearer $TOKEN"
```

`maxCostWei` is what was **committed**, not spent. Real cost is always lower, and the reconciler
trues the quota counters (not these rows) up to actual on-chain cost once operations settle. Reading
these as a spend figure overstates it — for actual spend, read the deposit on chain.

The audit log (`GET /admin/audit`) records every administrative mutation, after it succeeded, with
the actor. Secrets are redacted before they are written.
