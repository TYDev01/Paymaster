import {Module, type DynamicModule, type Provider} from "@nestjs/common";
import IORedis, {type Redis} from "ioredis";

import {hashApiKey} from "../auth/apiKey.js";
import {createPool, type DatabasePool} from "../db/pool.js";
import {migrate} from "../db/migrate.js";
import {PostgresApiKeyStore} from "../db/postgresApiKeyStore.js";
import {PostgresPolicyRepository} from "../db/postgresPolicyRepository.js";
import {SponsorshipRepository} from "../db/sponsorshipRepository.js";
import {AuditLogRepository} from "../db/auditLogRepository.js";
import {PolicyFactory} from "../policy/policyFactory.js";
import {AdminController, ADMIN_SERVICE} from "./admin/admin.controller.js";
import {AdminService} from "./admin/admin.service.js";
import {ApiKeyAuthenticator} from "../auth/authenticator.js";
import type {ApiKeyStore} from "../auth/apiKeyStore.js";
import {InMemoryApiKeyStore} from "../auth/inMemoryApiKeyStore.js";
import {JwtService} from "../auth/jwt.js";
import {ChainRegistry} from "../chain/chainRegistry.js";
import {ChainRegistryTokenBalanceReader} from "../chain/tokenBalanceReader.js";
import {LoggingAlerter, type Alerter} from "../monitoring/alerting.js";
import {BackgroundServiceHost, type BackgroundService} from "../monitoring/backgroundService.js";
import {FundingMonitor} from "../monitoring/fundingMonitor.js";
import {SpendReconciler} from "../reconciliation/spendReconciler.js";
import {ChainRegistryEventSource} from "../reconciliation/chainEventSource.js";
import {PostgresSpendReconciliationStore} from "../db/postgresSpendReconciliationStore.js";
import {PolicyEngine, type Policy} from "../policy/engine.js";
import {InMemoryQuotaStore} from "../policy/quota/inMemoryQuotaStore.js";
import {RedisQuotaStore} from "../policy/quota/redisQuotaStore.js";
import type {QuotaStore} from "../policy/quota/quotaStore.js";
import {PolicySource, type PolicyRepository} from "../policy/policySource.js";
import {SignatureEngine} from "../signature/signatureEngine.js";
import {LocalSponsorshipSigner, type SponsorshipSigner} from "../signature/signer.js";
import {KmsSponsorshipSigner} from "../signature/kmsSigner.js";
import {AwsKmsClient} from "../signature/awsKmsClient.js";
import {parseChainsJson, type Env} from "../config/env.js";
import {API_KEY_AUTHENTICATOR, JWT_VERIFIER, SECURITY_IP_THROTTLE} from "./guards/apiKey.guard.js";
import {AuthController} from "./admin/auth.controller.js";
import {HealthController, HEALTH_DEPS, type HealthDeps} from "./health/health.controller.js";
import {MetricsController, PAYMASTER_METRICS} from "./health/metrics.controller.js";
import {PaymasterMetrics} from "../monitoring/paymasterMetrics.js";
import {IpThrottle} from "../security/ipThrottle.js";
import {RequestSignatureVerifier} from "../security/requestSignature.js";
import {SponsorController, SPONSOR_SERVICE} from "./sponsor/sponsor.controller.js";
import {SponsorService} from "./sponsor/sponsor.service.js";

export interface AppDependencies {
  readonly chains: ChainRegistry;
  readonly policies: PolicySource;
  readonly signer: SponsorshipSigner;
  readonly apiKeys: ApiKeyStore;
  /** Records what we committed to pay. Absent when running without a database. */
  readonly sponsorships?: SponsorshipRepository | undefined;
  /** Policy definitions. Absent when running without a database, which disables admin writes. */
  readonly policyRepository?: PostgresPolicyRepository | undefined;
  readonly audit?: AuditLogRepository | undefined;
  /** Held so bootstrap can close it on shutdown. */
  readonly pool?: DatabasePool | undefined;
  /** Held so bootstrap can close it on shutdown. Undefined when running without Redis. */
  readonly redis?: Redis | undefined;
  /** True when quota counters are process-local, so quotas do not hold across replicas. */
  readonly quotasAreLocal: boolean;
  /**
   * Long-running loops (funding monitor, spend reconciler) to run alongside the HTTP app. Empty in
   * tests, which build the graph directly and do not want timers; populated by `buildDependencies`.
   */
  readonly backgroundServices?: readonly BackgroundService[] | undefined;
  /** Signs operator session tokens. Absent when ADMIN_JWT_SECRET is not set (JWT auth disabled). */
  readonly jwt?: JwtService | undefined;
  /** Metrics facade. Absent in tests and when METRICS_ENABLED is false. */
  readonly metrics?: PaymasterMetrics | undefined;
  /** Pre-auth IP throttle / abuse detector. Absent when IP_THROTTLE_ENABLED is false. */
  readonly ipThrottle?: IpThrottle | undefined;
  /** HMAC request-signature verifier. Absent when REQUEST_SIGNING_SECRET is not set. */
  readonly signatureVerifier?: RequestSignatureVerifier | undefined;
  readonly env: Env;
}

/**
 * Composition root.
 *
 * Every provider is registered with an explicit token and a factory. Nothing is constructed by
 * NestJS reflecting on constructor types — which is what lets the whole domain stay free of
 * framework decorators, and what lets tests build the same graph without a container.
 */
@Module({})
export class AppModule {
  static forRoot(deps: AppDependencies): DynamicModule {
    const metrics = deps.metrics;

    const sponsorService = new SponsorService({
      chains: deps.chains,
      policies: deps.policies,
      // The metrics facade doubles as the policy observer, so denials and latency are captured here.
      policyEngine: new PolicyEngine(metrics === undefined ? {} : {observer: metrics}),
      signatureEngine: new SignatureEngine(deps.signer),
      sponsorships: deps.sponsorships,
      metrics,
      options: {
        validitySeconds: deps.env.SPONSORSHIP_VALIDITY_SECONDS,
        paymasterVerificationGasLimit: deps.env.PAYMASTER_VERIFICATION_GAS_LIMIT,
        postOpGasLimit: deps.env.POSTOP_GAS_LIMIT,
        defaultPolicyId: deps.env.DEFAULT_POLICY_ID,
      },
    });

    const healthDeps: HealthDeps = {chains: deps.chains, policies: deps.policies, metrics};

    const adminService = new AdminService({
      policies: deps.policyRepository,
      policySource: deps.policies,
      apiKeys: deps.apiKeys,
      sponsorships: deps.sponsorships,
      audit: deps.audit,
    });

    const providers: Provider[] = [
      {provide: SPONSOR_SERVICE, useValue: sponsorService},
      {provide: HEALTH_DEPS, useValue: healthDeps},
      {provide: ADMIN_SERVICE, useValue: adminService},
      {provide: API_KEY_AUTHENTICATOR, useValue: new ApiKeyAuthenticator(deps.apiKeys)},
      {provide: JWT_VERIFIER, useValue: deps.jwt ?? null},
      {provide: SECURITY_IP_THROTTLE, useValue: deps.ipThrottle ?? null},
      {provide: PAYMASTER_METRICS, useValue: metrics ?? null},
    ];

    // Registered as a value provider so Nest drives its start/stop from the app lifecycle. Only
    // present when there are services to run, which keeps tests (that pass none) free of timers.
    if (deps.backgroundServices !== undefined && deps.backgroundServices.length > 0) {
      providers.push({
        provide: BACKGROUND_SERVICE_HOST,
        useValue: new BackgroundServiceHost(deps.backgroundServices),
      });
    }

    return {
      module: AppModule,
      controllers: [SponsorController, HealthController, MetricsController, AdminController, AuthController],
      providers,
    };
  }
}

export const BACKGROUND_SERVICE_HOST = Symbol("BACKGROUND_SERVICE_HOST");

/**
 * Builds the dependency graph from validated environment.
 *
 * Deliberately not inside AppModule: constructing the graph is separable from serving HTTP, and
 * this is the seam where a KMS signer replaces the local one in production.
 */
export async function buildDependencies(
  env: Env,
  makePolicies: (quotas: QuotaStore) => readonly Policy[],
): Promise<AppDependencies> {
  // Shared across the circuit breakers, funding monitor, reconciler, and IP throttle so every
  // subsystem alerts through one sink. LoggingAlerter is the safe default; compose a pager in here.
  const alerter = new LoggingAlerter();
  const metrics = env.METRICS_ENABLED ? new PaymasterMetrics() : undefined;

  // Each chain's RPC breaker reports open/closed through here: a critical alert when a chain trips,
  // resolved when it recovers, plus a gauge. The circuit name is `rpc:<chainId>`.
  const chains = ChainRegistry.fromConfigs(parseChainsJson(env.CHAINS), {
    onCircuitChange: (change) => {
      const chainId = change.circuit.replace(/^rpc:/, "");
      if (change.to === "open") {
        void alerter.fire({
          key: `circuit-open:${chainId}`,
          severity: "critical",
          title: "chain RPC circuit opened",
          detail: `chain ${chainId} RPC circuit opened after repeated failures; reads fail fast until it recovers`,
          labels: {chainId},
        });
      } else if (change.to === "closed") {
        void alerter.resolve(`circuit-open:${chainId}`);
      }
      metrics?.recordCircuitState(Number(chainId), change.to);
    },
  });

  const redis = env.REDIS_URL === undefined ? undefined : new IORedis(env.REDIS_URL, {maxRetriesPerRequest: 3});
  const quotas: QuotaStore = redis === undefined ? new InMemoryQuotaStore() : new RedisQuotaStore(redis);

  const pool =
    env.DATABASE_URL === undefined
      ? undefined
      : createPool({connectionString: env.DATABASE_URL, maxConnections: env.DATABASE_MAX_CONNECTIONS});

  if (pool !== undefined && env.DATABASE_MIGRATE_ON_BOOT) {
    await migrate(pool);
  }

  if (pool !== undefined && env.BOOTSTRAP_API_KEY !== undefined) {
    await ensureBootstrapKey(pool, env.BOOTSTRAP_API_KEY);
  }

  /**
   * With a database, policies come from it and hot reload means something. Without one, the
   * in-code bootstrap set is served and `reload()` re-reads the same array — structurally present,
   * functionally a no-op. That is a real limitation, and `bootstrap` says so.
   */
  const tokenReader = new ChainRegistryTokenBalanceReader(chains);
  const policyRepository =
    pool === undefined ? undefined : new PostgresPolicyRepository(pool, new PolicyFactory(quotas, tokenReader));

  const repository: PolicyRepository = policyRepository ?? {load: async () => makePolicies(quotas)};
  const policySource = new PolicySource(repository);
  await policySource.reload();

  const backgroundServices = buildBackgroundServices(env, {chains, policies: policySource, pool, metrics}, alerter);

  const jwt =
    env.ADMIN_JWT_SECRET === undefined
      ? undefined
      : new JwtService(env.ADMIN_JWT_SECRET, {
          issuer: env.ADMIN_JWT_ISSUER,
          audience: env.ADMIN_JWT_AUDIENCE,
          ttlSeconds: env.ADMIN_JWT_TTL_SECONDS,
        });

  // Pre-auth throttle shares the quota store (Redis in prod), so limits and blocks hold across
  // replicas. The HMAC verifier is present only when a signing secret is configured.
  const ipThrottle = env.IP_THROTTLE_ENABLED
    ? new IpThrottle(
        quotas,
        {
          requestsPerWindow: env.IP_THROTTLE_REQUESTS_PER_WINDOW,
          windowSeconds: env.IP_THROTTLE_WINDOW_SECONDS,
          authFailureThreshold: env.IP_ABUSE_AUTH_FAILURE_THRESHOLD,
          blockWindowSeconds: env.IP_ABUSE_BLOCK_WINDOW_SECONDS,
        },
        alerter,
      )
    : undefined;
  const signatureVerifier =
    env.REQUEST_SIGNING_SECRET === undefined
      ? undefined
      : new RequestSignatureVerifier(env.REQUEST_SIGNING_SECRET, {
          maxSkewSeconds: env.REQUEST_SIGNING_MAX_SKEW_SECONDS,
        });

  return {
    chains,
    policies: policySource,
    backgroundServices,
    metrics,
    jwt,
    ipThrottle,
    signatureVerifier,
    signer: await buildSigner(env),
    apiKeys: pool === undefined ? buildApiKeyStore(env) : new PostgresApiKeyStore(pool),
    sponsorships: pool === undefined ? undefined : new SponsorshipRepository(pool),
    policyRepository,
    audit: pool === undefined ? undefined : new AuditLogRepository(pool),
    pool,
    redis,
    quotasAreLocal: redis === undefined,
    env,
  };
}

/**
 * Selects the sponsorship signer from config.
 *
 * This is the seam td.md's production posture turns on: with SPONSORSHIP_SIGNER_KMS_KEY_ID set the
 * signing key never enters this process, and `LocalSponsorshipSigner`'s heap-exposure caveat no
 * longer applies. `parseEnv` has already guaranteed exactly one source is configured, so the
 * fallback here is total, not a silent default.
 */
async function buildSigner(env: Env): Promise<SponsorshipSigner> {
  if (env.SPONSORSHIP_SIGNER_KMS_KEY_ID !== undefined) {
    return KmsSponsorshipSigner.create(
      new AwsKmsClient({keyId: env.SPONSORSHIP_SIGNER_KMS_KEY_ID, region: env.AWS_REGION}),
    );
  }
  // parseEnv guarantees the key is present when no KMS key is; the assertion documents that invariant.
  if (env.SPONSORSHIP_SIGNER_KEY === undefined) {
    throw new Error("no signer configured: set SPONSORSHIP_SIGNER_KEY or SPONSORSHIP_SIGNER_KMS_KEY_ID");
  }
  return new LocalSponsorshipSigner(env.SPONSORSHIP_SIGNER_KEY);
}

/**
 * Constructs the background loops from validated config.
 *
 * Separated from the graph build so the enable/disable and dependency-presence logic lives in one
 * place: the funding monitor needs only chains and an alerter; the reconciler additionally needs a
 * database (it correlates on-chain events to the sponsorships table) and so is silently omitted when
 * there is no pool, exactly as sponsorship recording is.
 */
function buildBackgroundServices(
  env: Env,
  deps: {
    chains: ChainRegistry;
    policies: PolicySource;
    pool: DatabasePool | undefined;
    metrics: PaymasterMetrics | undefined;
  },
  alerter: Alerter = new LoggingAlerter(),
): readonly BackgroundService[] {
  const services: BackgroundService[] = [];

  if (env.FUNDING_MONITOR_ENABLED && deps.chains.allChainIds.length > 0) {
    const metrics = deps.metrics;
    services.push(
      new FundingMonitor(
        deps.chains,
        alerter,
        {intervalMs: env.FUNDING_MONITOR_INTERVAL_MS, reAlertMs: env.FUNDING_MONITOR_REALERT_MS},
        () => Date.now(),
        metrics === undefined ? undefined : (results) => metrics.recordFunding(results),
      ),
    );
  }

  if (env.RECONCILER_ENABLED && deps.pool !== undefined && deps.chains.allChainIds.length > 0) {
    services.push(
      new SpendReconciler(
        new ChainRegistryEventSource(deps.chains),
        new PostgresSpendReconciliationStore(deps.pool),
        deps.policies,
        {
          intervalMs: env.RECONCILER_INTERVAL_MS,
          confirmations: env.RECONCILER_CONFIRMATIONS,
          maxBlockRange: env.RECONCILER_MAX_BLOCK_RANGE,
          initialLookbackBlocks: env.RECONCILER_INITIAL_LOOKBACK_BLOCKS,
          chainIds: deps.chains.allChainIds,
        },
      ),
    );
  }

  return services;
}

/**
 * Seeds the bootstrap admin key into the database if it is not already there.
 *
 * The row id is derived from the key's hash, so a given key always maps to the same row. Two
 * consequences, both deliberate:
 *
 *   * It is idempotent and safe under a rolling deploy — every replica computes the same id and
 *     ON CONFLICT makes the losers no-ops.
 *
 *   * A REVOKED bootstrap key stays revoked across restarts. Keying the row on a fixed id and
 *     upserting would resurrect a key an operator had deliberately killed, every time a pod
 *     restarted. Rotating means setting a new BOOTSTRAP_API_KEY, which lands as a new row and
 *     leaves the revoked one auditable.
 */
async function ensureBootstrapKey(pool: DatabasePool, secret: string): Promise<void> {
  const hash = hashApiKey(secret);
  await pool.query(
    `INSERT INTO api_keys (id, name, key_hash, display_prefix, roles, enabled)
     VALUES ($1, $2, $3, $4, ARRAY['admin'], true)
     ON CONFLICT (key_hash) DO NOTHING`,
    [`bootstrap-${hash.slice(0, 12)}`, "bootstrap admin key", hash, secret.slice(0, 16)],
  );
}

/**
 * Seeds the key store from `BOOTSTRAP_API_KEY`, if set.
 *
 * Solves the chicken-and-egg of a key-authenticated service with no keys. Only the HASH is kept,
 * exactly as for any other key — the raw value lives in the environment, where the signer key
 * already lives, and never reaches storage.
 *
 * With no bootstrap key the store is empty and every request 401s. That is the correct failure:
 * a paymaster that spends money should be unreachable when misconfigured, not open.
 */
function buildApiKeyStore(env: Env): ApiKeyStore {
  if (env.BOOTSTRAP_API_KEY === undefined) return new InMemoryApiKeyStore();

  return new InMemoryApiKeyStore([
    {
      id: "bootstrap",
      name: "bootstrap admin key",
      hash: hashApiKey(env.BOOTSTRAP_API_KEY),
      displayPrefix: env.BOOTSTRAP_API_KEY.slice(0, 16),
      roles: ["admin"],
      policyId: undefined,
      enabled: true,
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: undefined,
      lastUsedAt: undefined,
    },
  ]);
}
