# Disaster recovery

What survives what, how to get back, and — the part most DR documents skip — what is genuinely
unrecoverable, so nobody spends an outage looking for a backup that was never possible.

---

## What the state actually is

Recovery is easy to reason about here because the service is stateless and the durable state is
small and unequal in value.

| Where | Holds | If lost |
| --- | --- | --- |
| **Chain** | Deposit, stake, owner, authorised signers, pause flag | Not recoverable by us. It is the chain's state; it survives everything else. |
| **KMS** | The sponsorship signing key | The paymaster cannot sign. Recoverable only by authorising a new signer on chain. |
| **Postgres** | API keys, policies, sponsorship records, audit log, reconciliation checkpoints | Recoverable from backup. Keys and audit are the parts that hurt. |
| **Redis** | Quota counters, IP throttle counters, leadership | Not backed up, and should not be. Rebuilds from empty. |
| **Backend pods** | Nothing | Replaceable. This is the point of the design. |

The ordering matters: chain state is the most valuable and the least at risk; the pods hold nothing
and can be destroyed freely.

---

## Objectives

| | Target | Bounded by |
| --- | --- | --- |
| **RTO** | < 30 min | Postgres restore time |
| **RPO** | < 5 min | Postgres PITR / WAL shipping interval |

Redis has no RPO: it is deliberately not part of the recovery point, because its contents are a
window's quota counters, not a record of anything.

---

## Backups

**Postgres is the only thing to back up.** Take base backups plus continuous WAL archiving (managed
services: enable PITR). Nothing else in the system requires a backup schedule.

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > paymaster-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Encrypt them. The dump contains API key HASHES (not secrets — the secret is never stored) and the
full audit log, which is a map of who operates the system.

**Rehearse the restore.** An unrehearsed backup is a hypothesis. Restore into a scratch database and
check that migrations report no pending work and that key and policy counts match production:

```bash
pg_restore --dbname "$SCRATCH_URL" --no-owner paymaster-....dump
psql "$SCRATCH_URL" -c "select count(*) from api_keys; select count(*) from policies;"
```

**Back up `deploy/deployments.json`** — not for recovery of funds, but because it records which
address on which chain is yours, with the owner and signer it was deployed with. It is
reconstructible from block explorers; having it saves an unpleasant hour.

**Redis is deliberately not backed up.** Its AOF in the compose stack exists so a restart does not
hand every caller a fresh quota at once — a spend event, not a data-loss event. Restoring an old
Redis snapshot would restore *stale* counters, which is worse than empty ones.

---

## Scenarios

### Backend pods lost

Nothing to recover. Redeploy. The pods hold no state; migrations self-serialise; the service
reconnects to Postgres and Redis and resumes.

Quota counters in Redis survive the pods, so callers are not handed fresh budgets.

### Postgres lost, backup good

1. Stop the backend (or let readiness fail — it will shed traffic on its own).
2. Restore to the latest PITR point.
3. Start the backend. Migrations run and find nothing pending.
4. Verify: `GET /admin/keys` and `GET /admin/policies` return what you expect.

**What is lost between the last WAL and the failure:** sponsorship records and audit entries for
that window. Attestations issued in that window are still valid on chain and can still be spent —
you simply have no local record of having issued them. Reconcile from chain if it matters:
`UserOperationEvent` logs with your paymaster address are the ground truth.

The reconciliation checkpoints roll back with the restore, so the reconciler re-scans a window it
has already processed. That is safe: it claims each sponsorship row atomically, so a replay refunds
nothing twice.

### Postgres lost, no usable backup

Everything below is a real loss; there is no clever recovery.

- **API keys are gone.** Only hashes were ever stored, so they cannot be reconstructed even in
  principle. Every integrator needs a new key, distributed out of band.
- **Policies are gone.** Rebuild them from your configuration repository — which is the argument for
  keeping policy definitions in version control and applying them through the admin API, rather than
  treating the database as their only home.
- **Audit log is gone.** Unrecoverable.
- **Sponsorship records are gone**, but the chain has the events.

Bring the service up with `BOOTSTRAP_API_KEY` set, mint fresh keys, re-apply policies, revoke the
bootstrap key.

### Redis lost

Nothing to restore. Counters restart from empty, which means every caller gets a fresh window's
budget at once — watch spend for the following window, and consider pausing if the deposit is
already low.

### KMS key lost or inaccessible

The paymaster cannot sign. It is still funded and staked; it simply cannot authorise anything.

1. Provision a new KMS key and get its address.
2. From the owner multisig, on every chain: `addSigner(<new address>)`.
3. Point the backend at the new key and roll.
4. `removeSigner(<old address>)` once the old key's outstanding attestations have expired.

If the old key is compromised rather than merely lost, follow
[RUNBOOKS.md](RUNBOOKS.md#the-signer-key-may-be-compromised) instead: pause first.

### Owner multisig lost

**The one truly unrecoverable failure.** No owner means no pause, no signer rotation, and no
withdrawal of the deposit or stake, permanently. The funds are stranded and the contract is frozen
in whatever state it was in.

There is no recovery path, only prevention:

- a real multisig with a threshold and multiple independent signers,
- signers held by different people, in different places,
- the recovery procedure rehearsed at least once.

Test the multisig can execute a trivial owner call (`pause()`/`unpause()`) at deployment time, and
periodically. A multisig nobody has ever used is a multisig nobody knows is broken.

### A chain is permanently unavailable

Set `enabled: false` for it in `CHAINS` and roll. The service continues serving every other chain —
per-chain isolation is why the registry treats chains independently.

The deposit and stake on that chain are stranded until it returns. If it returns and you are exiting
it, unlock the stake, wait out the unstake delay, then withdraw stake and deposit.

---

## After any recovery

- [ ] `/health/ready` returns 200 with every expected chain healthy
- [ ] One sponsored operation succeeds end to end, per chain
- [ ] Deposit and stake are intact on chain (`getDepositInfo`)
- [ ] `owner()` is still the multisig you expect — check even when ownership was not involved
- [ ] Metrics are being scraped and alerts can actually deliver (send a test alert)
- [ ] Quota counters behave: a request over a small test cap returns 429
- [ ] Backups are running again, and the next one has been verified

The `owner()` check is on the list deliberately. It is cheap, and it is the one piece of state whose
silent change would be catastrophic and otherwise invisible.
