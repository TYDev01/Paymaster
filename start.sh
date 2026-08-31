#!/usr/bin/env bash
#
# Starts the whole project against ETHEREUM SEPOLIA, from nothing to a working sponsorship.
#
# THERE IS NO LOCAL CHAIN ANY MORE. anvil, deploy/local-setup.sh and the rundler chain.toml are
# gone; the stack talks to a paymaster already deployed on Sepolia. That changes what this script
# can and cannot do for you:
#
#   * it does NOT deploy contracts. A deploy costs real Sepolia ETH and is not something a boot
#     script should do implicitly. Deploy once with contracts/script/DeployPaymaster.s.sol, and
#     this script reads the address back out of the broadcast receipt.
#   * it CANNOT reset state. On a devnet a bad deploy was fixed by wiping the chain; here it is
#     on chain forever and the fix is to deploy again and update contracts/.env.
#   * everything it needs that costs money — the paymaster's deposit, the bundler EOA's balance —
#     is CHECKED at boot and reported, because the failure they cause otherwise (AA31, or bundles
#     that are built and never land) points nowhere near the empty account that caused it.
#
# Usage:
#   ./start.sh                 boot everything and leave it running
#   ./start.sh stop            stop everything this started
#   ./start.sh status          what is up, and on which port
#   ./start.sh --no-ui         backend stack only, no Next apps
#   ./start.sh --monitoring    also start Prometheus, Grafana and the OTel collector
#   ./start.sh --skip-checks   do not read Sepolia at boot (offline, or the RPC is rate limiting)
#
# It is idempotent: running it twice reinstalls nothing already installed and redeploys nothing.
#
# Reads contracts/.env for the deployed address and the money settings. See contracts/.env.example.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${ROOT}/.run"
LOG_DIR="${RUN_DIR}/logs"

# Assigned rather than left to collide: two Next apps, a bundler and a Grafana all want a port in
# the low 3000s. See the port table in README.md.
WEB_PORT=3000
CONSOLE_PORT=3003
BACKEND_PORT="${BACKEND_HOST_PORT:-3100}"

WITH_UI=1
WITH_MONITORING=0
SKIP_CHECKS=0
COMMAND="start"

# "Is something listening" is a TCP question, and answering it over HTTP was wrong twice: once
# because a 404 is a live server, and once because a cold `next dev` takes longer to compile its
# first page than any sensible probe timeout — so a perfectly healthy console read as down.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
step() { printf '\033[1;36m  ·\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mfail\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    stop|status|start) COMMAND="$1"; shift ;;
    --no-ui) WITH_UI=0; shift ;;
    --monitoring) WITH_MONITORING=1; shift ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
done

compose() {
  if [ "${WITH_MONITORING}" -eq 1 ]; then
    docker compose --profile monitoring "$@"
  else
    docker compose "$@"
  fi
}

# Compose refuses to do ANYTHING while `${CHAINS:?...}` and friends are unset — including `ps` and
# `down`, which stop and status need before `.env` has necessarily been written. So the calls made
# before that supply throwaway values from the environment instead.
#
# BUNDLER_SIGNER_KEY and SEPOLIA_RPC_URL joined this list when the bundler stopped defaulting to
# anvil: both are now `:?` in the compose file, so without them even `./start.sh stop` aborts.
#
# In a subshell, deliberately. Compose reads the shell environment at HIGHER precedence than
# `.env`, so a leaked `CHAINS=[]` here would silently override the real config written later and
# leave a backend serving no chains at all.
compose_bootstrap() {
  (
    export SPONSORSHIP_SIGNER_KEY="${SPONSORSHIP_SIGNER_KEY:-0x00}" \
           BOOTSTRAP_API_KEY="${BOOTSTRAP_API_KEY:-bootstrap}" \
           BUNDLER_SIGNER_KEY="${BUNDLER_SIGNER_KEY:-0x00}" \
           SEPOLIA_RPC_URL="${SEPOLIA_RPC_URL:-http://unset.invalid}" \
           CHAINS="${CHAINS:-[]}"
    compose "$@"
  )
}

# ------------------------------------------------------------------------------------------------
# stop / status
# ------------------------------------------------------------------------------------------------

stop_node_app() {
  # Two statements, not one: bash expands every word of a `local` before performing any of its
  # assignments, so `local name="$1" pidfile="${RUN_DIR}/${name}.pid"` reads `name` while it is
  # still unset — which under `set -u` aborted the whole stop command.
  local name="$1"
  local pidfile="${RUN_DIR}/${name}.pid"
  [ -f "${pidfile}" ] || return 0
  local pid
  pid="$(cat "${pidfile}")"
  # The whole process GROUP: `start_node_app` used setsid precisely so this signal reaches
  # next-server, which is two levels below the pid recorded here.
  if kill -0 "${pid}" 2>/dev/null; then
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    step "stopped ${name} (pid ${pid})"
  fi
  rm -f "${pidfile}"
}

if [ "${COMMAND}" = "stop" ]; then
  cd "${ROOT}"
  log "stopping"
  stop_node_app web
  stop_node_app console
  compose_bootstrap down
  log "stopped. Data volumes are kept — use 'docker compose down -v' to discard them."
  exit 0
fi

# ANY HTTP response means the port is served. `curl -f` was used here first and reported the
# backend as down because it answers 404 on `/` — it has no root route, only /health and the API.
# "Refused the connection" is down; "told me 404" is very much up.
port_state() {
  if port_in_use "$1"; then
    printf '\033[1;32mup\033[0m'
  else
    printf '\033[1;31mdown\033[0m'
  fi
}

if [ "${COMMAND}" = "status" ]; then
  cd "${ROOT}"
  printf '  %-28s %-34s %s\n' "SERVICE" "URL" "STATE"
  printf '  %-28s %-34s %b\n' "Website + dashboard" "http://localhost:${WEB_PORT}" "$(port_state "${WEB_PORT}")"
  printf '  %-28s %-34s %b\n' "Operator console" "http://localhost:${CONSOLE_PORT}" "$(port_state "${CONSOLE_PORT}")"
  printf '  %-28s %-34s %b\n' "Backend API" "http://localhost:${BACKEND_PORT}" "$(port_state "${BACKEND_PORT}")"
  printf '  %-28s %-34s %b\n' "Bundler" "http://localhost:3001" "$(port_state 3001)"
  echo
  compose_bootstrap ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || true
  exit 0
fi

# ------------------------------------------------------------------------------------------------
# preflight
# ------------------------------------------------------------------------------------------------

cd "${ROOT}"
mkdir -p "${LOG_DIR}"

log "checking tools"
for tool in docker node npm jq; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required but not on PATH"
done
# `cast` only, and only for the Sepolia preflight — nothing here compiles or deploys any more.
# --skip-checks makes it optional entirely.
if [ "${SKIP_CHECKS}" -eq 0 ]; then
  command -v cast >/dev/null 2>&1 \
    || fail "cast is required for the Sepolia preflight (install Foundry: https://getfoundry.sh), or pass --skip-checks"
fi
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not running"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "${node_major}" -ge 22 ] || fail "Node >= 22 is required, found $(node -v)"
step "docker, node $(node -v)"

# ------------------------------------------------------------------------------------------------
# dependencies
# ------------------------------------------------------------------------------------------------

install_if_missing() {
  local dir="$1" label="$2"
  if [ -d "${dir}/node_modules" ]; then
    step "${label}: dependencies present"
    return 0
  fi
  step "${label}: installing dependencies (first run, this takes a few minutes)"
  (cd "${dir}" && npm install --no-audit --no-fund >"${LOG_DIR}/npm-${label}.log" 2>&1) \
    || fail "${label}: npm install failed — see ${LOG_DIR}/npm-${label}.log"
}

log "dependencies"
install_if_missing "${ROOT}" "workspace"
[ "${WITH_UI}" -eq 1 ] && install_if_missing "${ROOT}/web" "web"
[ "${WITH_UI}" -eq 1 ] && install_if_missing "${ROOT}/frontend" "console"

# The bundler is a pinned, checksum-verified binary rather than an image build; fetching it is a
# no-op once it exists.
if [ ! -x "${ROOT}/backend/.bin/rundler" ] && [ ! -f "${ROOT}/backend/.bin/rundler" ]; then
  step "fetching the bundler binary"
  npm run bundler:fetch --workspace @paymaster/backend >"${LOG_DIR}/bundler-fetch.log" 2>&1 \
    || warn "bundler fetch failed — see ${LOG_DIR}/bundler-fetch.log (compose may still have an image)"
fi

# ------------------------------------------------------------------------------------------------
# host ports
# ------------------------------------------------------------------------------------------------

# Postgres and Redis are the two host ports a developer machine most often already has, and the
# compose file says outright that remapping them costs nothing: the backend reaches both over the
# compose network, so the host mapping is a convenience for psql and redis-cli alone.
#
# Anything ELSE that is occupied is a real conflict and is reported rather than worked around —
# the bundler's 3001 is addressed by name from the host by the SDK example, so silently moving it
# would break the thing this script exists to produce. (8545 used to be here too, for anvil.)
pick_free_port() {
  local port="$1" limit=$((${1} + 20))
  while [ "${port}" -lt "${limit}" ]; do
    port_in_use "${port}" || { echo "${port}"; return 0; }
    port=$((port + 1))
  done
  echo "$1"
}

# Held by one of our own containers from a previous run?
port_is_ours() { compose_bootstrap ps --format '{{.Publishers}}' 2>/dev/null | grep -q " $1 tcp}"; }

# Stable across runs. Without the "already ours" case, each re-run sees the port held by the
# container it started last time, calls it busy, and drifts one higher — recreating postgres on a
# new port every boot and orphaning the previous one.
choose_host_port() {
  local var="$1" fallback="$2" previous chosen
  previous="$(grep -E "^${var}=" "${ROOT}/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  chosen="${!var:-${previous:-${fallback}}}"
  if port_in_use "${chosen}" && ! port_is_ours "${chosen}"; then
    chosen="$(pick_free_port "${chosen}")"
  fi
  echo "${chosen}"
}

log "checking host ports"
POSTGRES_HOST_PORT="$(choose_host_port POSTGRES_HOST_PORT 5432)"
REDIS_HOST_PORT="$(choose_host_port REDIS_HOST_PORT 6379)"
export POSTGRES_HOST_PORT REDIS_HOST_PORT
[ "${POSTGRES_HOST_PORT}" != "5432" ] && step "5432 is busy — postgres will be on :${POSTGRES_HOST_PORT}"
[ "${REDIS_HOST_PORT}" != "6379" ] && step "6379 is busy — redis will be on :${REDIS_HOST_PORT}"

for entry in "3001:the bundler" "${BACKEND_PORT}:the backend"; do
  port="${entry%%:*}"
  owner="${entry#*:}"
  if port_in_use "${port}"; then
    # Only a conflict if it is not already OURS from a previous run. Compose prints publishers as
    # `[{127.0.0.1 3000 3100 tcp}]` — host port third, container port second — so the host port is
    # the token before " tcp}". Matching the wrong field here turns every re-run into a false alarm.
    if ! compose_bootstrap ps --format '{{.Publishers}}' 2>/dev/null | grep -q " ${port} tcp}"; then
      warn "port ${port} (${owner}) is already in use by something else"
      warn "stop it, or set BACKEND_HOST_PORT / edit docker-compose.yml, then re-run"
    fi
  fi
done

# ------------------------------------------------------------------------------------------------
# the paymaster on Sepolia
# ------------------------------------------------------------------------------------------------
#
# Read, never written. The deploy is a deliberate act that spends real ETH; this script's job is to
# confirm what is already there and to fail LOUDLY when it is not, because every one of these
# misconfigurations otherwise surfaces far from its cause.

CONTRACTS_ENV="${ROOT}/contracts/.env"
[ -f "${CONTRACTS_ENV}" ] || fail "contracts/.env is missing — copy contracts/.env.example and deploy first"

# Sourced in a subshell and read back, so a stray line in contracts/.env cannot clobber this
# script's own variables (it holds DEPLOYER_KEY, among other things we do not want in scope).
read_contracts_env() { (set -a; . "${CONTRACTS_ENV}"; set +a; printf '%s' "${!1:-}"); }

PAYMASTER_ADDRESS="$(read_contracts_env PAYMASTER_ADDRESS)"
PAYMASTER_KIND="$(read_contracts_env PAYMASTER_KIND)"
PAYMASTER_SIGNER="$(read_contracts_env PAYMASTER_SIGNER)"
STAKE_WEI="$(read_contracts_env STAKE_WEI)"
SEPOLIA_RPC_URL="${SEPOLIA_RPC_URL:-$(read_contracts_env RPC_URL)}"

# The address is preferably not typed at all: the broadcast receipt is what actually happened on
# chain, so reading it there cannot disagree with the deployment the way a transcribed address can.
if [ -z "${PAYMASTER_ADDRESS}" ]; then
  RECEIPT="${ROOT}/contracts/broadcast/DeployPaymaster.s.sol/11155111/run-latest.json"
  if [ -f "${RECEIPT}" ]; then
    PAYMASTER_ADDRESS="$(jq -r '[.transactions[] | select(.transactionType=="CREATE")] | last | .contractAddress // empty' "${RECEIPT}")"
    [ -n "${PAYMASTER_ADDRESS}" ] && step "paymaster read from the broadcast receipt: ${PAYMASTER_ADDRESS}"
  fi
fi
[ -n "${PAYMASTER_ADDRESS}" ] \
  || fail "no paymaster address: set PAYMASTER_ADDRESS in contracts/.env, or deploy so a broadcast receipt exists"
[ -n "${SEPOLIA_RPC_URL}" ] || fail "no RPC: set SEPOLIA_RPC_URL, or RPC_URL in contracts/.env"

PAYMASTER_KIND="${PAYMASTER_KIND:-verifying}"
STAKE_WEI="${STAKE_WEI:-21000000000000000}"
export SEPOLIA_RPC_URL PAYMASTER_ADDRESS PAYMASTER_KIND STAKE_WEI

if [ "${SKIP_CHECKS}" -eq 1 ]; then
  log "skipping the Sepolia preflight (--skip-checks)"
else
  log "checking Sepolia"

  chain_id="$(cast chain-id --rpc-url "${SEPOLIA_RPC_URL}" 2>/dev/null || true)"
  [ "${chain_id}" = "11155111" ] \
    || fail "RPC ${SEPOLIA_RPC_URL} reports chain id '${chain_id:-unreachable}', expected 11155111"

  # A paymaster address with no code is the single most confusing failure mode here: the backend
  # validates its CHAINS at boot and would refuse to start, naming the chain and not the typo.
  code="$(cast code "${PAYMASTER_ADDRESS}" --rpc-url "${SEPOLIA_RPC_URL}" 2>/dev/null || echo 0x)"
  [ "${code}" != "0x" ] && [ -n "${code}" ] \
    || fail "no contract at ${PAYMASTER_ADDRESS} on Sepolia — wrong address, or the deploy did not land"
  step "paymaster ${PAYMASTER_ADDRESS} (${PAYMASTER_KIND})"

  # Deposit pays for sponsored gas; at zero EVERY sponsored operation fails AA31 and nothing in the
  # backend's own logs says why.
  deposit="$(cast call "${PAYMASTER_ADDRESS}" 'getDeposit()(uint256)' --rpc-url "${SEPOLIA_RPC_URL}" 2>/dev/null | awk '{print $1}' || echo 0)"
  if [ "${deposit:-0}" = "0" ]; then
    warn "the paymaster's deposit is ZERO — every sponsored operation will fail AA31"
    warn "  cast send ${PAYMASTER_ADDRESS} 'deposit()' --value 0.01ether --rpc-url \"\${SEPOLIA_RPC_URL}\" --private-key <key>"
  else
    step "deposit $(cast from-wei "${deposit}") ETH"
  fi

  # The stake is what makes the bundler ACCEPT the paymaster at all, and MIN_STAKE_VALUE is what we
  # tell the bundler to demand. If the floor is above what is actually staked, rundler rejects every
  # operation with -32502 — before anything reaches the chain, and blaming the bundler.
  stake="$(cast call 0x0000000071727De22E5E9d8BAf0edAc6f37da032 \
    'getDepositInfo(address)(uint256,bool,uint112,uint32,uint48)' "${PAYMASTER_ADDRESS}" \
    --rpc-url "${SEPOLIA_RPC_URL}" 2>/dev/null | sed -n '3p' | awk '{print $1}' || echo 0)"
  MIN_STAKE_VALUE="${MIN_STAKE_VALUE:-${STAKE_WEI}}"
  export MIN_STAKE_VALUE
  if [ -n "${stake}" ] && [ "${stake}" != "0" ]; then
    step "stake $(cast from-wei "${stake}") ETH, bundler floor $(cast from-wei "${MIN_STAKE_VALUE}") ETH"
    python3 -c "import sys; sys.exit(0 if int('${stake}') >= int('${MIN_STAKE_VALUE}') else 1)" \
      || fail "staked ${stake} wei is BELOW the bundler floor ${MIN_STAKE_VALUE} wei — rundler would reject every operation (-32502)"
  else
    warn "the paymaster is NOT STAKED — a conforming bundler rejects every operation (-32502)"
  fi

  # The bundler EOA pays for the bundles it submits, in real Sepolia ETH. Empty, rundler runs
  # perfectly happily and simply never lands anything.
  BUNDLER_SIGNER_KEY="${BUNDLER_SIGNER_KEY:-$(read_contracts_env BUNDLER_SIGNER_KEY)}"
  export BUNDLER_SIGNER_KEY
  if [ -n "${BUNDLER_SIGNER_KEY:-}" ]; then
    bundler_eoa="$(cast wallet address --private-key "${BUNDLER_SIGNER_KEY}" 2>/dev/null || true)"
    if [ -n "${bundler_eoa}" ]; then
      bundler_bal="$(cast balance "${bundler_eoa}" --rpc-url "${SEPOLIA_RPC_URL}" 2>/dev/null || echo 0)"
      if [ "${bundler_bal}" = "0" ]; then
        warn "the bundler EOA ${bundler_eoa} has NO Sepolia ETH — it will build bundles and land none"
      else
        step "bundler EOA ${bundler_eoa}, $(cast from-wei "${bundler_bal}") ETH"
      fi
    fi
  fi
fi

# ------------------------------------------------------------------------------------------------
# the backend's environment
# ------------------------------------------------------------------------------------------------
#
# CHAINS is GENERATED from what was just read off chain, never transcribed. `paymasterKind` must
# match the contract that is actually deployed — the two paymasters use different EIP-712 domains,
# so a mismatch fails every sponsorship with an opaque AA34 — and `minStakeWei` must not exceed the
# real stake, or the backend reports a correctly staked chain as unhealthy.
log "writing .env for the stack"

python3 <<'PY'
import json, os, pathlib, secrets

# cwd is the repo root: the script cd'd there at the top.
dst = pathlib.Path(".env")

paymaster = os.environ["PAYMASTER_ADDRESS"]
kind      = os.environ.get("PAYMASTER_KIND", "verifying")
rpc_url   = os.environ["SEPOLIA_RPC_URL"]
stake_wei = int(os.environ.get("MIN_STAKE_VALUE") or os.environ.get("STAKE_WEI") or 0)

# GENERATED, not transcribed. A hand-written CHAINS is how a paymaster ends up signing attestations
# for a contract that is not the one deployed — which fails per operation, on chain, as an AA34
# that names nothing useful.
#
# minStakeWei is the backend's health threshold, NOT a requirement it imposes on the chain:
# ChainAdapter reports stakeBelowThreshold when the real stake is under it. Setting it to the stake
# we actually placed is the only value that is true; the 1 ETH from the mainnet examples would
# report this correctly-staked chain as permanently unhealthy.
chains = [{
    "chainId": 11155111,
    "name": "Ethereum Sepolia",
    "rpcUrls": [rpc_url],
    "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    "paymaster": paymaster,
    "paymasterKind": kind,
    "explorerUrl": "https://sepolia.etherscan.io",
    "nativeCurrency": {"symbol": "ETH", "decimals": 18},
    # A tenth of the stake: low enough not to cry wolf on a testnet deposit, high enough that
    # FundingMonitor warns before the deposit hits zero and every operation starts failing AA31.
    "minDepositWei": str(max(stake_wei // 10, 10**15)),
    "minStakeWei": str(stake_wei),
    "enabled": True,
}]

values = {"CHAINS": json.dumps(chains, separators=(",", ":"))}

# The signer whose ADDRESS the deployed paymaster stores. Sourced from contracts/.env, where the
# deploy put it, so the pair cannot drift apart — a mismatch here is an on-chain AA34 on every
# sponsorship, and it points at the signature rather than at the key.
contracts_env = {}
ce = pathlib.Path("contracts/.env")
if ce.exists():
    for line in ce.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, _, v = line.partition("=")
            contracts_env[k.strip()] = v.strip()

signer_key = os.environ.get("SPONSORSHIP_SIGNER_KEY") or contracts_env.get("SPONSORSHIP_SIGNER_KEY_FOR_BACKEND", "")
if signer_key:
    values["SPONSORSHIP_SIGNER_KEY"] = signer_key

# The bundler EOA that pays for bundles. Carried through so `docker compose` run BY HAND afterwards
# gets the same one — compose now hard-fails without it rather than falling back to an anvil key.
bundler_key = os.environ.get("BUNDLER_SIGNER_KEY") or contracts_env.get("BUNDLER_SIGNER_KEY", "")
if bundler_key:
    values["BUNDLER_SIGNER_KEY"] = bundler_key

values["SEPOLIA_RPC_URL"] = rpc_url
values["MIN_STAKE_VALUE"] = str(stake_wei)

existing = dst.read_text() if dst.exists() else ""
def previous(key, minlen=0):
    return next((l.split("=", 1)[1] for l in existing.splitlines()
                 if l.startswith(key + "=") and len(l) > minlen), None)

# Not a devnet value any more: this key authenticates the admin API of a stack pointed at a public
# chain. Generated once and then kept, so it does not rotate on every boot.
values["BOOTSTRAP_API_KEY"] = os.environ.get("BOOTSTRAP_API_KEY") or previous("BOOTSTRAP_API_KEY") or ("pm_" + secrets.token_urlsafe(32))

# Dashboard sign-in needs the backend to verify tokens from the SAME Privy app the browser used,
# and to hold a secret for the sessions it issues. The app id is already in web/.env.local. Without
# them /auth/* answers 503 and the dashboard cannot sign anyone in — a confusing wall to hit when
# the browser side is configured and looks fine.
identity = {}
web_env = pathlib.Path("web/.env.local")
if web_env.exists():
    for line in web_env.read_text().splitlines():
        if line.strip().startswith("NEXT_PUBLIC_PRIVY_APP_ID="):
            app_id = line.split("=", 1)[1].strip()
            if app_id:
                identity["PRIVY_APP_ID"] = app_id

if "PRIVY_APP_ID" in identity:
    # Reused across restarts, so a session survives one. Regenerating would sign everyone out on
    # every boot, which reads as a login bug rather than as a fresh secret.
    identity["ADMIN_JWT_SECRET"] = previous("ADMIN_JWT_SECRET", 49) or secrets.token_urlsafe(48)
    identity["TENANT_SELF_SIGNUP"] = "true"

# Written into .env rather than left in the shell, so `docker compose` run BY HAND afterwards binds
# the same ports this script chose.
host_ports = {k: os.environ[k] for k in ("POSTGRES_HOST_PORT", "REDIS_HOST_PORT") if os.environ.get(k)}

managed = set(values) | set(host_ports) | set(identity)
preserved = [line for line in existing.splitlines()
             if "=" in line
             and line.split("=", 1)[0].strip() not in managed
             and not line.startswith("# generated")]

out = ["# generated by ./start.sh — Ethereum Sepolia (11155111). CHAINS is built from the paymaster",
       "# read off chain, not transcribed. Safe to edit; regenerated on boot."]
out += [f"{k}={v}" for k, v in values.items()]
out += [f"{k}={v}" for k, v in host_ports.items()]
out += [f"{k}={v}" for k, v in identity.items()]
if preserved:
    out += ["", "# kept from the previous .env"] + preserved
dst.write_text("\n".join(out) + "\n")

missing = [k for k in ("SPONSORSHIP_SIGNER_KEY", "BUNDLER_SIGNER_KEY") if k not in values]
note = " + dashboard sign-in" if "PRIVY_APP_ID" in identity else " (no PRIVY_APP_ID in web/.env.local)"
print(f"  \u00b7 .env written for Sepolia{note}")
for k in missing:
    print(f"  \u00b7 MISSING {k} — the stack will not start without it")
PY

# ------------------------------------------------------------------------------------------------
# the stack
# ------------------------------------------------------------------------------------------------

log "starting postgres, redis, the Sepolia bundler and the backend"
# `--build`, always. `docker compose up -d` reuses whatever image exists, so after editing the
# backend you get the OLD code with no indication of it — which cost an afternoon here: routes that
# demonstrably existed in the source returned 404 from a container built before they were written.
# Layer caching makes this nearly free when nothing changed.
compose up -d --build >"${LOG_DIR}/compose-up.log" 2>&1 || fail "docker compose up failed — see ${LOG_DIR}/compose-up.log"

step "waiting for the backend on :${BACKEND_PORT}"
backend_ready=0
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${BACKEND_PORT}/health/live" 2>/dev/null; then
    backend_ready=1
    break
  fi
  sleep 1
done
if [ "${backend_ready}" -eq 0 ]; then
  warn "the backend did not become healthy in 90s"
  warn "logs:  docker compose logs backend"
fi

# ------------------------------------------------------------------------------------------------
# the two web apps
# ------------------------------------------------------------------------------------------------

start_node_app() {
  local name="$1" dir="$2" port="$3" pid
  if port_in_use "${port}"; then
    # Somebody else's server, or ours from a previous run. Either way it is not this script's to
    # restart, and killing a dev server someone is using would be a rude way to find that out.
    step "${name}: already listening on :${port}, leaving it alone"
    return 0
  fi
  step "${name}: starting on :${port}"

  # `setsid` puts the app in its OWN process group, which is what makes it stoppable later: the
  # tree is npm -> sh -c -> node -> next-server, and next-server is the one holding the port.
  # Signalling only the recorded pid, or only its direct children, leaves the server running and
  # the port taken — which is exactly what the first version of `stop` did.
  #
  # `exec` so the recorded pid is the group leader rather than a wrapper shell, and `disown` so
  # this script does not sit in do_wait until the dev server exits.
  setsid bash -c "cd '${dir}' && exec npm run dev" >"${LOG_DIR}/${name}.log" 2>&1 &
  pid=$!
  echo "${pid}" >"${RUN_DIR}/${name}.pid"
  disown "${pid}" 2>/dev/null || true
}

if [ "${WITH_UI}" -eq 1 ]; then
  log "starting the web apps"
  start_node_app web "${ROOT}/web" "${WEB_PORT}"
  start_node_app console "${ROOT}/frontend" "${CONSOLE_PORT}"

  for _ in $(seq 1 60); do
    port_in_use "${WEB_PORT}" && break
    sleep 1
  done
fi

# ------------------------------------------------------------------------------------------------
# what you have
# ------------------------------------------------------------------------------------------------

API_KEY="$(grep -E '^BOOTSTRAP_API_KEY=' "${ROOT}/.env" | tail -1 | cut -d= -f2- || true)"

echo
log "up"
echo
printf '  %-28s %s\n' "Website" "http://localhost:${WEB_PORT}"
printf '  %-28s %s\n' "  your account" "http://localhost:${WEB_PORT}/dashboard"
[ "${WITH_UI}" -eq 1 ] && printf '  %-28s %s\n' "Operator console" "http://localhost:${CONSOLE_PORT}"
printf '  %-28s %s\n' "Backend API" "http://localhost:${BACKEND_PORT}"
printf '  %-28s %s\n' "Bundler" "http://localhost:3001"
[ "${WITH_MONITORING}" -eq 1 ] && printf '  %-28s %s\n' "Grafana" "http://localhost:3002"
[ "${WITH_MONITORING}" -eq 1 ] && printf '  %-28s %s\n' "Prometheus" "http://localhost:9090"
echo
[ -n "${API_KEY}" ] && printf '  %-28s %s\n' "API key" "${API_KEY}"
printf '  %-28s %s\n' "Paymaster (Sepolia)" "https://sepolia.etherscan.io/address/${PAYMASTER_ADDRESS}"
echo
printf '  End-to-end sponsorship:  \033[1m(cd sdk && npx tsx examples/sponsor-and-send.ts)\033[0m\n'
printf '  Logs:                    %s\n' "${LOG_DIR}"
printf '  Stop everything:         \033[1m./start.sh stop\033[0m\n'
echo

if [ "${WITH_UI}" -eq 1 ] && [ ! -f "${ROOT}/web/.env.local" ]; then
  warn "web/.env.local is missing, so /dashboard cannot sign anyone in."
  warn "Copy web/.env.example and set NEXT_PUBLIC_PRIVY_APP_ID (and PRIVY_APP_ID for the backend)."
fi
