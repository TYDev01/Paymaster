# paymaster Helm chart

Deploys the ERC-4337 sponsorship backend as a horizontally scaled Kubernetes Deployment. The backend
is stateless — PostgreSQL holds durable state, Redis holds quota counters — so replicas are
interchangeable and schema migrations serialise across them via a Postgres advisory lock in the app.
That is why this is a plain `Deployment` with no init-container ordering: starting N replicas at once
under a rolling deploy is safe.

## Prerequisites

- Kubernetes ≥ 1.23, Helm ≥ 3.8
- A reachable PostgreSQL and Redis (this chart does not deploy them; use your managed services or a
  dedicated chart)
- A backend image pushed to a registry your cluster can pull

## Required configuration

Two things have no safe default and must be provided, exactly as the backend itself demands:

1. **`config.chains`** — the `CHAINS` JSON array. See `backend/.env.example`.
2. **A secret** — provide `DATABASE_URL`, a signer (`SPONSORSHIP_SIGNER_KEY` **or**
   `SPONSORSHIP_SIGNER_KMS_KEY_ID`, exactly one), and `BOOTSTRAP_API_KEY`. Optionally `REDIS_URL`
   and `ADMIN_JWT_SECRET`.

### Secrets: bring your own (recommended)

Point the chart at a Secret you manage — ideally synced from a real store (External Secrets, Vault,
SOPS). The chart never mints a secret unless you ask it to.

```bash
kubectl create secret generic paymaster-secrets \
  --from-literal=DATABASE_URL='postgresql://…' \
  --from-literal=REDIS_URL='redis://…' \
  --from-literal=SPONSORSHIP_SIGNER_KMS_KEY_ID='arn:aws:kms:…' \
  --from-literal=BOOTSTRAP_API_KEY='pm_live_…'

helm install paymaster deploy/helm/paymaster \
  --set-file config.chains=chains.json \
  --set secrets.existingSecret=paymaster-secrets \
  --set image.repository=ghcr.io/your-org/paymaster-backend \
  --set image.tag=0.1.0
```

### Secrets: chart-managed (dev only)

`secrets.create=true` writes a Secret from inline values. These land in Helm release history in
plaintext, so this is for throwaway environments only.

## Health, metrics, scaling

- **Liveness** hits `/health/live` (process up); **readiness** hits `/health/ready` (a chain is
  reachable). They are separate on purpose: an RPC outage fails readiness so traffic routes away,
  without failing liveness and restart-looping every pod.
- **`/metrics`** is Prometheus text. Set `serviceMonitor.enabled=true` if the Prometheus Operator is
  installed.
- **HPA**: `autoscaling.enabled=true`. A `PodDisruptionBudget` (on by default) keeps a node drain
  from taking every replica at once.

## Rendering without installing

```bash
helm template paymaster deploy/helm/paymaster --set-file config.chains=chains.json \
  --set secrets.existingSecret=paymaster-secrets | kubectl apply --dry-run=client -f -
```
