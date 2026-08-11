import {
  LuActivity,
  LuBell,
  LuCoins,
  LuLink,
  LuShieldAlert,
  LuScrollText,
} from "react-icons/lu";
import type {IconType} from "react-icons";

/**
 * The navigation, ordered the way an incident is triaged rather than alphabetically: is it serving,
 * is the chain reachable, is there money, is someone attacking, what did we configure, what pages.
 * The same ordering as the Grafana dashboard's rows, deliberately — an operator switching between
 * the two should not have to re-learn where anything is.
 */
export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: IconType;
  readonly description: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {href: "/", label: "Overview", icon: LuActivity, description: "Sponsorship, decisions, latency"},
  {href: "/chains", label: "Chains", icon: LuLink, description: "RPC health, heads, circuit breakers"},
  {href: "/funding", label: "Funding", icon: LuCoins, description: "Deposit and stake per chain"},
  {href: "/security", label: "Security", icon: LuShieldAlert, description: "Auth failures, throttling, blocks"},
  {href: "/policies", label: "Policies", icon: LuScrollText, description: "Rule sets and API keys"},
  {href: "/alerts", label: "Alerts", icon: LuBell, description: "The rule catalogue and its runbooks"},
];
