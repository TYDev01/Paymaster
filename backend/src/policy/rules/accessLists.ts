import {getAddress, type Address, type Hex} from "viem";

import {ALLOW, deny, type PolicyContext, type PolicyDecision} from "../context.js";
import type {PolicyRule} from "../rule.js";

/**
 * Addresses are compared as lowercase strings.
 *
 * `getAddress` normalises to EIP-55 checksummed form and throws on malformed input, so config
 * loaded from the database is validated once here rather than silently failing to match at
 * evaluation time. A blocklist that never matches because of a case difference is a security bug
 * that looks like nothing at all.
 */
function normaliseSet(addresses: Iterable<Address>): ReadonlySet<string> {
  const set = new Set<string>();
  for (const address of addresses) set.add(getAddress(address).toLowerCase());
  return set;
}

function has(set: ReadonlySet<string>, address: Address): boolean {
  return set.has(address.toLowerCase());
}

/** Sponsors only senders on the list. This is td.md's "Allowlist". */
export class SenderAllowlistRule implements PolicyRule {
  readonly name = "sender-allowlist";
  readonly cost = "pure" as const;
  readonly #allowed: ReadonlySet<string>;

  constructor(allowed: Iterable<Address>) {
    this.#allowed = normaliseSet(allowed);
  }

  evaluate(context: PolicyContext): PolicyDecision {
    if (has(this.#allowed, context.sender)) return ALLOW;
    return deny(this.name, "SENDER_NOT_ALLOWED", `sender ${context.sender} is not on the allowlist`);
  }
}

/** Refuses senders on the list. This is td.md's "Blocklist" / "Blacklist engine". */
export class SenderBlocklistRule implements PolicyRule {
  readonly name = "sender-blocklist";
  readonly cost = "pure" as const;
  readonly #blocked: ReadonlySet<string>;

  constructor(blocked: Iterable<Address>) {
    this.#blocked = normaliseSet(blocked);
  }

  evaluate(context: PolicyContext): PolicyDecision {
    if (has(this.#blocked, context.sender)) {
      return deny(this.name, "SENDER_BLOCKED", `sender ${context.sender} is blocked`);
    }
    return ALLOW;
  }
}

/**
 * Sponsors only operations whose every call targets an allowed contract.
 *
 * Denies when calldata could not be decoded: an account whose interface we do not recognise must
 * not thereby escape the allowlist.
 */
export class TargetAllowlistRule implements PolicyRule {
  readonly name = "target-allowlist";
  readonly cost = "pure" as const;
  readonly #allowed: ReadonlySet<string>;

  constructor(allowed: Iterable<Address>) {
    this.#allowed = normaliseSet(allowed);
  }

  evaluate(context: PolicyContext): PolicyDecision {
    if (context.calls === undefined) {
      return deny(
        this.name,
        "CALLDATA_UNDECODABLE",
        "callData does not match a known account interface, so its targets cannot be checked",
      );
    }
    for (const call of context.calls) {
      if (!has(this.#allowed, call.target)) {
        return deny(this.name, "TARGET_NOT_ALLOWED", `target ${call.target} is not on the allowlist`);
      }
    }
    return ALLOW;
  }
}

/**
 * Sponsors only operations whose every call invokes an allowed method.
 *
 * This is what implements td.md's per-token sponsorship policies: "sponsor USDC approvals" is a
 * target allowlist of the USDC address plus a method allowlist of `approve`'s selector. Nothing
 * about a token is special-cased — as td.md requires, the token never determines sponsorship, the
 * policy does.
 */
export class MethodAllowlistRule implements PolicyRule {
  readonly name = "method-allowlist";
  readonly cost = "pure" as const;
  readonly #allowed: ReadonlySet<string>;
  readonly #allowBareValueTransfer: boolean;

  /**
   * @param selectors 4-byte selectors, e.g. `0x095ea7b3` for `approve(address,uint256)`.
   * @param options.allowBareValueTransfer Whether a call with no calldata (a plain ETH send, which
   *        has no selector to check) is permitted. Defaults to false: a value transfer is not a
   *        method, so a method allowlist should not silently authorise one.
   */
  constructor(selectors: Iterable<Hex>, options: {allowBareValueTransfer?: boolean} = {}) {
    this.#allowed = new Set([...selectors].map((s) => s.toLowerCase()));
    this.#allowBareValueTransfer = options.allowBareValueTransfer ?? false;
  }

  evaluate(context: PolicyContext): PolicyDecision {
    if (context.calls === undefined) {
      return deny(
        this.name,
        "CALLDATA_UNDECODABLE",
        "callData does not match a known account interface, so its methods cannot be checked",
      );
    }
    for (const call of context.calls) {
      if (call.selector === undefined) {
        if (this.#allowBareValueTransfer) continue;
        return deny(this.name, "METHOD_NOT_ALLOWED", "bare value transfers are not sponsored");
      }
      if (!this.#allowed.has(call.selector.toLowerCase())) {
        return deny(this.name, "METHOD_NOT_ALLOWED", `method ${call.selector} is not on the allowlist`);
      }
    }
    return ALLOW;
  }
}

/** Sponsors only on enabled chains. This is td.md's "Enable chain" / "Disable chain". */
export class ChainEnabledRule implements PolicyRule {
  readonly name = "chain-enabled";
  readonly cost = "pure" as const;
  readonly #enabled: ReadonlySet<number>;

  constructor(enabled: Iterable<number>) {
    this.#enabled = new Set(enabled);
  }

  evaluate(context: PolicyContext): PolicyDecision {
    if (this.#enabled.has(context.chainId)) return ALLOW;
    return deny(this.name, "CHAIN_DISABLED", `chain ${context.chainId} is not enabled`);
  }
}

/**
 * Refuses operations that move native value.
 *
 * Sponsoring gas is a bounded, quantifiable cost. Sponsoring a call that also transfers ETH is
 * not: the paymaster does not fund the value, but a policy set that permits arbitrary value
 * transfers is usually a mistake, so this is available as an explicit guard.
 */
export class NoValueTransferRule implements PolicyRule {
  readonly name = "no-value-transfer";
  readonly cost = "pure" as const;

  evaluate(context: PolicyContext): PolicyDecision {
    if (context.calls === undefined) {
      return deny(this.name, "CALLDATA_UNDECODABLE", "callData could not be decoded to check for value transfers");
    }
    for (const call of context.calls) {
      if (call.value > 0n) {
        return deny(this.name, "VALUE_NOT_ALLOWED", `call to ${call.target} transfers ${call.value} wei`);
      }
    }
    return ALLOW;
  }
}
