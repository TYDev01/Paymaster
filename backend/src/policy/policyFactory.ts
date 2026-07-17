import {z} from "zod";
import {getAddress, isAddress, type Address, type Hex} from "viem";

import type {PolicyRule} from "./rule.js";
import type {QuotaStore} from "./quota/quotaStore.js";
import {QuotaRule} from "./rules/quotaRules.js";
import {
  ChainEnabledRule,
  MethodAllowlistRule,
  NoValueTransferRule,
  SenderAllowlistRule,
  SenderBlocklistRule,
  TargetAllowlistRule,
} from "./rules/accessLists.js";

/**
 * Turns stored rule rows into rule objects.
 *
 * The single most important property here: a rule that cannot be built THROWS, and the throw
 * aborts the whole reload. It does not skip the rule and carry on.
 *
 * That is not defensiveness for its own sake. Silently dropping a rule it does not understand
 * would mean an unrecognised `sender-blocklist` yields a policy that sponsors blocked senders, and
 * a typo'd quota config yields a policy with no spend cap. Both are worse than not reloading:
 * `PolicySource` keeps the last good set when a reload fails, so refusing degrades to "slightly
 * stale policy" while accepting degrades to "policy that does not enforce what it says".
 */

/**
 * Addresses are checksum-VERIFIED, not merely normalised.
 *
 * `getAddress` alone would not do this: it recomputes the checksum and returns the corrected form,
 * silently accepting a mistyped address. `isAddress(_, {strict: true})` is what actually rejects
 * one. That matters here because a typo in an allowlist means allowlisting the wrong contract, and
 * catching typos is the entire reason EIP-55 checksums exist.
 *
 * Strict mode accepts a correctly-checksummed address and an all-lowercase one (EIP-55 treats
 * uncased as simply un-checksummed), which are the two forms operators actually paste. It rejects
 * all-uppercase and any mixed case whose checksum does not verify.
 */
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte address")
  .refine((value) => isAddress(value, {strict: true}), "failed EIP-55 checksum verification (is it mistyped?)")
  .transform((value) => getAddress(value) as Address);

const selectorSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/, "must be a 4-byte selector")
  .transform((value) => value.toLowerCase() as Hex);

/**
 * Amounts are strings, never JSON numbers. A wei limit exceeds Number.MAX_SAFE_INTEGER routinely,
 * and JSON.parse would silently round it — producing a spend cap subtly different from the one an
 * operator configured, with nothing to indicate it.
 */
const bigintSchema = z
  .string()
  .regex(/^[0-9]+$/, "must be a non-negative integer string")
  .transform((value) => BigInt(value));

const RULE_SCHEMAS = {
  "chain-enabled": z.object({
    chainIds: z.array(z.number().int().positive()).min(1),
  }),
  "sender-allowlist": z.object({
    addresses: z.array(addressSchema).min(1),
  }),
  "sender-blocklist": z.object({
    addresses: z.array(addressSchema).min(1),
  }),
  "target-allowlist": z.object({
    addresses: z.array(addressSchema).min(1),
  }),
  "method-allowlist": z.object({
    selectors: z.array(selectorSchema).min(1),
    allowBareValueTransfer: z.boolean().optional(),
  }),
  "no-value-transfer": z.object({}),
  quota: z.object({
    name: z.string().min(1).max(64),
    subject: z.enum(["wallet", "ip", "apiKey", "chain", "target", "global"]),
    unit: z.enum(["operations", "wei"]),
    limit: bigintSchema,
    windowSeconds: z.number().int().positive().max(31_536_000),
    onMissingSubject: z.enum(["deny", "skip"]).optional(),
  }),
} as const;

export type RuleType = keyof typeof RULE_SCHEMAS;

export const RULE_TYPES = Object.keys(RULE_SCHEMAS) as readonly RuleType[];

export function isRuleType(value: string): value is RuleType {
  return Object.hasOwn(RULE_SCHEMAS, value);
}

export class InvalidRuleConfigError extends Error {
  constructor(policyId: string, ruleType: string, detail: string) {
    super(`policy "${policyId}" rule "${ruleType}": ${detail}`);
    this.name = "InvalidRuleConfigError";
  }
}

export interface PolicyRuleSpec {
  readonly ruleType: string;
  readonly config: unknown;
}

/**
 * Builds rules from stored configuration.
 *
 * Holds the quota store because quota rules need it — which is also why this is a class and not a
 * free function: the store is a deployment-wide dependency, not per-rule configuration, and it
 * must not be expressible in a policy row.
 */
export class PolicyFactory {
  constructor(private readonly quotas: QuotaStore) {}

  build(policyId: string, spec: PolicyRuleSpec): PolicyRule {
    if (!isRuleType(spec.ruleType)) {
      throw new InvalidRuleConfigError(
        policyId,
        spec.ruleType,
        `unknown rule type; known types are ${RULE_TYPES.join(", ")}`,
      );
    }

    const parsed = RULE_SCHEMAS[spec.ruleType].safeParse(spec.config ?? {});
    if (!parsed.success) {
      throw new InvalidRuleConfigError(
        policyId,
        spec.ruleType,
        parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; "),
      );
    }

    return this.#construct(spec.ruleType, parsed.data);
  }

  /**
   * Note the absence of a `default` branch. `RuleType` is derived from RULE_SCHEMAS, so adding a
   * schema without a constructor is a compile error rather than a runtime surprise.
   */
  #construct(ruleType: RuleType, config: RuleConfig): PolicyRule {
    switch (ruleType) {
      case "chain-enabled":
        return new ChainEnabledRule((config as RuleConfigFor<"chain-enabled">).chainIds);
      case "sender-allowlist":
        return new SenderAllowlistRule((config as RuleConfigFor<"sender-allowlist">).addresses);
      case "sender-blocklist":
        return new SenderBlocklistRule((config as RuleConfigFor<"sender-blocklist">).addresses);
      case "target-allowlist":
        return new TargetAllowlistRule((config as RuleConfigFor<"target-allowlist">).addresses);
      case "method-allowlist": {
        const c = config as RuleConfigFor<"method-allowlist">;
        return new MethodAllowlistRule(
          c.selectors,
          c.allowBareValueTransfer === undefined ? {} : {allowBareValueTransfer: c.allowBareValueTransfer},
        );
      }
      case "no-value-transfer":
        return new NoValueTransferRule();
      case "quota": {
        const c = config as RuleConfigFor<"quota">;
        return new QuotaRule(this.quotas, {
          name: c.name,
          subject: c.subject,
          unit: c.unit,
          limit: c.limit,
          windowSeconds: c.windowSeconds,
          ...(c.onMissingSubject === undefined ? {} : {onMissingSubject: c.onMissingSubject}),
        });
      }
    }
  }
}

type RuleConfigFor<T extends RuleType> = z.infer<(typeof RULE_SCHEMAS)[T]>;
type RuleConfig = RuleConfigFor<RuleType>;
