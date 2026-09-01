/**
 * A JSON-RPC router that lets a free-tier bundler work.
 *
 * THE PROBLEM IT SOLVES. Rundler needs `debug_traceCall` with a CUSTOM JS TRACER, which almost no
 * provider serves — measured: Alchemy and Infura reject it outright, every free public Sepolia
 * endpoint lacks `debug_*` entirely. QuickNode does serve it, but its free tier caps requests at
 * 15/second, and rundler issues ~1000 requests per two minutes (measured: 541 eth_call, 520
 * eth_getLogs) purely tracking the chain. So the one provider that CAN validate is exhausted by
 * traffic that has nothing to do with validating.
 *
 * The observation this is built on: only `debug_*` actually needs the scarce endpoint. eth_call,
 * eth_getLogs and eth_blockNumber are ordinary reads any endpoint serves. Splitting them by method
 * spends the scarce quota only where it is irreplaceable.
 *
 *     debug_*        -> TRACE_RPC_URL     (QuickNode; rate-limited to stay under its cap)
 *     everything else -> DEFAULT_RPC_URL  (publicnode, Alchemy, anything)
 *
 * Batches are split and reassembled, because a batch that mixes a debug call with ordinary reads
 * would otherwise force the whole batch onto the scarce endpoint.
 */
import {createServer} from "node:http";
import {request as httpsRequest} from "node:https";
import {request as httpRequest} from "node:http";
import {Agent as HttpsAgent} from "node:https";
import {Agent as HttpAgent} from "node:http";

/**
 * Keep-alive agents, and the reason they are not optional.
 *
 * Node's global `fetch` opens a fresh connection per burst request, and each one does a DNS
 * lookup. Under rundler's load that produced intermittent `EAI_AGAIN` from Docker's resolver —
 * measured at roughly 1 in 6 requests — which surfaced as "fetch failed" and killed the user
 * operation. Reusing sockets makes lookups rare instead of per-request.
 */
const agents = {
  "https:": new HttpsAgent({keepAlive: true, maxSockets: 32, keepAliveMsecs: 30_000}),
  "http:": new HttpAgent({keepAlive: true, maxSockets: 32, keepAliveMsecs: 30_000}),
};

/** POST JSON over a pooled socket. Returns {status, json}. */
function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(payload);
    const doRequest = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = doRequest(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: "POST",
        agent: agents[u.protocol],
        headers: {"content-type": "application/json", "content-length": Buffer.byteLength(body)},
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null});
          } catch (err) {
            reject(new Error(`bad JSON from upstream (${res.statusCode}): ${raw.slice(0, 120)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

const TRACE_URL = process.env.TRACE_RPC_URL ?? "";
const DEFAULT_URL = process.env.DEFAULT_RPC_URL ?? "";
const PORT = Number(process.env.PORT ?? 8546);
// Under QuickNode's free 15/s, with room for the retry burst that a 429 would otherwise cause.
const TRACE_RPS = Number(process.env.TRACE_RPS ?? 8);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 45_000);

if (!TRACE_URL || !DEFAULT_URL) {
  console.error("rpc-router: TRACE_RPC_URL and DEFAULT_RPC_URL are both required");
  process.exit(1);
}

const isTraceMethod = (m) => typeof m === "string" && (m.startsWith("debug_") || m.startsWith("trace_"));

/**
 * A token bucket over the trace lane.
 *
 * Queued rather than rejected: a 429 returned to rundler surfaces as "internal error: rpc provider
 * error" and fails the whole user operation, whereas waiting 100ms costs nothing anyone notices.
 */
let tokens = TRACE_RPS;
let lastRefill = Date.now();
const waiters = [];
setInterval(() => {
  const now = Date.now();
  tokens = Math.min(TRACE_RPS, tokens + ((now - lastRefill) / 1000) * TRACE_RPS);
  lastRefill = now;
  while (waiters.length > 0 && tokens >= 1) {
    tokens -= 1;
    waiters.shift()();
  }
}, 50).unref();

function takeTraceToken() {
  if (tokens >= 1) {
    tokens -= 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

const stats = {trace: 0, default: 0, retried: 0, failed: 0, lastError: null};

async function forward(url, payload, isTrace) {
  if (isTrace) await takeTraceToken();
  // 5 attempts, not 3: two of the failure modes here are transient by nature (a 429 from a
  // per-second cap, and EAI_AGAIN from the container resolver) and both clear within a moment.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await postJson(url, payload, UPSTREAM_TIMEOUT_MS);
      // 429/503 are what the free tiers return under load. Backing off and retrying turns a hard
      // user-operation failure into a slightly slower one.
      if (res.status === 429 || res.status === 503) {
        stats.retried += 1;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return res.json;
    } catch (err) {
      stats.retried += 1;
      if (attempt === 4) {
        stats.failed += 1;
        stats.lastError = String(err?.message ?? err).slice(0, 120);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  stats.failed += 1;
  throw new Error("upstream exhausted");
}

async function handle(body) {
  if (Array.isArray(body)) {
    // Split, send each group as its own batch, then reassemble in the ORDER THE CALLER SENT.
    // JSON-RPC allows a server to answer a batch out of order, but rundler's provider matches on
    // id, so preserving ids matters more than order — both are preserved here regardless.
    const traceCalls = body.filter((c) => isTraceMethod(c?.method));
    const otherCalls = body.filter((c) => !isTraceMethod(c?.method));
    const [traceRes, otherRes] = await Promise.all([
      traceCalls.length ? forward(TRACE_URL, traceCalls, true) : [],
      otherCalls.length ? forward(DEFAULT_URL, otherCalls, false) : [],
    ]);
    stats.trace += traceCalls.length;
    stats.default += otherCalls.length;
    const merged = new Map();
    for (const r of [...(traceRes ?? []), ...(otherRes ?? [])]) merged.set(r?.id, r);
    return body.map((c) => merged.get(c?.id) ?? {jsonrpc: "2.0", id: c?.id ?? null, error: {code: -32603, message: "no response for id"}});
  }
  const trace = isTraceMethod(body?.method);
  if (trace) stats.trace += 1;
  else stats.default += 1;
  return forward(trace ? TRACE_URL : DEFAULT_URL, body, trace);
}

createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify({ok: true, ...stats}));
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, {"content-type": "application/json"});
      res.end(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32700, message: "parse error"}}));
      return;
    }
    try {
      const out = await handle(body);
      res.writeHead(200, {"content-type": "application/json"});
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(200, {"content-type": "application/json"});
      res.end(JSON.stringify({jsonrpc: "2.0", id: body?.id ?? null, error: {code: -32603, message: `router: ${err?.message ?? err}`}}));
    }
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`rpc-router on :${PORT}  debug_*/trace_* -> trace upstream (${TRACE_RPS}/s), rest -> default`);
});

setInterval(() => console.log(`rpc-router stats ${JSON.stringify(stats)}`), 30_000).unref();
