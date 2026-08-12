# Paymaster Console

An operations dashboard for the paymaster backend: sponsorship decisions, chain health, funding,
abuse, the policy set, and the alert catalogue.

Next.js 16 (App Router) · Tailwind v4 · shadcn/ui · react-icons · Motion · Recharts.

```bash
npm install
cp .env.example .env.local     # point it at your backend
npm run dev                    # http://localhost:3000
```

---

## What it reads, and what it does not invent

Everything on screen comes from the backend's own endpoints. There is no seeded demo data and no
placeholder series: when the backend is unreachable the console says so and keeps showing the last
good scrape with its age, because a dashboard that silently displays stale or invented numbers is
worse than one that displays nothing.

| Source | Used for |
| --- | --- |
| `GET /metrics` | Every number on Overview, Chains, Funding and Security |
| `GET /health/ready` | Per-chain health and RPC latency, and the policy generation |
| `GET /admin/*` | Policies and API keys (read-only, server-side credential) |
| `deploy/monitoring/prometheus/alerts.yml` | The alert catalogue and its runbook links |

### Charts start empty, on purpose

The backend exports a Prometheus **snapshot** — counters and gauges as they stand right now. It has
no history, so this console builds one the only honest way available: poll on an interval, keep the
samples in the tab, and difference consecutive counters to get rates. Consequences, both stated in
the UI rather than hidden:

- a freshly opened page has one sample and therefore no rates yet;
- the window belongs to the browser tab and does not survive a reload.

This is a live console, not a metrics store. For history across restarts, over days, with alert
evaluation, Prometheus is already scraping the same endpoint — use the Grafana dashboard in
[`deploy/monitoring/`](../deploy/monitoring/), which reads exactly these series.

A counter that goes *backwards* means the backend restarted. That sample is dropped rather than
drawn as a negative rate or a spike, and the line breaks where the gap is.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PAYMASTER_API_URL` | `http://127.0.0.1:3000` | Backend base URL, reached from the **server** |
| `PAYMASTER_ADMIN_KEY` | — | Enables the Policies page. Server-side only |
| `PAYMASTER_ALERT_RULES` | `../deploy/monitoring/prometheus/alerts.yml` | Path to the rule file |
| `PAYMASTER_TIMEOUT_MS` | `5000` | Per-request timeout to the backend |

**The admin key never reaches the browser.** The console talks to its own route handlers, and only
those handlers hold the credential — which also means the backend needs no CORS and need not be
publicly reachable, only this server does.

The admin proxy is **GET-only against an allowlist of four resources**. A generic path passthrough
would have forwarded anything a caller wrote — including `DELETE /admin/keys/:id` — with the
server's admin credential attached. This console observes; it does not change what gets sponsored.

## Design

**Oil dark and ash silver.** A near-black surface with a faint green cast, and desaturated silver
ink rather than white: this is read for hours in a dim room beside a terminal, and pure white on
near-black vibrates at that dwell time. Tokens live on `:root` in `globals.css`; the app is
dark-only and deliberately so, rather than shipping a half-supported light mode.

**Series colors are not decorative.** They are the validated categorical steps for a dark surface,
checked against *this* app's chart surface (`#0d1010`) with the palette validator — lightness band,
chroma floor, colorblind separation, normal-vision floor and 3:1 contrast all pass. The slot
**order** is the colorblind-safety mechanism, so do not hand-edit a `--series-*` value without
re-validating. Status colors (good/warning/serious/critical) are reserved, never reused as a series
color, and never shown without an icon and a label — so a red mark always means a fault, and nothing
depends on color alone.

Charts follow a few fixed rules: 2px lines, area fills as a ~10% wash, a 2px surface gap between
stacked bands, ≥8px hover targets with a surface ring, recessive gridlines, and a legend whenever
there are two or more series. A series with no height in the window is drawn as nothing and marked
"none" in the legend — in a stack, a zero-valued series otherwise traces the top edge of the band
below it and, painted last, impersonates it.

## Layout

```
src/app/            Pages and the route handlers that talk to the backend
src/components/
  shell/            Rail, top bar, connection state
  viz/              Panel, stat tile, charts, status pills, chart theme
  panels/           Composed panels shared across pages
src/hooks/          The polling loop and the rolling window
src/lib/            Prometheus parser, telemetry shaping, formatting, backend client
```

`src/lib/prometheus.ts` parses the text exposition format directly. The backend serves no JSON
metrics API, and adding one to a service that spends money — purely so a dashboard has a friendlier
shape — would be a second surface to keep correct.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
```
