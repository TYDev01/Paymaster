import {z} from "zod";
import type {Hex} from "viem";

import type {ChainConfig} from "../chain/chainConfig.js";

/**
 * Environment validation. Fails at startup with every problem listed, rather than at the first
 * request with one.
 *
 * td.md requires "environment validation" and "no hardcoded secrets". The rule enforced here is
 * that nothing security-relevant has a default: an operator who forgets to set the signer key gets
 * a startup crash, never a silently-generated throwaway key that would make every sponsorship fail
 * on-chain in a way that looks like a contract bug.
 */

const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex string")
  .transform((v) => v as Hex);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default("0.0.0.0"),

  /**
   * The sponsorship signing key.
   *
   * No default, and never logged. This is the development path; in production this variable should
   * be absent and a KMS-backed signer configured instead — see SponsorshipSigner. Holding the key
   * in process memory is a deliberate development convenience, not a production posture.
   */
  SPONSORSHIP_SIGNER_KEY: hex32,

  /** Chains, as JSON. Parsed and validated by `parseChainsJson`. */
  CHAINS: z.string().min(1),

  /**
   * PostgreSQL connection string.
   *
   * Optional. Without it the service runs on in-memory stores: correct for a single process, but
   * API keys vanish on restart and sponsorship records are not kept. Required for anything
   * multi-replica or auditable — `bootstrap` warns when it is absent.
   */
  DATABASE_URL: z.string().url().optional(),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  /** Run pending migrations at startup. See migrate() for why this is safe under rolling deploys. */
  DATABASE_MIGRATE_ON_BOOT: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),

  SPONSORSHIP_VALIDITY_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  PAYMASTER_VERIFICATION_GAS_LIMIT: z.coerce.bigint().default(300_000n),
  POSTOP_GAS_LIMIT: z.coerce.bigint().default(50_000n),
  DEFAULT_POLICY_ID: z.string().min(1).default("default"),

  /**
   * Seeds an admin API key at startup, solving the chicken-and-egg of a key-authenticated service
   * with no keys. Only its hash is stored. Generate one with `npm run key:generate`.
   *
   * Optional, and its absence is safe: with no keys the store is empty and every request 401s. A
   * paymaster that spends money should be unreachable when misconfigured, never open.
   */
  BOOTSTRAP_API_KEY: z
    .string()
    .regex(/^pm_(live|test)_[A-Za-z0-9_-]{40,}$/, "must be a well-formed API key")
    .optional(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(`invalid environment:\n  ${issues.join("\n  ")}`);
    this.name = "EnvValidationError";
  }
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Reports the variable names, never their values: this message reaches logs and a bad
    // SPONSORSHIP_SIGNER_KEY would otherwise print the key.
    throw new EnvValidationError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  return result.data;
}

const chainJsonSchema = z.array(
  z.object({
    chainId: z.number().int().positive(),
    name: z.string().min(1),
    rpcUrls: z.array(z.string().url()).min(1),
    entryPoint: z.string(),
    paymaster: z.string(),
    explorerUrl: z.string().url(),
    nativeCurrency: z.object({symbol: z.string().min(1), decimals: z.number().int()}),
    minDepositWei: z.union([z.string(), z.number()]).transform((v) => BigInt(v)),
    minStakeWei: z.union([z.string(), z.number()]).transform((v) => BigInt(v)),
    enabled: z.boolean().default(true),
  }),
);

/**
 * Parses the CHAINS variable into configs.
 *
 * Shape-checked here; semantics (address validity, RPC reachability, canonical EntryPoint) are
 * ChainRegistry's job. Keeping those separate means the deeper checks apply to configs from any
 * source, not just this one.
 */
export function parseChainsJson(json: string): readonly ChainConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new EnvValidationError([`CHAINS: not valid JSON: ${(cause as Error).message}`]);
  }

  const result = chainJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues.map((i) => `CHAINS[${i.path.join(".")}]: ${i.message}`));
  }

  return result.data as readonly ChainConfig[];
}
