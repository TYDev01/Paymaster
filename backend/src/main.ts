import "reflect-metadata";

import {Logger} from "@nestjs/common";
import {NestFactory} from "@nestjs/core";
import {FastifyAdapter, type NestFastifyApplication} from "@nestjs/platform-fastify";

import {AppModule, buildDependencies} from "./api/app.module.js";
import {DomainErrorFilter} from "./api/filters/domainError.filter.js";
import {parseEnv} from "./config/env.js";
import {defaultPolicies} from "./config/defaultPolicies.js";

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
  });

  app.useGlobalFilters(new DomainErrorFilter());
  app.enableShutdownHooks();

  await app.listen({port: env.PORT, host: env.HOST});

  logger.log(`sponsorship API listening on ${env.HOST}:${env.PORT}`);
  logger.log(`serving chains: ${deps.chains.enabledChainIds.join(", ") || "<none enabled>"}`);
  logger.log(`signer: ${deps.signer.address}`);

  return app;
}

// Only run when executed directly, so tests can import bootstrap without starting a server.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  bootstrap().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- the logger may not exist yet if config parsing failed
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
