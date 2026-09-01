#!/usr/bin/env bash
#
# Does this RPC endpoint qualify to run our bundler?
#
# Written after two endpoints failed at three different points, each one further along than the
# last, and each failure surfacing far from its cause: a paymaster that signs perfectly and a
# bundler that then refuses to submit. Run this BEFORE paying a provider.
#
# Usage:
#   ./deploy/check-rpc.sh https://your-endpoint
#   ./deploy/check-rpc.sh                        # reads RPC_URL from contracts/.env
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${1:-}"
if [ -z "${URL}" ]; then
  URL="$( (set -a; . "${ROOT}/contracts/.env" 2>/dev/null; set +a; printf '%s' "${RPC_URL:-}") )"
fi
[ -n "${URL}" ] || { echo "usage: $0 <rpc-url>   (or set RPC_URL in contracts/.env)" >&2; exit 2; }

ENTRYPOINT=0x0000000071727De22E5E9d8BAf0edAc6f37da032
pass=0; fail=0
mask() { sed -E 's#(/v2/|/v3/|\.com/)[A-Za-z0-9_-]{12,}#\1<key>#g'; }

rpc() { curl -s --max-time 30 -X POST "${URL}" -H 'Content-Type: application/json' -d "$1" 2>/dev/null; }

check() { # name, request, what-it-means-if-missing
  printf '  %-38s ' "$1"
  local out; out="$(rpc "$2")"
  case "${out}" in
    *'"result"'*) printf '\033[1;32mok\033[0m\n'; pass=$((pass+1)) ;;
    *) printf '\033[1;31mNO\033[0m  %s\n' "$3"
       [ -n "${out}" ] && printf '      %s\n' "$(printf '%s' "${out}" | head -c 120 | mask)"
       fail=$((fail+1)) ;;
  esac
}

echo "checking $(printf '%s' "${URL}" | mask)"
echo

check "eth_chainId" \
  '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "not reachable"

check "eth_getCode (EntryPoint v0.7)" \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"${ENTRYPOINT}\",\"latest\"]}" \
  "no EntryPoint on this chain"

# The one that matters, and the one every partial answer so far has failed. Rundler's safe-mode
# validation sends a JavaScript tracer. Serving debug_traceCall for BUILT-IN tracers only
# (callTracer, prestateTracer) is NOT enough — measured on Alchemy, which answers -32600 here.
check "debug_traceCall + custom JS tracer" \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"debug_traceCall\",\"params\":[{\"to\":\"${ENTRYPOINT}\",\"data\":\"0x\"},\"latest\",{\"tracer\":\"{data:[],fault:function(){},step:function(){},result:function(){return this.data}}\"}]}" \
  "rundler safe mode CANNOT run here"

echo
if [ "${fail}" -eq 0 ]; then
  printf '\033[1;32mqualifies\033[0m — %d/%d. Put it in contracts/.env as RPC_URL and re-run ./start.sh\n' "${pass}" "$((pass+fail))"
else
  printf '\033[1;31mdoes not qualify\033[0m — %d/%d passed.\n' "${pass}" "$((pass+fail))"
  echo "Known to work: QuickNode, Chainstack, or a self-hosted geth/reth with --http.api debug."
  echo "Known NOT to work: Alchemy, Infura, and every free public Sepolia endpoint tried."
  exit 1
fi
