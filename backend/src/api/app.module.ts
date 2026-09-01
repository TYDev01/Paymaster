import {randomUUID} from "node:crypto";
import {hostname} from "node:os";

import {Logger, Module, type DynamicModule, type Provider} from "@nestjs/common";
import IORedis, {type Redis} from "ioredis";

import {hashApiKey} from "../auth/apiKey.js";
import {createPool, type DatabasePool} from "../db/pool.js";
import {migrate} from "../db/migrate.js";
import {PostgresApiKeyStore} from "../db/postgresApiKeyStore.js";
import {PostgresPolicyRepository} from "../db/postgresPolicyRepository.js";
import {SponsorshipRepository} from "../db/sponsorshipRepository.js";
import {AuditLogRepository} from "../db/auditLogRepository.js";
import {SubscriptionRepository} from "../db/subscriptionRepository.js";
import {PolicyFactory} from "../policy/policyFactory.js";
import {AdminController, ADMIN_SERVICE} from "./admin/admin.controller.js";
import {AdminService} from "./admin/admin.service.js";
import {ApiKeyAuthenticator} from "../auth/authenticator.js";
import type {ApiKeyStore} from "../auth/apiKeyStore.js";
import {InMemoryApiKeyStore} from "../auth/inMemoryApiKeyStore.js";
import {JwtService} from "../auth/jwt.js";
import {ChainRegistry} from "../chain/chainRegistry.js";
import {SubscriptionService} from "../billing/subscription.js";
import {TenantBalanceReader} from "../chain/tenantBalance.js";
import {ChainRegistryTokenBalanceReader} from "../chain/tokenBalanceReader.js";
import {CompositeAlerter, LoggingAlerter, type Alerter} from "../monitoring/alerting.js";
import {WebhookAlerter} from "../monitoring/webhookAlerter.js";
import {BackgroundServiceHost, type BackgroundService} from "../monitoring/backgroundService.js";
import {FundingMonitor} from "../monitoring/fundingMonitor.js";
import {OtlpTracer} from "../monitoring/otlpTracer.js";
import {noopTracer, type Tracer} from "../monitoring/tracing.js";
import {SpendReconciler} from "../reconciliation/spendReconciler.js";
import {ChainRegistryEventSource} from "../reconciliation/chainEventSource.js";
import {PostgresSpendReconciliationStore} from "../db/postgresSpendReconciliationStore.js";
import {AlwaysLeader, RedisLeaderLock, type LeaderLock} from "../monitoring/leaderLock.js";
import {LeaderOnlyAlerter, LeadershipService} from "../monitoring/leaderAlerter.js";
import {NoopPolicyBroadcast, RedisPolicyBroadcast, type PolicyBroadcast} from "../policy/policyBroadcast.js";
import {PolicyReloader} from "../policy/policyReloader.js";
import {PolicyEngine, type Policy} from "../policy/engine.js";
import {InMemoryQuotaStore} from "../policy/quota/inMemoryQuotaStore.js";
import {RedisQuotaStore} from "../policy/quota/redisQuotaStore.js";
import type {QuotaStore} from "../policy/quota/quotaStore.js";
import {PolicySource, type PolicyRepository} from "../policy/policySource.js";
import {SignatureEngine} from "../signature/signatureEngine.js";
import {LocalSponsorshipSigner, type SponsorshipSigner} from "../signature/signer.js";
import {KmsSponsorshipSigner} from "../signature/kmsSigner.js";
import {AwsKmsClient} from "../signature/awsKmsClient.js";
import {defaultPolicyDefinition} from "../config/defaultPolicies.js";
import {parseChainsJson, parseOtlpHeaders, type Env} from "../config/env.js";
import {DEFAULT_TENANT_ID, forTenant, PLATFORM_SCOPE} from "../db/scope.js";
import {API_KEY_AUTHENTICATOR, JWT_VERIFIER, SECURITY_IP_THROTTLE} from "./guards/apiKey.guard.js";
import {AuthController} from "./admin/auth.controller.js";
import {TenantAuthController, TENANT_SESSION_SERVICE} from "./admin/tenantAuth.controller.js";
import {TenantSessionService} from "../auth/tenantSession.js";
import {PrivyIdentityProvider} from "../auth/privyIdentityProvider.js";
import {TenantRepository} from "../db/tenantRepository.js";
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
   * Reads on-chain tenant balances. Defaults to one built over `chains`; injectable so a test can
   * drive the funding view and the pre-sign check without an RPC endpoint behind them.
   */
  readonly tenantBalances?: TenantBalanceReader | undefined;
  /** Subscriptions. Absent without a database, where every request proceeds unbilled. */
  readonly subscriptions?: SubscriptionRepository | undefined;
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
  /** Tracer. The no-op tracer when OTEL_TRACES_ENABLED is false, so callers never null-check. */
  readonly tracer?: Tracer | undefined;
  /** Announces policy changes to the other replicas. No-op without Redis (single replica). */
  readonly policyBroadcast?: PolicyBroadcast | undefined;
  /** Exchanges an identity-provider token for a tenant-scoped session. Absent without Privy. */
  readonly tenantSessions?: TenantSessionService | undefined;
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

    // Built unconditionally: it is a cache over a read, so it costs nothing until a chain that
    // actually runs a multi-tenant paymaster asks it something.
    const tenantBalances = deps.tenantBalances ?? new TenantBalanceReader(deps.chains);

    // `unsubscribedAllows` stays at its default of true: every tenant that predates the
    // subscriptions table has no row, and flipping this would take a working deployment offline on
    // upgrade. A deployment that sells subscriptions turns it off once its customers have rows.
    const subscriptionState =
      deps.subscriptions === undefined ? undefined : new SubscriptionService(deps.subscriptions);

    const sponsorService = new SponsorService({
      chains: deps.chains,
      tenantBalances,
      subscriptions: subscriptionState,
      policies: deps.policies,
      // The metrics facade doubles as the policy observer, so denials and latency are captured here.
      policyEngine: new PolicyEngine(metrics === undefined ? {} : {observer: metrics}),
      signatureEngine: new SignatureEngine(deps.signer),
      sponsorships: deps.sponsorships,
      metrics,
      tracer: deps.tracer,
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
      broadcast: deps.policyBroadcast,
      chains: deps.chains,
      tenantBalances,
      subscriptions: deps.subscriptions,
      subscriptionState,
    });

    const providers: Provider[] = [
      {provide: SPONSOR_SERVICE, useValue: sponsorService},
      {provide: HEALTH_DEPS, useValue: healthDeps},
      {provide: ADMIN_SERVICE, useValue: adminService},
      {provide: API_KEY_AUTHENTICATOR, useValue: new ApiKeyAuthenticator(deps.apiKeys)},
      {provide: JWT_VERIFIER, useValue: deps.jwt ?? null},
      {provide: SECURITY_IP_THROTTLE, useValue: deps.ipThrottle ?? null},
      {provide: PAYMASTER_METRICS, useValue: metrics ?? null},
      {provide: TENANT_SESSION_SERVICE, useValue: deps.tenantSessions ?? null},
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
      controllers: [
        SponsorController,
        HealthController,
        MetricsController,
        AdminController,
        AuthController,
        TenantAuthController,
      ],
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
  const redis = env.REDIS_URL === undefined ? undefined : new IORedis(env.REDIS_URL, {maxRetriesPerRequest: 3});

  // Leadership exists to stop N replicas paging N times for one globally-true condition. Without
  // Redis there is only one replica, so it always leads.
  const leaderLock: LeaderLock =
    redis === undefined || !env.LEADER_ELECTION_ENABLED
      ? new AlwaysLeader()
      : new RedisLeaderLock(redis, {
          key: env.LEADER_LOCK_KEY,
          // Unique per process: two replicas sharing a holder id would each mistake the other's
          // lease for their own and both act as leader.
          holder: `${hostname()}:${process.pid}:${randomUUID()}`,
          ttlMs: env.LEADER_LOCK_TTL_MS,
        });

  // Shared across the circuit breakers, funding monitor, reconciler, and IP throttle so every
  // subsystem alerts through one sink. The log sink is always present — a pager is composed in
  // ALONGSIDE it, never instead of it, so an alert whose delivery fails is still recorded.
  const alerter = buildAlerter(env, leaderLock);
  const metrics = env.METRICS_ENABLED ? new PaymasterMetrics() : undefined;
  const tracer = buildTracer(env);

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

  const quotas: QuotaStore = redis === undefined ? new InMemoryQuotaStore() : new RedisQuotaStore(redis);

  // Policy changes reach every replica, not just the one that served the admin request. Without
  // Redis this is a no-op, which is correct: there are no other replicas to tell.
  const policyBroadcast: PolicyBroadcast =
    redis === undefined
      ? new NoopPolicyBroadcast()
      : // A connection in subscriber mode accepts no other commands, so the subscriber must be its
        // own connection — reusing the shared client would break every quota operation on it.
        new RedisPolicyBroadcast(redis, () => redis.duplicate(), env.POLICY_BROADCAST_CHANNEL);

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

  if (policyRepository !== undefined && env.BOOTSTRAP_DEFAULT_POLICY) {
    await ensureBootstrapPolicy(policyRepository, env);
  }

  const repository: PolicyRepository = policyRepository ?? {load: async () => makePolicies(quotas)};
  const policySource = new PolicySource(repository);
  await policySource.reload();

  const backgroundServices = buildBackgroundServices(env, {chains, policies: policySource, pool, metrics}, alerter);
  // The tracer's flush loop is a background service like any other, so shutdown drains the last
  // spans through the same lifecycle that stops the monitors.
  if (tracer instanceof OtlpTracer) backgroundServices.push(tracer);
  // Renews the lease. Started FIRST in the list order below is not required — the alerter simply
  // suppresses until leadership is acquired, which is the safe direction.
  if (leaderLock instanceof RedisLeaderLock) {
    backgroundServices.unshift(new LeadershipService(leaderLock, {ttlMs: env.LEADER_LOCK_TTL_MS}));
  }
  // Converges this replica's policy set: timer for correctness, broadcast for latency.
  backgroundServices.push(
    new PolicyReloader(policySource, policyBroadcast, {intervalMs: env.POLICY_RELOAD_INTERVAL_MS}),
  );

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
        metrics,
      )
    : undefined;
  const signatureVerifier =
    env.REQUEST_SIGNING_SECRET === undefined
      ? undefined
      : new RequestSignatureVerifier(env.REQUEST_SIGNING_SECRET, {
          maxSkewSeconds: env.REQUEST_SIGNING_MAX_SKEW_SECONDS,
        });

  const privyLogger = new Logger("privy");

  // Dashboard sign-in needs three things: a provider to verify the person, somewhere to look up
  // what they may act within, and a signer for the session. Missing any one of them disables it,
  // and the endpoints say so rather than half-working.
  const tenantSessions =
    env.PRIVY_APP_ID === undefined || pool === undefined || jwt === undefined
      ? undefined
      : new TenantSessionService(
          new PrivyIdentityProvider(
            {
              appId: env.PRIVY_APP_ID,
              jwksUrl: env.PRIVY_JWKS_URL,
              issuer: env.PRIVY_ISSUER,
              cacheTtlMs: env.PRIVY_JWKS_CACHE_MS,
            },
            {
              // An empty cache means nobody can sign in at all, so the two cases are logged at
              // different levels: one is a degradation, the other is an outage.
              onError: (error, cachedKeys) => {
                const detail = `${error.message}${causeCode(error)}`;
                if (cachedKeys === 0) {
                  privyLogger.error(
                    `could not fetch the Privy JWKS and no keys are cached: every sign-in will be ` +
                      `refused until this succeeds (${detail})`,
                  );
                } else {
                  privyLogger.warn(
                    `could not refresh the Privy JWKS; continuing with ${cachedKeys} cached key(s) (${detail})`,
                  );
                }
              },
            },
          ),
          new TenantRepository(pool),
          jwt,
          {
            allowSelfSignup: env.TENANT_SELF_SIGNUP,
            // Every self-signed-up tenant gets its own copy of the starter policy, under the id
            // SponsorService looks for. The rules are the same ones `BOOTSTRAP_DEFAULT_POLICY`
            // seeds, but scoped to THIS tenant — policies are resolved per tenant, so a shared one
            // would be invisible to it.
            //
            // Enabling self-service signup IS the operator's decision to let strangers create
            // working accounts, so it carries the policy decision with it. The bootstrap seeder's
            // "only into an empty table" caution does not apply: this writes a policy for a tenant
            // that was created a moment ago and has none, so it can never overwrite anyone's
            // edited rules or resurrect one they deleted.
            provisionPolicy:
              policyRepository === undefined
                ? undefined
                : async (tenant) => {
                    await policyRepository.upsert(forTenant(tenant), defaultPolicyDefinition(env));
                  },
          },
        );

  return {
    chains,
    policies: policySource,
    tenantSessions,
    backgroundServices,
    metrics,
    tracer,
    jwt,
    ipThrottle,
    signatureVerifier,
    policyBroadcast,
    signer: await buildSigner(env),
    apiKeys: pool === undefined ? buildApiKeyStore(env) : new PostgresApiKeyStore(pool),
    sponsorships: pool === undefined ? undefined : new SponsorshipRepository(pool),
    policyRepository,
    audit: pool === undefined ? undefined : new AuditLogRepository(pool),
    subscriptions: pool === undefined ? undefined : new SubscriptionRepository(pool),
    pool,
    redis,
    quotasAreLocal: redis === undefined,
    env,
  };
}

/**
 * Composes the alert sinks.
 *
 * The log sink is unconditional and a webhook is added to it, never substituted for it. That
 * ordering is the point: `CompositeAlerter` isolates each sink, so a pager outage degrades to a
 * logged alert rather than to no alert — and the pager outage itself is logged by the same path.
 */
function buildAlerter(env: Env, leaderLock: LeaderLock): Alerter {
  const logging = new LoggingAlerter();
  if (env.ALERT_WEBHOOK_URL === undefined) return logging;

  const webhook = new WebhookAlerter({
    url: env.ALERT_WEBHOOK_URL,
    format: env.ALERT_WEBHOOK_FORMAT,
    timeoutMs: env.ALERT_WEBHOOK_TIMEOUT_MS,
    retries: env.ALERT_WEBHOOK_RETRIES,
    minSeverity: env.ALERT_WEBHOOK_MIN_SEVERITY,
    routingKey: env.ALERT_WEBHOOK_ROUTING_KEY,
    signingSecret: env.ALERT_WEBHOOK_SIGNING_SECRET,
    source: env.OTEL_SERVICE_NAME,
  });
  // Only the pager is leader-gated. The log sink stays ungated on every replica, so a condition
  // that is genuinely local to a follower is still recorded where it happened.
  return new CompositeAlerter([logging, new LeaderOnlyAlerter(webhook, leaderLock)]);
}

/**
 * Builds the tracer, or the no-op when tracing is off.
 *
 * Returning a working no-op rather than `undefined` is deliberate: instrumented code then has one
 * code path instead of two, and "tracing disabled" cannot become a source of null-check bugs on the
 * sponsorship path.
 */
function buildTracer(env: Env): Tracer {
  if (!env.OTEL_TRACES_ENABLED || env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) return noopTracer;
  return new OtlpTracer({
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: env.OTEL_SERVICE_NAME,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    sampleRatio: env.OTEL_TRACES_SAMPLE_RATIO,
    maxQueueSize: env.OTEL_BSP_MAX_QUEUE_SIZE,
    maxBatchSize: env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE,
    flushIntervalMs: env.OTEL_BSP_SCHEDULE_DELAY_MS,
    timeoutMs: env.OTEL_EXPORT_TIMEOUT_MS,
  });
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
): BackgroundService[] {
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
 * Seeds the bootstrap policy, but only into an EMPTY policy table.
 *
 * The emptiness check is the whole safety property. Upserting unconditionally would overwrite an
 * operator's edited default on every restart, and would resurrect a policy they had deliberately
 * deleted — both of which silently change what gets sponsored. "Only when there is nothing at all"
 * is the one condition under which seeding cannot destroy information.
 */
async function ensureBootstrapPolicy(repository: PostgresPolicyRepository, env: Env): Promise<void> {
  // Platform scope to CHECK — "is any tenant configured at all" is a platform question — and the
  // default tenant's scope to WRITE, because a policy must belong to exactly one tenant.
  const existing = await repository.list(PLATFORM_SCOPE);
  if (existing.length > 0) return;

  const logger = new Logger("bootstrap");
  await repository.upsert(forTenant(DEFAULT_TENANT_ID), defaultPolicyDefinition(env));
  logger.log(`seeded the bootstrap policy "${env.DEFAULT_POLICY_ID}" into an empty policy table`);
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
export async function ensureBootstrapKey(pool: DatabasePool, secret: string): Promise<void> {
  const hash = hashApiKey(secret);
  await pool.query(
    // `tenant_id` is NOT NULL as of migration 0004, and omitting it here meant every deployment
    // WITH a database refused to boot — the in-memory path below had been updated to carry the
    // default tenant and this one had not. Exported so a test can hold that line; nothing else
    // exercised this function, which is why a total boot failure shipped unnoticed.
    `INSERT INTO api_keys (tenant_id, id, name, key_hash, display_prefix, roles, enabled)
     VALUES ($1, $2, $3, $4, $5, ARRAY['admin'], true)
     ON CONFLICT (key_hash) DO NOTHING`,
    [DEFAULT_TENANT_ID, `bootstrap-${hash.slice(0, 12)}`, "bootstrap admin key", hash, secret.slice(0, 16)],
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
      // Without a database there is one tenant, and the bootstrap key belongs to it.
      tenantId: DEFAULT_TENANT_ID,
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

/**
 * The errno behind a failed `fetch`, when there is one.
 *
 * `fetch` reports every transport failure as the same "fetch failed", and the cause carries the
 * part that distinguishes a DNS blip (`EAI_AGAIN`) from a refused connection or a timeout. Without
 * it the log names the symptom and not the fault.
 */
function causeCode(error: Error): string {
  const code = (error as {cause?: {code?: string}}).cause?.code;
  return code === undefined ? "" : `: ${code}`;
}
