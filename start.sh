#!/usr/bin/env bash
#
# Starts the whole project locally, from nothing to a working sponsorship.
#
# The manual sequence this replaces is documented in the README, and every step of it exists for a
# reason that is easy to forget at 2am:
#
#   * the CHAIN must exist before the backend starts, because the backend validates CHAINS at boot
#     and refuses a chain whose EntryPoint has no code;
#   * the contracts must be DEPLOYED before that, because CHAINS names the paymaster address;
#   * and the CHAINS the backend gets must point at `anvil:8545` on the compose network, not at the
#     `127.0.0.1:8545` that local-setup writes for host tooling. Getting that one wrong produces a
#     backend that boots and then fails every request.
#
# Usage:
#   ./start.sh                 boot everything and leave it running
#   ./start.sh stop            stop everything this started
#   ./start.sh status          what is up, and on which port
#   ./start.sh --no-ui         backend stack only, no Next apps
#   ./start.sh --monitoring    also start Prometheus, Grafana and the OTel collector
#   ./start.sh --fresh         wipe the devnet chain and redeploy the contracts
#
# It is idempotent: running it twice does not redeploy contracts that are still on chain, and does
# not reinstall dependencies that are already there.
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
FRESH=0
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
    --fresh) FRESH=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Compose refuses to do ANYTHING while `${CHAINS:?...}` and friends are unset — including starting
# anvil, which is the very thing that has to run before those values can exist. So the calls made
# before `.env` is written supply throwaway values from the environment instead.
#
# In a subshell, deliberately. Compose reads the shell environment at HIGHER precedence than
# `.env`, so a leaked `CHAINS=[]` here would silently override the real config written later and
# leave a backend serving no chains at all.
compose_bootstrap() {
  (
    export SPONSORSHIP_SIGNER_KEY="${SPONSORSHIP_SIGNER_KEY:-0x00}" \
           BOOTSTRAP_API_KEY="${BOOTSTRAP_API_KEY:-bootstrap}" \
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
for tool in forge cast; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required (install Foundry: https://getfoundry.sh)"
done
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not running"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "${node_major}" -ge 22 ] || fail "Node >= 22 is required, found $(node -v)"
step "docker, node $(node -v), foundry"

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
# anvil's 8545 and the bundler's 3001 are addressed by name from the host, by local-setup and by
# the SDK example, so silently moving them would break the thing this script exists to produce.
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

for entry in "8545:anvil" "3001:the bundler" "${BACKEND_PORT}:the backend"; do
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
# the chain, and the contracts on it
# ------------------------------------------------------------------------------------------------

if [ "${FRESH}" -eq 1 ]; then
  log "discarding the devnet chain (--fresh)"
  compose_bootstrap rm -sf anvil >/dev/null 2>&1 || true
  rm -f "${ROOT}/deploy/.env.local"
fi

log "starting the chain"
compose_bootstrap up -d anvil >"${LOG_DIR}/compose-anvil.log" 2>&1 || fail "could not start anvil — see ${LOG_DIR}/compose-anvil.log"

step "waiting for anvil on :8545"
for _ in $(seq 1 60); do
  if cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; then break; fi
  sleep 1
done
cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1 || fail "anvil did not become ready"

# Idempotent: only deploy when there is nothing deployed. `deploy/.env.local` alone is not proof —
# the chain may have been wiped since — so the paymaster address is checked for code.
needs_deploy=1
if [ -f "${ROOT}/deploy/.env.local" ]; then
  existing_paymaster="$(grep -o '"paymaster":"[^"]*"' "${ROOT}/deploy/.env.local" | head -1 | cut -d'"' -f4 || true)"
  if [ -n "${existing_paymaster}" ]; then
    code="$(cast code "${existing_paymaster}" --rpc-url http://127.0.0.1:8545 2>/dev/null || echo 0x)"
    [ "${code}" != "0x" ] && [ -n "${code}" ] && needs_deploy=0
  fi
fi

if [ "${needs_deploy}" -eq 1 ]; then
  log "deploying contracts to the devnet"
  "${ROOT}/deploy/local-setup.sh" >"${LOG_DIR}/local-setup.log" 2>&1 \
    || fail "contract deployment failed — see ${LOG_DIR}/local-setup.log"
  step "EntryPoint, factory, paymaster (funded + staked), SimpleAccount"
else
  log "contracts already deployed on this chain, skipping"
fi

# ------------------------------------------------------------------------------------------------
# the backend's environment
# ------------------------------------------------------------------------------------------------
#
# local-setup writes host-facing values. The backend runs INSIDE the compose network, where anvil is
# `anvil:8545` and not `127.0.0.1:8545`. Rewriting that here is the step people forget, and its
# symptom — a backend that boots fine and then fails every sponsorship — points nowhere near it.
log "writing .env for the stack"
if [ ! -f "${ROOT}/deploy/.env.local" ]; then
  fail "deploy/.env.local is missing; run ./start.sh --fresh"
fi

python3 <<'PY'
import pathlib, secrets

# cwd is the repo root: the script cd'd there at the top.
src = pathlib.Path("deploy/.env.local").read_text()
dst = pathlib.Path(".env")

# Only the keys the compose stack needs. Copying the whole file would drag host-only values
# (ACCOUNT_OWNER_KEY, PAYMASTER_URL) into the backend's environment, where they mean nothing.
import os

wanted = ["SPONSORSHIP_SIGNER_KEY", "BOOTSTRAP_API_KEY", "CHAINS"]
# Written into .env rather than left in the shell, so `docker compose` run BY HAND afterwards binds
# the same ports this script chose. Otherwise the next `docker compose up` reverts to 5432 and
# fails exactly the way this run just did.
host_ports = {k: os.environ[k] for k in ("POSTGRES_HOST_PORT", "REDIS_HOST_PORT") if os.environ.get(k)}
values = {}
for line in src.splitlines():
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    key, _, value = line.partition("=")
    key = key.strip()
    if key in wanted:
        values[key] = value.strip()

chains = values.get("CHAINS", "")
# The one rewrite that matters. Both quoted forms, because local-setup single-quotes this value.
chains = chains.replace("http://127.0.0.1:8545", "http://anvil:8545").replace("http://localhost:8545", "http://anvil:8545")
values["CHAINS"] = chains

# Dashboard sign-in needs the backend to verify tokens from the SAME Privy app the browser used,
# and to hold a secret for the sessions it issues. Both are derived rather than asked for: the app
# id is already in web/.env.local, and the session secret is a devnet value nobody should have to
# invent. Without them /auth/* answers 503 and the dashboard cannot sign anyone in — which is a
# confusing wall to hit when the browser side is configured and looks fine.
identity = {}
web_env = pathlib.Path("web/.env.local")
if web_env.exists():
    for line in web_env.read_text().splitlines():
        if line.strip().startswith("NEXT_PUBLIC_PRIVY_APP_ID="):
            app_id = line.split("=", 1)[1].strip()
            if app_id:
                identity["PRIVY_APP_ID"] = app_id

existing = dst.read_text() if dst.exists() else ""

if "PRIVY_APP_ID" in identity:
    # Reused across restarts, so a session survives one. Regenerating would sign everyone out on
    # every boot, which reads as a login bug rather than as a fresh secret.
    previous_secret = next(
        (l.split("=", 1)[1] for l in existing.splitlines() if l.startswith("ADMIN_JWT_SECRET=") and len(l) > 49),
        None,
    )
    identity["ADMIN_JWT_SECRET"] = previous_secret or secrets.token_urlsafe(48)
    # A local devnet is exactly where signing yourself up should work without an operator.
    identity["TENANT_SELF_SIGNUP"] = "true"
preserved = [
    line for line in existing.splitlines()
    if "=" in line
    and line.split("=", 1)[0].strip() not in wanted
    and line.split("=", 1)[0].strip() not in host_ports
    and line.split("=", 1)[0].strip() not in identity
    and not line.startswith("# generated")
]

out = ["# generated by ./start.sh — devnet values from deploy/.env.local, rewritten for the",
       "# compose network (anvil:8545 rather than 127.0.0.1:8545). Safe to edit; regenerated on boot."]
out += [f"{k}={values[k]}" for k in wanted if k in values]
out += [f"{k}={v}" for k, v in host_ports.items()]
out += [f"{k}={v}" for k, v in identity.items()]
if preserved:
    out += ["", "# kept from the previous .env"] + preserved
dst.write_text("\n".join(out) + "\n")
note = " + dashboard sign-in" if "PRIVY_APP_ID" in identity else " (no PRIVY_APP_ID in web/.env.local)"
print(f"  · .env written ({len(values)} devnet values{note})")
PY

# ------------------------------------------------------------------------------------------------
# the stack
# ------------------------------------------------------------------------------------------------

log "starting postgres, redis, bundler and the backend"
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

API_KEY="$(grep -E '^BOOTSTRAP_API_KEY=' "${ROOT}/deploy/.env.local" | cut -d= -f2- || true)"

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
[ -n "${API_KEY}" ] && printf '  %-28s %s\n' "Devnet API key" "${API_KEY}"
echo
printf '  End-to-end sponsorship:  \033[1m(cd sdk && npx tsx examples/sponsor-and-send.ts)\033[0m\n'
printf '  Logs:                    %s\n' "${LOG_DIR}"
printf '  Stop everything:         \033[1m./start.sh stop\033[0m\n'
echo

if [ "${WITH_UI}" -eq 1 ] && [ ! -f "${ROOT}/web/.env.local" ]; then
  warn "web/.env.local is missing, so /dashboard cannot sign anyone in."
  warn "Copy web/.env.example and set NEXT_PUBLIC_PRIVY_APP_ID (and PRIVY_APP_ID for the backend)."
fi
