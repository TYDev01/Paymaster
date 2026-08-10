import "reflect-metadata";

import {Logger} from "@nestjs/common";
import {NestFactory} from "@nestjs/core";
import {FastifyAdapter, type NestFastifyApplication} from "@nestjs/platform-fastify";

import {AppModule, buildDependencies} from "./api/app.module.js";
import {DomainErrorFilter} from "./api/filters/domainError.filter.js";
import {parseEnv} from "./config/env.js";
import {defaultPolicies} from "./config/defaultPolicies.js";
import {registerTracing} from "./monitoring/tracingPlugin.js";
import {registerSecurity} from "./security/securityPlugin.js";

/**
 * Fastify rather than Express: td.md targets thousands of operations per minute, and this service
 * is a thin, high-volume JSON path where the adapter's overhead is a visible share of latency.
 */
export async function bootstrap(): Promise<NestFastifyApplication> {
  const logger = new Logger("bootstrap");
  const env = parseEnv();

  const deps = await buildDependencies(env, (quotas) => defaultPolicies(env, quotas));

  for (const warning of deps.chains.warnings) {
    logger.warn(`chain ${warning.chainId}: ${warning.message}`);
  }

  // These are not nits: each one silently breaks an assumption an operator is likely to be making.
  if (deps.quotasAreLocal) {
    logger.warn(
      "REDIS_URL is not set: quota counters are process-local, so every replica grants a full " +
        "quota independently. Do not run more than one instance without Redis.",
    );
  }
  if (deps.pool === undefined) {
    logger.warn(
      "DATABASE_URL is not set: API keys will not survive a restart and no sponsorship records " +
        "are kept, so issued attestations cannot be audited.",
    );
  }

  // Assert every RPC serves the chain its config claims, before accepting traffic. A mismatch
  // here would make every sponsorship on that chain fail with an opaque AA34.
  await deps.chains.verifyAll();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(deps), new FastifyAdapter(), {
    // JSON only; nothing here serves a browser directly.
    cors: false,
    // Capture the raw request body so HMAC request signing can verify the exact bytes received,
    // not a re-serialisation that might differ from what the client signed.
    rawBody: true,
  });

  const fastify = app.getHttpAdapter().getInstance();

  // Tracing first, so the server span brackets the edge security below it: a request rejected by
  // the throttle is exactly the kind you want a span for.
  if (deps.tracer !== undefined) registerTracing(fastify, deps.tracer);

  // Edge security BEFORE authentication: pre-auth IP throttle/abuse block, and HMAC signature
  // verification. Registered on the underlying Fastify instance so it runs ahead of Nest guards.
  registerSecurity(fastify, {
    ipThrottle: deps.ipThrottle,
    signatureVerifier: deps.signatureVerifier,
  });

  app.useGlobalFilters(new DomainErrorFilter());
  app.enableShutdownHooks();

  await app.listen({port: env.PORT, host: env.HOST});

  logger.log(`sponsorship API listening on ${env.HOST}:${env.PORT}`);
  logger.log(`serving chains: ${deps.chains.enabledChainIds.join(", ") || "<none enabled>"}`);
  logger.log(`signer: ${deps.signer.address}`);
  if (env.OTEL_TRACES_ENABLED) {
    logger.log(`tracing: OTLP to ${env.OTEL_EXPORTER_OTLP_ENDPOINT} at ${env.OTEL_TRACES_SAMPLE_RATIO} sampling`);
  }
  // The format, never the URL: a Slack incoming-webhook URL is itself the credential.
  if (env.ALERT_WEBHOOK_URL !== undefined) logger.log(`alerting: ${env.ALERT_WEBHOOK_FORMAT} webhook + log`);

  return app;
}

// Only run when executed directly, so tests can import bootstrap without starting a server.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
