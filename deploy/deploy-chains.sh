#!/usr/bin/env bash
#
# Deploys, funds, stakes and VERIFIES the paymaster on every configured chain, from one command,
# then prints the backend's CHAINS configuration for exactly what it deployed.
#
# The last part is the point. Deploying to six chains by hand means transcribing six addresses into
# a JSON blob, and a single transposed character there produces a paymaster that signs attestations
# for a contract that is not ours — which fails on-chain, per operation, with an opaque AA34. The
# config is generated from the broadcast receipts instead, so it cannot disagree with what is on
# chain.
#
# Properties worth knowing before you run it:
#
#   * IDEMPOTENT. A chain whose recorded address still has code is skipped. Re-running after a
#     partial failure resumes; it does not redeploy what succeeded. FORCE=1 overrides.
#   * PREFLIGHTS EVERY CHAIN FIRST. All checks for all chains run before the first broadcast, so a
#     missing RPC URL on the sixth chain does not leave you half-deployed across five.
#   * FAILS SOFT PER CHAIN. After preflight, a chain that fails to deploy is recorded and the run
#     continues; the summary names it. One unreachable RPC should not block five good deployments.
#   * VERIFICATION IS BEST-EFFORT. An explorer being down is not a reason to fail a deploy that
#     already succeeded on chain. Unverified chains are listed at the end, and
#     deploy/verify-contracts.sh re-runs verification alone.
#
# Usage:
#   PAYMASTER_OWNER=0x...        # multisig in production
#   PAYMASTER_SIGNER=0x...       # the sponsorship signer's ADDRESS (KMS key's address in production)
#   DEPLOYER_KEY=0x...           # or DEPLOYER_ACCOUNT=<cast wallet account>, or LEDGER=1
#   ETHERSCAN_API_KEY=...        # optional; without it, deploys are not verified
#   ./deploy/deploy-chains.sh [--dry-run] [--chains 8453,10]
#
# Chain list: deploy/chains.json (copy deploy/chains.example.json). Each entry names the ENV VAR
# holding its RPC URL rather than the URL itself — RPC URLs usually carry an API key, and a file
# full of credentials is a file that ends up committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAINS_FILE="${CHAINS_FILE:-${ROOT}/deploy/chains.json}"
DEPLOYMENTS_FILE="${DEPLOYMENTS_FILE:-${ROOT}/deploy/deployments.json}"
CANONICAL_ENTRYPOINT="0x0000000071727De22E5E9d8BAf0edAc6f37da032"

DRY_RUN=0
ONLY_CHAINS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --chains) ONLY_CHAINS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mfail\033[0m %s\n' "$*" >&2; exit 1; }

for tool in forge cast jq; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required but not installed"
done

[ -f "${CHAINS_FILE}" ] || fail "no chain list at ${CHAINS_FILE} (copy deploy/chains.example.json)"
[ -n "${PAYMASTER_OWNER:-}" ] || fail "PAYMASTER_OWNER is required (use a multisig in production)"
[ -n "${PAYMASTER_SIGNER:-}" ] || fail "PAYMASTER_SIGNER is required (the sponsorship signer's address)"

# One of three signing methods, and exactly one. Ambiguity about which key is deploying a contract
# that will hold funds is not something to resolve by precedence.
SIGNING_ARGS=()
signing_sources=0
if [ -n "${DEPLOYER_KEY:-}" ]; then SIGNING_ARGS=(--private-key "${DEPLOYER_KEY}"); signing_sources=$((signing_sources + 1)); fi
if [ -n "${DEPLOYER_ACCOUNT:-}" ]; then SIGNING_ARGS=(--account "${DEPLOYER_ACCOUNT}"); signing_sources=$((signing_sources + 1)); fi
if [ "${LEDGER:-0}" = "1" ]; then SIGNING_ARGS=(--ledger); signing_sources=$((signing_sources + 1)); fi
[ "${signing_sources}" -eq 1 ] || fail "set exactly one of DEPLOYER_KEY, DEPLOYER_ACCOUNT or LEDGER=1 (found ${signing_sources})"

[ -f "${DEPLOYMENTS_FILE}" ] || echo '{"deployments":[]}' > "${DEPLOYMENTS_FILE}"

# ------------------------------------------------------------------------------------------------
# Selection
# ------------------------------------------------------------------------------------------------
selected="$(jq -c '.' "${CHAINS_FILE}")"
if [ -n "${ONLY_CHAINS}" ]; then
  selected="$(jq -c --arg ids "${ONLY_CHAINS}" \
    '[.[] | select(([$ids | split(",") | .[] | tonumber]) | index(.chainId))]' "${CHAINS_FILE}")"
fi
chain_count="$(echo "${selected}" | jq 'length')"
[ "${chain_count}" -gt 0 ] || fail "no chains selected"

log "${chain_count} chain(s) selected from ${CHAINS_FILE}"

# ------------------------------------------------------------------------------------------------
# Preflight — every chain, before any broadcast
#
# Each check here corresponds to a failure that is expensive or confusing later: a wrong EntryPoint
# makes every sponsorship revert AA34; an underfunded deployer strands a deploy after the contract
# exists but before it is staked; a chain-id mismatch means the RPC is not the chain you think.
# ------------------------------------------------------------------------------------------------
declare -A RPC_URLS=()
preflight_failed=0

for i in $(seq 0 $((chain_count - 1))); do
  entry="$(echo "${selected}" | jq -c ".[${i}]")"
  chain_id="$(echo "${entry}" | jq -r '.chainId')"
  name="$(echo "${entry}" | jq -r '.name')"
  rpc_env="$(echo "${entry}" | jq -r '.rpcUrlEnv // empty')"
  rpc_url="$(echo "${entry}" | jq -r '.rpcUrl // empty')"
  [ -n "${rpc_env}" ] && rpc_url="${!rpc_env:-}"

  if [ -z "${rpc_url}" ]; then
    warn "${name} (${chain_id}): no RPC URL — set \$${rpc_env:-rpcUrl in the chain file}"
    preflight_failed=1
    continue
  fi

  actual_chain_id="$(cast chain-id --rpc-url "${rpc_url}" 2>/dev/null || true)"
  if [ "${actual_chain_id}" != "${chain_id}" ]; then
    warn "${name}: RPC reports chain ${actual_chain_id:-<unreachable>}, config says ${chain_id}"
    preflight_failed=1
    continue
  fi

  if [ "$(cast code "${CANONICAL_ENTRYPOINT}" --rpc-url "${rpc_url}")" = "0x" ]; then
    warn "${name}: no EntryPoint v0.7 at ${CANONICAL_ENTRYPOINT} — this chain is not supported yet"
    preflight_failed=1
    continue
  fi

  deposit="$(echo "${entry}" | jq -r '.depositWei // "1000000000000000000"')"
  stake="$(echo "${entry}" | jq -r '.stakeWei // "1000000000000000000"')"
  # Which paymaster contract this chain runs. Defaults to the single-tenant one, so a chains file
  # written before multi-tenancy existed keeps deploying exactly what it did before.
  kind="$(echo "${entry}" | jq -r '.paymasterKind // "verifying"')"
  case "${kind}" in
    verifying|tenant) ;;
    *) fail "${name}: paymasterKind must be \"verifying\" or \"tenant\", got \"${kind}\"" ;;
  esac
  required="$(python3 -c "print(int('${deposit}') + int('${stake}'))")"

  if [ "${DRY_RUN}" -eq 0 ] && [ "${LEDGER:-0}" != "1" ] && [ -n "${DEPLOYER_KEY:-}" ]; then
    deployer="$(cast wallet address --private-key "${DEPLOYER_KEY}")"
    balance="$(cast balance "${deployer}" --rpc-url "${rpc_url}")"
    if [ "$(python3 -c "print(1 if int('${balance}') < int('${required}') else 0)")" = "1" ]; then
      warn "${name}: deployer ${deployer} holds ${balance} wei, needs at least ${required} (deposit+stake, before gas)"
      preflight_failed=1
      continue
    fi
  fi

  RPC_URLS["${chain_id}"]="${rpc_url}"
  log "${name} (${chain_id}): preflight ok"
done

[ "${preflight_failed}" -eq 0 ] || fail "preflight failed; nothing was deployed"

if [ "${DRY_RUN}" -eq 1 ]; then
  log "dry run: every selected chain passed preflight. Re-run without --dry-run to deploy."
  exit 0
fi

# ------------------------------------------------------------------------------------------------
# Deploy
# ------------------------------------------------------------------------------------------------
deployed_ok=()
deploy_failed=()
unverified=()

for i in $(seq 0 $((chain_count - 1))); do
  entry="$(echo "${selected}" | jq -c ".[${i}]")"
  chain_id="$(echo "${entry}" | jq -r '.chainId')"
  name="$(echo "${entry}" | jq -r '.name')"
  rpc_url="${RPC_URLS[${chain_id}]}"

  existing="$(jq -r --argjson id "${chain_id}" \
    '.deployments[] | select(.chainId == $id) | .paymaster' "${DEPLOYMENTS_FILE}")"
  if [ -n "${existing}" ] && [ "${FORCE:-0}" != "1" ]; then
    if [ "$(cast code "${existing}" --rpc-url "${rpc_url}")" != "0x" ]; then
      log "${name}: already deployed at ${existing} — skipping (FORCE=1 to redeploy)"
      deployed_ok+=("${chain_id}")
      continue
    fi
    warn "${name}: recorded address ${existing} has no code; redeploying"
  fi

  log "${name} (${chain_id}): deploying"

  verify_args=()
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    verify_args=(--verify --etherscan-api-key "${ETHERSCAN_API_KEY}")
    verifier_url="$(echo "${entry}" | jq -r '.verifierUrl // empty')"
    [ -n "${verifier_url}" ] && verify_args+=(--verifier-url "${verifier_url}")
  else
    warn "${name}: ETHERSCAN_API_KEY not set — deploying WITHOUT source verification"
  fi

  set +e
  ( cd "${ROOT}/contracts" && \
    ENTRYPOINT="${CANONICAL_ENTRYPOINT}" \
    PAYMASTER_OWNER="${PAYMASTER_OWNER}" \
    PAYMASTER_SIGNER="${PAYMASTER_SIGNER}" \
    PAYMASTER_KIND="$(echo "${entry}" | jq -r '.paymasterKind // "verifying"')" \
    DEPOSIT_WEI="$(echo "${entry}" | jq -r '.depositWei // "1000000000000000000"')" \
    STAKE_WEI="$(echo "${entry}" | jq -r '.stakeWei // "1000000000000000000"')" \
    UNSTAKE_DELAY_SEC="$(echo "${entry}" | jq -r '.unstakeDelaySec // 86400')" \
    forge script script/DeployPaymaster.s.sol:DeployPaymaster \
      --rpc-url "${rpc_url}" \
      --broadcast \
      --slow \
      "${SIGNING_ARGS[@]}" \
      "${verify_args[@]}" )
  deploy_status=$?
  set -e

  # The broadcast receipt is the source of truth for the address, not the script's stdout: forge
  # writes it after the transaction is mined, so reading it here cannot report a contract that was
  # never actually created.
  broadcast="${ROOT}/contracts/broadcast/DeployPaymaster.s.sol/${chain_id}/run-latest.json"
  kind="$(echo "${entry}" | jq -r '.paymasterKind // "verifying"')"
  # Matched on the contract the chain asked for. Hardcoding VerifyingPaymaster here would report a
  # perfectly good multi-tenant deploy as a failure, after the money had already been staked.
  case "${kind}" in
    tenant) contract_name="TenantPaymaster" ;;
    *) contract_name="VerifyingPaymaster" ;;
  esac
  paymaster=""
  [ -f "${broadcast}" ] && paymaster="$(jq -r --arg contract "${contract_name}" \
    '[.transactions[] | select(.transactionType == "CREATE" and (.contractName == $contract)) | .contractAddress] | last // empty' \
    "${broadcast}")"

  if [ "${deploy_status}" -ne 0 ] || [ -z "${paymaster}" ]; then
    warn "${name}: deploy failed (exit ${deploy_status})"
    deploy_failed+=("${name} (${chain_id})")
    continue
  fi

  # A non-zero exit with a deployed address means the deploy landed and only verification failed.
  [ "${deploy_status}" -eq 0 ] || unverified+=("${name} (${chain_id})")
  [ -n "${ETHERSCAN_API_KEY:-}" ] || unverified+=("${name} (${chain_id})")

  block="$(cast block-number --rpc-url "${rpc_url}")"
  tmp="$(mktemp)"
  jq --argjson id "${chain_id}" \
     --arg name "${name}" \
     --arg paymaster "${paymaster}" \
     --arg entryPoint "${CANONICAL_ENTRYPOINT}" \
     --arg owner "${PAYMASTER_OWNER}" \
     --arg signer "${PAYMASTER_SIGNER}" \
     --arg kind "${kind}" \
     --argjson block "${block}" \
     --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.deployments = ((.deployments | map(select(.chainId != $id))) + [{
        chainId: $id, name: $name, paymaster: $paymaster, paymasterKind: $kind,
        entryPoint: $entryPoint, owner: $owner, signer: $signer,
        deployedAtBlock: $block, deployedAt: $at
      }] | sort_by(.chainId))' "${DEPLOYMENTS_FILE}" > "${tmp}"
  mv "${tmp}" "${DEPLOYMENTS_FILE}"

  log "${name}: ${contract_name} deployed at ${paymaster} (block ${block})"
  deployed_ok+=("${chain_id}")
done

# ------------------------------------------------------------------------------------------------
# Summary, and the backend configuration for what actually exists on chain
# ------------------------------------------------------------------------------------------------
echo
log "deployed/verified on ${#deployed_ok[@]} chain(s)"
if [ "${#deploy_failed[@]}" -gt 0 ]; then
  warn "failed: ${deploy_failed[*]}"
fi
if [ "${#unverified[@]}" -gt 0 ]; then
  warn "not source-verified: ${unverified[*]} — run ./deploy/verify-contracts.sh"
fi

echo
log "CHAINS for the backend (deploy/chains.env):"
chains_json="$(jq -c --slurpfile chains "${CHAINS_FILE}" '
  [ .deployments[] as $d
    | ($chains[0][] | select(.chainId == $d.chainId)) as $c
    | {
        chainId: $d.chainId,
        name: $c.name,
        rpcUrls: ["${" + ($c.rpcUrlEnv // "RPC_URL") + "}"],
        entryPoint: $d.entryPoint,
        paymaster: $d.paymaster,
        paymasterKind: ($d.paymasterKind // "verifying"),
        explorerUrl: $c.explorerUrl,
        nativeCurrency: $c.nativeCurrency,
        minDepositWei: ($c.minDepositWei // "0"),
        minStakeWei: ($c.minStakeWei // "0"),
        enabled: true
      } ]' "${DEPLOYMENTS_FILE}")"

printf 'CHAINS=%s\n' "'${chains_json}'" | tee "${ROOT}/deploy/chains.env"
echo
log "rpcUrls are placeholders: substitute the real URLs (they carry API keys) before use."

[ "${#deploy_failed[@]}" -eq 0 ] || exit 1
