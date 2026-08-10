# Runbooks

What to do when something is wrong. Alert-triggered procedures are in
[MONITORING.md](MONITORING.md) — each Prometheus rule links to its own entry there. This file covers
the incidents that arrive as a report rather than as an alert: "sponsorship is failing", "we are
spending too much", "a key leaked".

Every runbook starts with the fastest safe containment and then works towards diagnosis, in that
order. When money is moving the wrong way, stop it first and understand it second.

---

## The stop button

**On-chain pause is the only immediate, global control.** It is enforced by the contract itself and
takes effect the moment the transaction lands — no deploy, no config propagation, no cache to wait
out. Everything else in this system (policy edits, key revocation) converges within seconds to
`POLICY_RELOAD_INTERVAL_MS`, which is fast but not instant.

```bash
cast send <paymaster> "pause()" --rpc-url $RPC_URL   # from the owner multisig
```

While paused, `validatePaymasterUserOp` reverts, so no operation can be sponsored on that chain.
In-flight attestations already signed become unusable. Unpause with `unpause()`.

Use it when: the signer key may be compromised, spending is running away, or a policy bug is
sponsoring things it should not. Do not use it for a single misbehaving integrator — revoke their
key instead, which does not affect anyone else.

---

## Sponsorship is failing

Work down this list; each step rules out one layer.

**1. Is it us or one chain?** `curl $URL/health/ready` — it reports per-chain health. One unhealthy
chain is an RPC problem ([MONITORING.md#paymasterchainunhealthy](MONITORING.md#paymasterchainunhealthy));
all chains unhealthy at once is more likely egress or DNS from the pods.

**2. Are we refusing, or erroring?** They need entirely different responses.

```promql
sum by (outcome) (rate(paymaster_sponsorships_total[5m]))
sum by (rule, code) (rate(paymaster_policy_denials_total[5m]))
```

A spike in `denied` with one dominant rule is the system working — a caller is over quota, or a
blocklist matched. A spike in `error` is ours.

**3. If denied by a quota rule:** confirm against the caller's policy. Spend caps charge the
worst-case cost at sponsorship time and the reconciler refunds the difference once operations
settle, so a caller can be refused while their *actual* spend is under the cap. That is
conservative by design. If they need headroom now, raise the cap; do not disable the rule.

**4. If erroring:** the log names the failing component. In order of likelihood —

| Symptom | Cause | Action |
| --- | --- | --- |
| `KmsSigningError` | KMS unreachable, or the role lost `kms:Sign` | Check IAM and KMS availability |
| Database errors | Postgres down or pool exhausted | See "Database is down" below |
| RPC errors, circuit open | Provider degraded | Fail over the chain's RPC URL |
| `no signer configured` at boot | Both or neither signer source set | Fix env; the service refuses to start on purpose |

**5. If the backend looks healthy but operations still fail on chain**, the failure is past us.
Check, in order: is the paymaster paused; is the deposit non-zero; is the stake still registered;
does the bundler accept the operation (rundler returns `-32502` for an unstaked paymaster). An
attestation is only valid for `SPONSORSHIP_VALIDITY_SECONDS` — a client that sits on one for minutes
will submit an expired one.

---

## Spending is running away

**Contain first.** Pause on-chain if the rate is high enough to drain the deposit before you can
diagnose it. Otherwise tighten the global spend cap, which applies immediately on reload:

```bash
curl -X POST $URL/admin/policies -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{...policy with a lower global cap...}'
```

**Then find the source.**

```promql
sum by (chain) (rate(paymaster_gas_committed_wei_total[10m]))
```

and correlate with the sponsorship records, which carry the API key:

```bash
curl "$URL/admin/sponsorships?limit=200" -H "Authorization: Bearer $ADMIN_KEY" | jq \
  'group_by(.apiKeyId) | map({key: .[0].apiKeyId, count: length, wei: (map(.maxCostWei | tonumber) | add)})'
```

One key dominating is either a compromised credential or an integrator's runaway loop — revoke it
and ask. Spend spread evenly across keys is more likely a policy that is too permissive, or a gas
spike making every operation cost more than the caps assumed.

Note that `maxCostWei` in those records is what was COMMITTED, not what was spent. Real cost is
lower. For actual spend, read the deposit on chain.

---

## An API key leaked

1. **Revoke it.** `DELETE /admin/keys/:id`. Revocation is a flag, so the audit history survives.
2. **Assess the damage.** `GET /admin/sponsorships?apiKeyId=<id>` lists everything it committed.
3. **Check whether it was an admin key.** If so, treat every policy and key as potentially modified:
   read `GET /admin/audit` for what that key did, and re-verify the policy set against what you
   expect.
4. **Issue a replacement** and give the integrator the new secret out of band.

A leaked *sponsor* key can spend up to its policy's caps — which is exactly what the caps are for.
A leaked *admin* key can change the caps, so it is a different class of incident.

---

## The signer key may be compromised

This is the worst case: the holder can commit your deposit on every chain simultaneously.

1. **Pause every chain immediately.** From the owner multisig, on each chain.
2. **Add a new signer, then remove the old one** — in that order, so in-flight legitimate
   attestations are not invalidated before their window closes:
   ```bash
   cast send <paymaster> "addSigner(address)" <new> --rpc-url $RPC_URL
   cast send <paymaster> "removeSigner(address)" <old> --rpc-url $RPC_URL
   ```
   If the compromise is confirmed rather than suspected, remove first and accept the breakage.
3. **Point the backend at the new key** (`SPONSORSHIP_SIGNER_KMS_KEY_ID`) and roll the deployment.
4. **Unpause** once the new signer is serving and the old one is gone.
5. **Disable the old KMS key** rather than deleting it, so forensics remain possible.

Revoking a signer invalidates every attestation it issued that is still inside its validity window.
That is the intended trade.

---

## Database is down

Sponsorship FAILS while Postgres is unavailable, deliberately. The sponsorship record is written
before the attestation is returned, and a failure there releases the caller's quota reservation and
surfaces an error. The alternative — signing a commitment to spend money with no record of who asked
or under what policy — is a worse outcome: unbounded and permanent, versus bounded and recoverable.

So: restore Postgres. The service recovers on its own; there is no queue to drain. During the
outage, `/health/ready` fails and traffic sheds.

If the outage will be long and you accept the loss of auditability, you can run without a database
by unsetting `DATABASE_URL` — but API keys will not survive a restart and no sponsorship records are
kept. This is a deliberate, logged degradation, not a normal mode.

---

## Redis is down

Less severe: sponsorship continues, correctness degrades.

- Quota counters become unavailable. Requests fail closed rather than being granted without a check.
- The pre-auth IP throttle cannot count, so it fails open on rate limiting.
- Policy changes stop propagating between replicas; the reload timer still converges them.
- Leadership is lost, so pager delivery stops (the log sink is not gated — alerts are still
  recorded, and log-based alerting is the backstop for exactly this).

Restore Redis. Counters restart from empty, which hands every caller a fresh window's budget: watch
`paymaster_gas_committed_wei_total` for the following window.

---

## A chain's RPC has failed over

`CHAINS` takes a list of `rpcUrls` per chain. Update the config and roll; the circuit breaker closes
itself once reads succeed. Do not restart pods to "clear" an open breaker — it is protecting the
service from a dependency that is still broken, and restarting only hides that.

Verify after the change:

```bash
curl $URL/health/ready | jq '.chains'
```

Block height should advance within a couple of polls. A frozen height with a healthy RPC is a
lagging or forked node — a worse state than an outage, because it looks fine while pricing against
stale data.

---

## Reconciliation has stalled

Symptom: spend counters stay at the worst-case commitment and callers hit caps early.

The reconciler reads `UserOperationEvent`s per chain from a checkpoint, staying
`RECONCILER_CONFIRMATIONS` blocks behind head so a reorg cannot reconcile against an orphaned event.
Check its log for the per-chain checkpoint and whether it is advancing. Common causes: the chain's
RPC does not support `eth_getLogs` over the requested range (lower `RECONCILER_MAX_BLOCK_RANGE`), or
the checkpoint is so far behind that each tick cannot catch up (raise the range, or accept the
backlog — it converges).

Nothing here is lost: reconciliation is a refund of an over-reservation, and un-reconciled
sponsorships stay conservative. Callers are refused early, never over-granted.

---

## Escalation

Stop and get a second person when:

- the signer key may be compromised,
- the deposit is draining faster than you can explain,
- the paymaster's owner is not the multisig you expect,
- an admin key acted in ways nobody can account for.

Every one of those is a "pause first, understand second" situation. Pausing costs an outage.
Not pausing costs the deposit.
