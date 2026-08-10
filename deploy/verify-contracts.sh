#!/usr/bin/env bash
#
# Verifies already-deployed paymasters on their block explorers, from deploy/deployments.json.
#
# Separate from the deploy for a practical reason: verification fails for reasons that have nothing
# to do with the deployment (explorer indexing lag, a rate limit, a missing API key), and a deploy
# that has already spent gas and staked funds must not be re-run to fix a documentation problem.
# This is the retry path, and it is safe to run repeatedly — an already-verified contract is
# reported as such and costs nothing.
#
# Verification is not cosmetic for a paymaster. Anyone integrating is being asked to let this
# contract pay for their users' transactions; unverified bytecode gives them no way to check that it
# does what its documentation claims, or that the deployed code matches this repository.
#
# Usage:
#   ETHERSCAN_API_KEY=... ./deploy/verify-contracts.sh [--chains 8453,10]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENTS_FILE="${DEPLOYMENTS_FILE:-${ROOT}/deploy/deployments.json}"
CONTRACT_PATH="src/VerifyingPaymaster.sol:VerifyingPaymaster"

ONLY_CHAINS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --chains) ONLY_CHAINS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mfail\033[0m %s\n' "$*" >&2; exit 1; }

for tool in forge cast jq; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required but not installed"
done
[ -f "${DEPLOYMENTS_FILE}" ] || fail "no deployments at ${DEPLOYMENTS_FILE}; run deploy/deploy-chains.sh first"
[ -n "${ETHERSCAN_API_KEY:-}" ] || fail "ETHERSCAN_API_KEY is required to verify"

selected="$(jq -c '.deployments' "${DEPLOYMENTS_FILE}")"
if [ -n "${ONLY_CHAINS}" ]; then
  selected="$(jq -c --arg ids "${ONLY_CHAINS}" \
    '[.deployments[] | select(([$ids | split(",") | .[] | tonumber]) | index(.chainId))]' "${DEPLOYMENTS_FILE}")"
fi
count="$(echo "${selected}" | jq 'length')"
[ "${count}" -gt 0 ] || fail "no deployments selected"

failed=()

for i in $(seq 0 $((count - 1))); do
  entry="$(echo "${selected}" | jq -c ".[${i}]")"
  chain_id="$(echo "${entry}" | jq -r '.chainId')"
  name="$(echo "${entry}" | jq -r '.name')"
  paymaster="$(echo "${entry}" | jq -r '.paymaster')"

  # Constructor arguments must be byte-identical to the deploy, or verification fails with a
  # mismatch that reads like a compiler problem. They come from the deployment record rather than
  # from the environment for exactly that reason: the record is what was actually used.
  args="$(cast abi-encode "constructor(address,address,address)" \
    "$(echo "${entry}" | jq -r '.entryPoint')" \
    "$(echo "${entry}" | jq -r '.owner')" \
    "$(echo "${entry}" | jq -r '.signer')")"

  log "${name} (${chain_id}): verifying ${paymaster}"

  set +e
  ( cd "${ROOT}/contracts" && forge verify-contract \
      "${paymaster}" "${CONTRACT_PATH}" \
      --chain "${chain_id}" \
      --constructor-args "${args}" \
      --etherscan-api-key "${ETHERSCAN_API_KEY}" \
      --watch )
  status=$?
  set -e

  if [ "${status}" -ne 0 ]; then
    warn "${name}: verification failed (exit ${status})"
    failed+=("${name} (${chain_id})")
  fi
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  warn "unverified: ${failed[*]}"
  warn "explorers index deployments with a delay; retrying in a few minutes usually succeeds"
  exit 1
fi
log "every selected deployment is verified"
