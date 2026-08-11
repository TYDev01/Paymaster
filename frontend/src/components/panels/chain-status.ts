import type {ChainView, Severity} from "@/lib/telemetry";

/**
 * One chain's worst current condition, and the words for it.
 *
 * The ordering is by what stops sponsorship soonest, not by how alarming the metric sounds:
 *
 *   1. An unhealthy RPC means nothing on that chain can be priced or validated at all.
 *   2. A drained deposit means every operation fails on chain, at the EntryPoint.
 *   3. An open circuit means reads are being refused deliberately — usually downstream of (1).
 *   4. Unreadable funding means the balance is UNKNOWN, which is not the same as fine.
 *   5. Low stake degrades bundler acceptance rather than failing transactions already accepted.
 *
 * Shared between the strip and the detail page so the two can never disagree about a chain's state,
 * which would be worse than either being wrong on its own.
 */
export function chainSeverity(chain: ChainView): Severity {
  if (chain.healthy === false) return "critical";
  if (chain.depositBelowThreshold === true) return "critical";
  if (chain.circuitOpen === true) return "serious";
  if (chain.fundingUnreadable) return "serious";
  if (chain.stakeBelowThreshold === true) return "warning";
  if (chain.healthy === undefined) return "unknown";
  return "good";
}

export function chainStatusLabel(chain: ChainView): string {
  if (chain.healthy === false) return "RPC unhealthy";
  if (chain.depositBelowThreshold === true) return "Deposit below threshold";
  if (chain.circuitOpen === true) return "Circuit open";
  if (chain.fundingUnreadable) return "Funding unreadable";
  if (chain.stakeBelowThreshold === true) return "Stake below threshold";
  if (chain.healthy === undefined) return "Unknown";
  return "Healthy";
}
