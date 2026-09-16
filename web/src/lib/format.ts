/**
 * Formatting for values an operator has to compare at a glance.
 *
 * Every function here is about making numbers COMPARABLE rather than precise. A dashboard is read
 * in seconds, and "0.0421 ETH" beside "1.2e18 wei" costs more attention than either is worth.
 */

const WEI_PER_ETH = 1e18;

/**
 * Wei as a native-token amount.
 *
 * Takes a `number` because that is what a Prometheus gauge is — the backend already accepted the
 * float64 rounding when it exported the series, and re-introducing bigint here would imply a
 * precision the source does not have. Displayed to 4 decimals: enough to see a deposit move,
 * few enough not to imply wei-level accuracy.
 */
export function formatEth(wei: number | undefined, decimals = 4): string {
  if (wei === undefined || !Number.isFinite(wei)) return "—";
  const eth = wei / WEI_PER_ETH;
  if (eth !== 0 && Math.abs(eth) < 10 ** -decimals) return `<${(10 ** -decimals).toFixed(decimals)}`;
  return eth.toFixed(decimals);
}

/** A count, compacted past a thousand. `undefined` renders as an em dash, never as zero. */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  return new Intl.NumberFormat("en", {notation: "compact", maximumFractionDigits: 1}).format(value);
}

/** A rate, with enough precision to distinguish "idle" from "slow". */
export function formatRate(perSecond: number | undefined, unit = "/s"): string {
  if (perSecond === undefined || !Number.isFinite(perSecond)) return "—";
  if (perSecond === 0) return `0${unit}`;
  if (perSecond < 0.01) return `<0.01${unit}`;
  if (perSecond < 10) return `${perSecond.toFixed(2)}${unit}`;
  return `${formatCount(perSecond)}${unit}`;
}

export function formatPercent(ratio: number | undefined, decimals = 2): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** Seconds as the largest sensible unit — sub-millisecond latencies are common here. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 0.001) return `${(seconds * 1_000_000).toFixed(0)}µs`;
  if (seconds < 1) return `${(seconds * 1_000).toFixed(seconds < 0.01 ? 2 : 1)}ms`;
  return `${seconds.toFixed(2)}s`;
}

export function formatMillis(ms: number | undefined): string {
  return ms === undefined ? "—" : formatDuration(ms / 1000);
}

/** "4s ago". Freshness is load-bearing on this page: stale data that looks live is the failure. */
export function formatAge(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined) return "never";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function formatBlock(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en").format(Math.round(value));
}

/** Chain ids the operator will recognise; anything else falls back to the number itself. */
const CHAIN_NAMES: Record<string, string> = {
  "1": "Ethereum",
  "10": "Optimism",
  "56": "BNB Chain",
  "137": "Polygon",
  "8453": "Base",
  "42161": "Arbitrum",
  "11155111": "Ethereum Sepolia",
};

export function chainName(chainId: string): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function shortAddress(address: string | undefined): string {
  if (address === undefined || address.length < 12) return address ?? "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
