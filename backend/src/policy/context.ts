import type {Address, Hex} from "viem";

import type {PackedUserOperation} from "../domain/userOperation.js";

/**
 * Everything a policy is allowed to decide on.
 *
 * Assembled once per sponsorship request by the API layer, then passed to every rule. Rules
 * receive it read-only and never fetch their own request-scoped data, so an evaluation is
 * reproducible from this object alone — which is what makes a denial explainable after the fact.
 */
export interface PolicyContext {
  readonly chainId: number;
  readonly sender: Address;
  readonly userOp: PackedUserOperation;

  /**
   * What the operation calls, decoded from `callData`. Absent when the account's calldata does not
   * match a shape we understand — see `decodeCallTargets`. Rules that need a target MUST deny when
   * this is absent rather than pass; an unrecognised account must not be a way to bypass an
   * allowlist.
   */
  readonly calls: readonly DecodedCall[] | undefined;

  /** Caller identity, for per-IP and per-key quotas. Absent for internal callers. */
  readonly clientIp: string | undefined;
  readonly apiKeyId: string | undefined;

  /**
   * Upper bound on what this operation can cost the paymaster, in wei. Derived from the
   * UserOperation's gas limits and fees — the same arithmetic the EntryPoint uses for
   * `requiredPreFund`. Spend caps charge against this, not against actual cost, because actual
   * cost is not knowable until the operation executes.
   */
  readonly maxCost: bigint;

  /** Unix seconds. Passed in rather than read from the clock so evaluation is deterministic. */
  readonly now: number;
}

/** A single call the UserOperation makes, decoded from the account's calldata. */
export interface DecodedCall {
  readonly target: Address;
  readonly value: bigint;
  /** The 4-byte selector of the inner call, or undefined for a bare value transfer. */
  readonly selector: Hex | undefined;
  readonly data: Hex;
}

/**
 * Why a sponsorship was refused.
 *
 * `code` is a stable machine-readable identifier — safe to use as a metric label and to alert on.
 * `reason` is for operators and may change. Neither is returned to untrusted callers verbatim:
 * telling an attacker which rule stopped them helps them probe the policy set.
 */
export interface PolicyDenial {
  readonly allowed: false;
  readonly code: PolicyDenialCode;
  readonly rule: string;
  readonly reason: string;
}

export interface PolicyApproval {
  readonly allowed: true;
}

export type PolicyDecision = PolicyApproval | PolicyDenial;

export const POLICY_DENIAL_CODES = [
  "CHAIN_DISABLED",
  "SENDER_NOT_ALLOWED",
  "SENDER_BLOCKED",
  "TARGET_NOT_ALLOWED",
  "METHOD_NOT_ALLOWED",
  "CALLDATA_UNDECODABLE",
  "QUOTA_EXCEEDED",
  "SPEND_CAP_EXCEEDED",
  "VALUE_NOT_ALLOWED",
  "RULE_ERROR",
] as const;

export type PolicyDenialCode = (typeof POLICY_DENIAL_CODES)[number];

export const ALLOW: PolicyApproval = Object.freeze({allowed: true});

export function deny(rule: string, code: PolicyDenialCode, reason: string): PolicyDenial {
  return {allowed: false, code, rule, reason};
}
