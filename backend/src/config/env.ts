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

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    HOST: z.string().default("0.0.0.0"),

    /**
     * The sponsorship signing key, for the local (in-process) signer.
     *
     * No default, and never logged. This is the development path; in production leave it unset and set
     * SPONSORSHIP_SIGNER_KMS_KEY_ID instead, so the key never enters this process. Exactly one of the
     * two must be set — enforced below.
     */
    SPONSORSHIP_SIGNER_KEY: hex32.optional(),

    /**
     * KMS key id/ARN for the KMS-backed signer. When set, the signer key never enters this process:
     * signing is a KMS API call. The key must be an asymmetric ECC_SECG_P256K1 SIGN_VERIFY key.
     * Requires the @aws-sdk/client-kms package (an optional dependency).
     */
    SPONSORSHIP_SIGNER_KMS_KEY_ID: z.string().min(1).optional(),
    /** AWS region for KMS. Optional; the AWS SDK also resolves it from the standard environment. */
    AWS_REGION: z.string().min(1).optional(),

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

    /**
     * Redis connection string.
     *
     * Optional, and its absence is a real limitation rather than a nicety: without it quota counters
     * live in process memory, so N replicas give every caller N times their quota. Required for any
     * horizontally scaled deployment — `bootstrap` warns when it is missing.
     */
    REDIS_URL: z.string().url().optional(),

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

    /**
     * Deposit / stake monitor.
     *
     * Polls every chain's paymaster funding against its configured thresholds and alerts before
     * sponsorship silently fails. On by default: a paymaster that spends money should watch its own
     * balance unless an operator deliberately turns it off.
     */
    FUNDING_MONITOR_ENABLED: boolFromEnv(true),
    FUNDING_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    /** How long an unresolved low-funding alert waits before re-firing. */
    FUNDING_MONITOR_REALERT_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),

    /**
     * Spend-cap reconciliation loop.
     *
     * Trues spend counters up to actual on-chain cost. Requires a database (it correlates events to
     * the sponsorships table); enabled by default but a no-op without DATABASE_URL.
     */
    RECONCILER_ENABLED: boolFromEnv(true),
    RECONCILER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    /** Blocks to stay behind head, so a reorg does not reconcile against an orphaned event. */
    RECONCILER_CONFIRMATIONS: z.coerce.number().int().min(0).max(1_000).default(5),
    /** Cap on blocks scanned per chain per tick, to bound a single eth_getLogs span. */
    RECONCILER_MAX_BLOCK_RANGE: z.coerce.number().int().min(1).max(1_000_000).default(2_000),
    /** How far back to start when a chain has no checkpoint yet. */
    RECONCILER_INITIAL_LOOKBACK_BLOCKS: z.coerce.number().int().min(0).max(10_000_000).default(5_000),

    /**
     * Dashboard sign-in through Privy.
     *
     * When PRIVY_APP_ID is set (and ADMIN_JWT_SECRET, which signs the resulting session), a person
     * can exchange a Privy token for a tenant-scoped session at /auth/session. Unset, the endpoints
     * report 503 and the deployment is the single-tenant operator setup it has always been.
     *
     * The app id is not a secret — it identifies the application a token was minted for, and the
     * audience check is what stops a token from another Privy app authenticating here.
     */
    PRIVY_APP_ID: z.string().min(1).optional(),
    /** JWKS endpoint. Defaults to Privy's for the app id; overridable for testing or a proxy. */
    PRIVY_JWKS_URL: z.string().url().optional(),
    PRIVY_ISSUER: z.string().min(1).default("privy.io"),
    PRIVY_JWKS_CACHE_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(600_000),

    /**
     * Whether an unknown person may create their own tenant on first sign-in.
     *
     * Off by default: every visitor with a Privy account could otherwise create rows, which is a
     * product decision with an abuse dimension rather than a default to inherit.
     */
    TENANT_SELF_SIGNUP: boolFromEnv(false),

    /**
     * Seeds the bootstrap policy into an EMPTY policy table, solving the same chicken-and-egg
     * BOOTSTRAP_API_KEY solves for credentials: with a database configured, policies come from it,
     * and a fresh database has none — so every sponsorship fails naming a policy nobody was told to
     * create. Off by default, because a policy that decides what to sponsor should be the
     * operator's deliberate act in production. Only ever inserted when no policy exists.
     */
    BOOTSTRAP_DEFAULT_POLICY: boolFromEnv(false),

    /**
     * Policy convergence across replicas.
     *
     * `PolicySource` holds the policy set in memory; an admin write reloads only the replica that
     * served it. Every replica therefore also reloads on this interval — the timer is the
     * correctness guarantee and bounds staleness unconditionally. With Redis, a pub/sub message on
     * the channel below makes a change land in milliseconds instead; that is an optimisation on
     * top, never the mechanism itself, because pub/sub has no delivery guarantee.
     */
    POLICY_RELOAD_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
    POLICY_BROADCAST_CHANNEL: z.string().min(1).default("paymaster:policy:changed"),

    /**
     * Leader election, for work that must happen once across the fleet rather than once per replica.
     *
     * Currently that is pager delivery: three replicas seeing one drained deposit would otherwise
     * raise three alerts. Monitoring itself is never gated — a chain unreachable from one pod is a
     * real condition — and neither is the log sink. Requires Redis; without it there is one replica,
     * which always leads.
     */
    LEADER_ELECTION_ENABLED: boolFromEnv(true),
    LEADER_LOCK_KEY: z.string().min(1).default("paymaster:leader"),
    /** Lease lifetime. Renewed at a third of this, so two failed renewals still leave headroom. */
    LEADER_LOCK_TTL_MS: z.coerce.number().int().min(3_000).max(300_000).default(30_000),

    /** Expose Prometheus metrics at /metrics. On by default; the endpoint carries no secrets. */
    METRICS_ENABLED: boolFromEnv(true),

    /**
     * Alert delivery.
     *
     * Without a URL the only sink is the application log, which is a safe default but does not wake
     * anyone. Set the URL to add a pager: `pagerduty` uses the Events API v2 (resolutions close the
     * incident the alert opened), `slack` posts to an incoming webhook, `generic` posts our own JSON
     * to an endpoint you write. The log sink always stays composed alongside it.
     */
    ALERT_WEBHOOK_URL: z.string().url().optional(),
    ALERT_WEBHOOK_FORMAT: z.enum(["generic", "pagerduty", "slack"]).default("generic"),
    /** PagerDuty integration (routing) key. Required when the format is `pagerduty`. Never logged. */
    ALERT_WEBHOOK_ROUTING_KEY: z.string().min(1).optional(),
    /** Optional HMAC secret for the `generic` format, signed exactly as inbound requests are. */
    ALERT_WEBHOOK_SIGNING_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
    /** `critical` pages only on the conditions that stop sponsorship outright. */
    ALERT_WEBHOOK_MIN_SEVERITY: z.enum(["warning", "critical"]).default("warning"),
    ALERT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
    ALERT_WEBHOOK_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

    /**
     * Distributed tracing (OTLP/HTTP JSON to any OpenTelemetry collector).
     *
     * Off by default: tracing needs somewhere to send spans, and a service that silently posts to a
     * nonexistent collector every second is worse than one that does not trace. Enabling requires an
     * endpoint — enforced below.
     */
    OTEL_TRACES_ENABLED: boolFromEnv(false),
    /** Collector base URL, e.g. http://otel-collector:4318. `/v1/traces` is appended if absent. */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    /** Extra export headers as `k=v,k=v` — the standard OTel encoding. Typically an API token. */
    OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
    OTEL_SERVICE_NAME: z.string().min(1).default("paymaster"),
    /** Head-sampling probability. 1 traces everything; lower it before the collector, not after. */
    OTEL_TRACES_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
    OTEL_BSP_SCHEDULE_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(256),
    /** Hard cap on queued spans. Past it spans are dropped, never buffered without limit. */
    OTEL_BSP_MAX_QUEUE_SIZE: z.coerce.number().int().min(1).max(100_000).default(2_048),
    OTEL_EXPORT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),

    /**
     * HMAC secret for operator session tokens (JWT admin auth). Optional: when unset, only API keys
     * authenticate and POST /admin/auth/token returns 503. At least 32 chars — a short HMAC secret
     * is a weak one. Never logged.
     */
    ADMIN_JWT_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
    /** Session token lifetime. Short by default: a session is a convenience, not a second API key. */
    ADMIN_JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    ADMIN_JWT_ISSUER: z.string().min(1).default("paymaster"),
    ADMIN_JWT_AUDIENCE: z.string().min(1).default("paymaster-admin"),

    /**
     * Pre-authentication IP throttling and abuse detection. Runs before auth, so it protects the
     * auth path the per-IP policy quota cannot. On by default; backed by the same store as quotas
     * (Redis in production), so limits hold across replicas.
     */
    IP_THROTTLE_ENABLED: boolFromEnv(true),
    IP_THROTTLE_REQUESTS_PER_WINDOW: z.coerce.number().int().min(1).max(1_000_000).default(100),
    IP_THROTTLE_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
    /** Auth failures per IP within the block window that trip a temporary block. */
    IP_ABUSE_AUTH_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100_000).default(20),
    IP_ABUSE_BLOCK_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(900),

    /**
     * HMAC request signing. When REQUEST_SIGNING_SECRET is set, mutating requests must carry a valid
     * X-Signature + X-Timestamp over the raw body. Optional; at least 32 chars. Never logged.
     */
    REQUEST_SIGNING_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
    /** Freshness window for a signed request's timestamp, bounding replay. */
    REQUEST_SIGNING_MAX_SKEW_SECONDS: z.coerce.number().int().min(5).max(3_600).default(300),
  })
  .superRefine((env, ctx) => {
    // Exactly one signer source. Zero means the service cannot sign at all; both is ambiguous — which
    // key attests? — and an ambiguous signing configuration in a component that spends money is a
    // misconfiguration to reject at startup, not resolve by precedence.
    const sources = [env.SPONSORSHIP_SIGNER_KEY, env.SPONSORSHIP_SIGNER_KMS_KEY_ID].filter((v) => v !== undefined);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "set exactly one of SPONSORSHIP_SIGNER_KEY (local) or SPONSORSHIP_SIGNER_KMS_KEY_ID (KMS); " +
          `found ${sources.length}`,
        path: ["SPONSORSHIP_SIGNER_KEY"],
      });
    }

    // A pager configured with no way to route the page is a pager that will not page. Caught at
    // startup, because the alternative is discovering it during the incident it was meant to catch.
    if (
      env.ALERT_WEBHOOK_URL !== undefined &&
      env.ALERT_WEBHOOK_FORMAT === "pagerduty" &&
      env.ALERT_WEBHOOK_ROUTING_KEY === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "ALERT_WEBHOOK_FORMAT=pagerduty requires ALERT_WEBHOOK_ROUTING_KEY",
        path: ["ALERT_WEBHOOK_ROUTING_KEY"],
      });
    }

    if (env.OTEL_TRACES_ENABLED && env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "OTEL_TRACES_ENABLED requires OTEL_EXPORTER_OTLP_ENDPOINT",
        path: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
      });
    }
  });

/** Parses an env flag: unset falls back to `defaultValue`; "false"/"0"/"no" are false, else true. */
function boolFromEnv(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : !["false", "0", "no", "off"].includes(v.toLowerCase())));
}

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

/**
 * Parses `OTEL_EXPORTER_OTLP_HEADERS` — `k=v,k=v`, the encoding the OTel specification defines.
 *
 * Lenient by design: a malformed pair is skipped rather than fatal. These headers usually carry a
 * telemetry token, and refusing to start a paymaster because an observability credential was pasted
 * with a stray comma is the wrong trade — the export failure is visible in the log either way.
 */
export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === "") return {};
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const headerValue = pair.slice(index + 1).trim();
    if (key !== "" && headerValue !== "") headers[key] = headerValue;
  }
  return headers;
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
