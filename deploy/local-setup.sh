#!/usr/bin/env bash
#
# Stands up a complete local devnet and prints the configuration everything else needs.
#
# After this runs you have, on a local anvil chain: Multicall3, an EntryPoint v0.7, a
# SimpleAccountFactory, a deployed + funded + STAKED VerifyingPaymaster, and a SimpleAccount. It
# writes deploy/.env.local with the CHAINS json, the signer key, a freshly minted API key, and the
# account details — ready to be sourced by the backend, the bundler chain spec, and the SDK example.
#
# It does NOT start the backend or the bundler; docker-compose does that. This produces the
# on-chain state and the config they consume.
#
# Usage:
#   ./deploy/local-setup.sh              # against an anvil already listening on :8545
#   RPC_URL=http://127.0.0.1:8545 ./deploy/local-setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
OUT="${ROOT}/deploy/.env.local"

# Anvil's first two well-known dev accounts. Publicly documented test keys, not secrets: they
# control nothing outside a local anvil chain. NEVER use these anywhere else.
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
# A distinct account owner, so the smart account's owner is not the deployer.
ACCOUNT_OWNER_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
ACCOUNT_OWNER_ADDR="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
# The sponsorship signer. In production this key lives in a KMS and only its address is configured.
# This key and address MUST be a matching pair, or every sponsorship fails on-chain with AA34
# (the paymaster recovers a signer it does not recognise). This is anvil dev account #7.
SPONSOR_SIGNER_KEY="0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
SPONSOR_SIGNER_ADDR="0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"

MULTICALL3="0xcA11bde05977b3631167028862bE2a173976CA11"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

require_running() {
  if ! cast chain-id --rpc-url "${RPC_URL}" >/dev/null 2>&1; then
    echo "no chain at ${RPC_URL}. Start one first:  anvil" >&2
    echo "(or bring up the stack:  docker compose up -d anvil)" >&2
    exit 1
  fi
}

json_deployed() { grep -o '"deployedTo": *"[^"]*"' | cut -d'"' -f4; }

require_running
CHAIN_ID="$(cast chain-id --rpc-url "${RPC_URL}")"
log "chain ${CHAIN_ID} at ${RPC_URL}"

# ------------------------------------------------------------------------------------------------
# Multicall3 — the bundler reads fee data through it, and anvil does not predeploy it. Injecting
# the mainnet runtime code is exact: Multicall3 has no constructor args and no immutables.
# ------------------------------------------------------------------------------------------------
if [ "$(cast code "${MULTICALL3}" --rpc-url "${RPC_URL}")" = "0x" ]; then
  log "injecting Multicall3"
  CODE_CACHE="${ROOT}/backend/.bundler/multicall3.hex"
  if [ -f "${CODE_CACHE}" ]; then
    MC_CODE="$(cat "${CODE_CACHE}")"
  else
    MC_CODE="$(cast code "${MULTICALL3}" --rpc-url https://ethereum-rpc.publicnode.com)"
  fi
  cast rpc anvil_setCode "${MULTICALL3}" "${MC_CODE}" --rpc-url "${RPC_URL}" >/dev/null
fi

# ------------------------------------------------------------------------------------------------
# EntryPoint + factory. On a real chain these already exist at canonical addresses; locally we
# deploy them.
# ------------------------------------------------------------------------------------------------
cd "${ROOT}/contracts"
forge build >/dev/null 2>&1

log "deploying EntryPoint"
ENTRY_POINT="$(forge create --rpc-url "${RPC_URL}" --private-key "${DEPLOYER_KEY}" --broadcast --json \
  lib/account-abstraction/contracts/core/EntryPoint.sol:EntryPoint | json_deployed)"

log "deploying SimpleAccountFactory"
FACTORY="$(forge create --rpc-url "${RPC_URL}" --private-key "${DEPLOYER_KEY}" --broadcast --json \
  lib/account-abstraction/contracts/samples/SimpleAccountFactory.sol:SimpleAccountFactory \
  --constructor-args "${ENTRY_POINT}" | json_deployed)"

# ------------------------------------------------------------------------------------------------
# Paymaster — via the same production script, so this path is exercised locally.
# ------------------------------------------------------------------------------------------------
log "deploying + funding + staking the paymaster"
ENTRYPOINT="${ENTRY_POINT}" \
PAYMASTER_OWNER="${DEPLOYER_ADDR}" \
PAYMASTER_SIGNER="${SPONSOR_SIGNER_ADDR}" \
DEPOSIT_WEI="10000000000000000000" \
STAKE_WEI="1000000000000000000" \
  forge script script/DeployPaymaster.s.sol --rpc-url "${RPC_URL}" --private-key "${DEPLOYER_KEY}" --broadcast >/dev/null 2>&1
PAYMASTER="$(python3 -c "import json,glob,os; \
  f=max(glob.glob('broadcast/DeployPaymaster.s.sol/*/run-latest.json'), key=os.path.getmtime); \
  d=json.load(open(f)); \
  print(next(t['contractAddress'] for t in d['transactions'] if t.get('contractName')=='VerifyingPaymaster'))")"

# ------------------------------------------------------------------------------------------------
# A SimpleAccount for the SDK example to sponsor operations from.
# ------------------------------------------------------------------------------------------------
log "creating a SimpleAccount"
SMART_ACCOUNT="$(cast call "${FACTORY}" "getAddress(address,uint256)(address)" "${ACCOUNT_OWNER_ADDR}" 0 --rpc-url "${RPC_URL}")"
cast send "${FACTORY}" "createAccount(address,uint256)" "${ACCOUNT_OWNER_ADDR}" 0 \
  --rpc-url "${RPC_URL}" --private-key "${DEPLOYER_KEY}" >/dev/null

# ------------------------------------------------------------------------------------------------
# A bootstrap API key. Generated by the backend so only its hash would ever be stored.
# ------------------------------------------------------------------------------------------------
log "minting an API key"
API_KEY="$(cd "${ROOT}/backend" && npm run key:generate --silent -- --env test --name local-dev 2>/dev/null)"

# ------------------------------------------------------------------------------------------------
# Emit the config.
# ------------------------------------------------------------------------------------------------
# Compact JSON (no spaces) so the single-quoted value below survives `source` and docker-compose.
CHAINS_JSON="$(python3 -c "import json; print(json.dumps([{ \
  'chainId': int('${CHAIN_ID}'), 'name': 'Local Anvil', 'rpcUrls': ['${RPC_URL}'], \
  'entryPoint': '${ENTRY_POINT}', 'paymaster': '${PAYMASTER}', 'explorerUrl': 'http://localhost', \
  'nativeCurrency': {'symbol': 'ETH', 'decimals': 18}, \
  'minDepositWei': '1000000000000000000', 'minStakeWei': '1000000000000000000', 'enabled': True}], separators=(',', ':')))")"

cat > "${OUT}" <<EOF
# Generated by deploy/local-setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Do not commit.
# Local devnet only — every key here is a public anvil test key.

CHAIN_ID=${CHAIN_ID}
RPC_URL=${RPC_URL}
ENTRY_POINT=${ENTRY_POINT}
PAYMASTER=${PAYMASTER}
SMART_ACCOUNT=${SMART_ACCOUNT}

# Backend
SPONSORSHIP_SIGNER_KEY=${SPONSOR_SIGNER_KEY}
BOOTSTRAP_API_KEY=${API_KEY}
# Single-quoted: the JSON contains characters (braces, colons, quotes) that bash `source` would
# otherwise try to interpret. Compact form, so no spaces break the value either.
CHAINS='${CHAINS_JSON}'

# SDK example (sdk/examples/sponsor-and-send.ts)
API_KEY=${API_KEY}
ACCOUNT_OWNER_KEY=${ACCOUNT_OWNER_KEY}
PAYMASTER_URL=http://localhost:3000
BUNDLER_URL=http://localhost:3001
EOF

log "wrote ${OUT}"
echo
echo "  EntryPoint    ${ENTRY_POINT}"
echo "  Paymaster     ${PAYMASTER}  (10 ETH deposit, 1 ETH stake)"
echo "  SmartAccount  ${SMART_ACCOUNT}"
echo "  Signer        ${SPONSOR_SIGNER_ADDR}"
echo
echo "next:  set -a && source ${OUT} && set +a"
echo "       then start the backend + bundler, and run the SDK example."
