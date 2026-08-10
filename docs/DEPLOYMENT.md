# Production deployment guide

Taking the paymaster from this repository to a chain that spends real money. The local quickstart
is in the [README](../README.md); this is the part that differs when the funds are real.

Read [SECURITY.md](SECURITY.md) first if you have not. Three decisions below are irreversible or
expensive to undo — the signer key's custody, the paymaster's owner, and the unstake delay.

---

## Order of operations

The sequence matters: each step produces something the next one needs, and doing them out of order
produces a paymaster that looks deployed and refuses every operation.

1. **Provision the signing key** (KMS) — its ADDRESS is a constructor argument.
2. **Deploy, fund and stake the contracts**, one command for all chains.
3. **Accept ownership** from the multisig. The deploy is not finished until this happens.
4. **Provision Postgres and Redis**, and run migrations (automatic at boot).
5. **Deploy the backend**, with `CHAINS` naming the addresses from step 2.
6. **Verify the deployment** against the checklist at the end.

---

## 1. The signing key

The paymaster's on-chain validation recovers a signer from every attestation. Whoever holds that key
can commit your deposit to any operation they like, on every chain at once. It is the highest-value
secret in the system.

**Use KMS in production.** `SPONSORSHIP_SIGNER_KEY` (a raw key in the process environment) is the
development path; it is in heap, in the process listing of anything that can read `/proc`, and in
every core dump. Set `SPONSORSHIP_SIGNER_KMS_KEY_ID` instead and the key never enters the process.

```bash
aws kms create-key \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --description "paymaster sponsorship signer"
```

The key spec is not negotiable: `ECC_SECG_P256K1` with `SIGN_VERIFY` is the only combination that
produces signatures the EVM can recover. Grant only `kms:Sign` and `kms:GetPublicKey`, to the
backend's role and nothing else.

Environment validation enforces that exactly one signer source is set. Setting both is rejected at
startup rather than resolved by precedence — an ambiguous signing configuration in a component that
spends money is a misconfiguration, not a preference.

Get the address the key will produce (this is `PAYMASTER_SIGNER` in the next step):

```bash
SPONSORSHIP_SIGNER_KMS_KEY_ID=<key-id> npm run start --workspace @paymaster/backend
# logs: "signer: 0x..."
```

## 2. Deploy the contracts

```bash
cp deploy/chains.example.json deploy/chains.json   # trim to the chains you want
export PAYMASTER_OWNER=0x...        # a MULTISIG. See below.
export PAYMASTER_SIGNER=0x...       # the address from step 1
export ETHERSCAN_API_KEY=...        # without it, deploys are not source-verified
export BASE_RPC_URL=... OPTIMISM_RPC_URL=...   # one env var per chain, named in chains.json

./deploy/deploy-chains.sh --dry-run   # preflights every chain, broadcasts nothing
./deploy/deploy-chains.sh
```

The runner preflights ALL chains before broadcasting to ANY of them — a missing RPC URL on the sixth
chain should not leave you half-deployed across five. It then deploys, deposits, stakes, verifies on
the explorer, and prints the `CHAINS` configuration for what it actually deployed, read back from
the broadcast receipts. It is idempotent: re-running skips chains whose recorded address still has
code.

**The owner should be a multisig.** It can pause sponsorship, rotate signers, and withdraw the
deposit and stake. A single EOA owner means one compromised key drains the paymaster on every chain.

**Ownership is handed over, not assigned.** `addStake` is `onlyOwner`, so the contract is deployed
owned by the deployer, funded, staked, and then offered to `PAYMASTER_OWNER` through `Ownable2Step`.
Until the multisig calls `acceptOwnership()`, the DEPLOYER key still controls the paymaster:

```bash
cast send <paymaster> "acceptOwnership()" --rpc-url $RPC_URL   # from the multisig
```

Treat the deployer key as privileged until every chain is accepted, and verify:

```bash
cast call <paymaster> "owner()(address)" --rpc-url $RPC_URL   # must be the multisig
```

### Stake and deposit

| | What it does | Getting it wrong |
| --- | --- | --- |
| **Deposit** | Pays for sponsored gas | At zero, every operation fails AA31 |
| **Stake** | Permits reading own storage during validation (ERC-7562) | Unstaked, conforming bundlers reject every operation (rundler: -32502) |

The 1 ETH / 1 day defaults match rundler's minimums. **Confirm your bundler's requirements before
deploying** — they are the bundler's policy, not consensus, and other bundlers differ.

The unstake delay is a real commitment: withdrawing stake requires unlocking and then waiting it
out. A long delay is better for reputation and worse for recovering funds; one day is the common
floor.

## 3. Database and Redis

**Postgres** holds API keys, policies, sponsorship records and the audit log. Migrations run at boot
(`DATABASE_MIGRATE_ON_BOOT=true`) and serialise across replicas with a Postgres advisory lock, so a
rolling deploy of N pods runs each migration exactly once. No init container or migration job is
needed — and adding one would be less safe, not more, because it would run outside that lock.

Run it with a real backup schedule and point-in-time recovery. See
[DISASTER-RECOVERY.md](DISASTER-RECOVERY.md) for what is and is not recoverable.

**Redis** is not optional for a multi-replica deployment. Without it:

- quota counters are process-local, so N replicas grant every caller N times their quota;
- policy changes reach only the replica that served the admin request;
- the pre-auth IP throttle is per-pod, so an attacker can dodge it by reconnecting;
- every replica pages independently for the same condition.

The backend warns loudly at startup when `REDIS_URL` is unset. Do not run more than one instance in
that state.

## 4. Deploy the backend

### Helm

```bash
helm upgrade --install paymaster deploy/helm/paymaster \
  --set config.chains="$(cat deploy/chains.env | sed 's/^CHAINS=//')" \
  --set secrets.existingSecret=paymaster-secrets \
  --set serviceMonitor.enabled=true \
  --set prometheusRule.enabled=true \
  --set-file prometheusRule.rulesYaml=deploy/monitoring/prometheus/alerts.yml
```

The chart is documented in [deploy/helm/paymaster/README.md](../deploy/helm/paymaster/README.md).
Note it has NOT been lint-checked in this repository's environment — run `helm lint` and
`helm template` before your first install.

Secrets are bring-your-own by default. `secrets.create: true` puts them in Helm release history in
plaintext and exists for throwaway environments only; use External Secrets, Vault, or SOPS.

The backend is a plain Deployment with no init ordering and no leader requirement to serve traffic.
Liveness (`/health/live`) and readiness (`/health/ready`) are deliberately different endpoints: an
RPC outage must fail readiness, so traffic sheds, without failing liveness, which would restart-loop
every pod and turn a degradation into an outage.

### Required configuration

| Variable | Notes |
| --- | --- |
| `CHAINS` | Generated by the deploy runner. Substitute real RPC URLs — the generated ones are placeholders. |
| `DATABASE_URL` | Required for keys, policies, audit and reconciliation. |
| `REDIS_URL` | Required for more than one replica. |
| `SPONSORSHIP_SIGNER_KMS_KEY_ID` | Or `SPONSORSHIP_SIGNER_KEY` for non-production. Exactly one. |
| `BOOTSTRAP_API_KEY` | Seeds the first admin key. Rotate it after creating real keys. |

Everything else has a documented default in [backend/.env.example](../backend/.env.example). Set
`ADMIN_JWT_SECRET`, `REQUEST_SIGNING_SECRET` and `ALERT_WEBHOOK_URL` before you consider the
deployment finished — each is optional to boot and important in production.

## 5. First keys and policies

The bootstrap key exists to solve the chicken-and-egg of a key-authenticated service with no keys.
Use it once, to mint real keys, then revoke it:

```bash
curl -X POST $URL/admin/keys -H "Authorization: Bearer $BOOTSTRAP_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"integrator-acme","environment":"live","roles":["sponsor"],"policyId":"acme"}'
```

The secret is returned once and never again — only its hash is stored. Create the policy before the
key that pins to it. Policy shapes and rule types are in [OPERATIONS.md](OPERATIONS.md).

**A fresh database has no policies**, and with `DATABASE_URL` set the in-code default set is never
consulted — so the first sponsorship fails with "no policy with id default" until you create one.
Either create it through the admin API (the production path: the policy that decides what to sponsor
should be deliberate), or set `BOOTSTRAP_DEFAULT_POLICY=true` for a non-production environment,
which seeds the bounded default policy into an empty policy table and never touches a non-empty one.

A revoked bootstrap key stays revoked across restarts: its row id is derived from the key's hash, so
re-deploying with the same `BOOTSTRAP_API_KEY` does not resurrect it. Rotating means setting a new
one.

---

## Deployment checklist

Contracts:

- [ ] `owner()` is the multisig on every chain (ownership accepted, not just offered)
- [ ] `getDepositInfo(paymaster).staked` is true, with the delay your bundler requires
- [ ] Deposit funded, and above the `minDepositWei` in `CHAINS`
- [ ] Source verified on every explorer (`./deploy/verify-contracts.sh`)
- [ ] `signerCount() == 1` and the signer is the KMS key's address

Backend:

- [ ] `SPONSORSHIP_SIGNER_KMS_KEY_ID` set; `SPONSORSHIP_SIGNER_KEY` NOT set
- [ ] `DATABASE_URL` and `REDIS_URL` set; no "quotas are process-local" warning in the logs
- [ ] `/health/ready` returns 200 and lists every chain as healthy
- [ ] `/metrics` is scraped; alert rules loaded; `ALERT_WEBHOOK_URL` set and TESTED
- [ ] Bootstrap key revoked after real keys exist
- [ ] `ADMIN_JWT_SECRET` and `REQUEST_SIGNING_SECRET` set
- [ ] Postgres backups running and a restore has actually been rehearsed

End to end:

- [ ] One sponsored operation submitted through a real bundler on each chain
- [ ] The paymaster's deposit decreased and the account's balance did not
- [ ] The sponsorship appears in `GET /admin/sponsorships`
- [ ] A deliberately over-quota request returns 429, not 500

The last one matters more than it looks: it is the difference between a caller knowing they were
refused and not knowing whether they were charged.
