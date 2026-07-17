import {z} from "zod";

import {RULE_TYPES} from "../../policy/policyFactory.js";
import {ROLE_NAMES} from "../../auth/permissions.js";

/**
 * Admin request shapes.
 *
 * Rule `config` is passed through as unknown and validated by PolicyFactory against the schema for
 * its rule type. Validating it twice — once here, once there — would be two schemas to keep in
 * step, and the one that matters is the one that actually builds the rule.
 */
export const policyRuleSchema = z.object({
  ruleType: z.enum(RULE_TYPES as unknown as [string, ...string[]]),
  config: z.unknown().optional(),
});

export const upsertPolicySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/, "must be 1-128 chars of [a-zA-Z0-9._:-]"),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  enabled: z.boolean().default(true),
  rules: z.array(policyRuleSchema).max(50),
});

export type UpsertPolicyRequest = z.infer<typeof upsertPolicySchema>;

export const createKeySchema = z.object({
  name: z.string().min(1).max(200),
  roles: z.array(z.enum(ROLE_NAMES as unknown as [string, ...string[]])).min(1),
  /** Pins the key to a policy. Without it, the key may name a policy in the request body. */
  policyId: z.string().max(128).optional(),
  environment: z.enum(["live", "test"]).default("live"),
  /** Unix seconds. Absent means no expiry — discouraged, but some integrations need it. */
  expiresAt: z.number().int().positive().optional(),
});

export type CreateKeyRequest = z.infer<typeof createKeySchema>;

export const listSponsorshipsSchema = z.object({
  apiKeyId: z.string().max(128).optional(),
  chainId: z.coerce.number().int().positive().optional(),
  sender: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
});

export const listAuditSchema = z.object({
  actor: z.string().max(128).optional(),
  action: z.string().max(128).optional(),
  since: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
});

/**
 * A key as returned by the admin API.
 *
 * The secret appears exactly once, in the response to the create call that generated it, and is
 * never in a list response — because it is not stored and cannot be. Listing keys must therefore
 * be a safe, boring operation an operator can do without leaking credentials to their screen.
 */
export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly displayPrefix: string;
  readonly roles: readonly string[];
  readonly policyId: string | undefined;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly expiresAt: number | undefined;
  readonly lastUsedAt: number | undefined;
}

export interface CreatedApiKeyView extends ApiKeyView {
  /** Shown once. Not recoverable: only the hash is stored. */
  readonly secret: string;
}
