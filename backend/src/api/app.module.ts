import {Module, type DynamicModule} from "@nestjs/common";

import {ChainRegistry} from "../chain/chainRegistry.js";
import {PolicyEngine, type Policy} from "../policy/engine.js";
import {PolicySource, type PolicyRepository} from "../policy/policySource.js";
import {SignatureEngine} from "../signature/signatureEngine.js";
import {LocalSponsorshipSigner, type SponsorshipSigner} from "../signature/signer.js";
import {parseChainsJson, type Env} from "../config/env.js";
import {HealthController, HEALTH_DEPS, type HealthDeps} from "./health/health.controller.js";
import {SponsorController, SPONSOR_SERVICE} from "./sponsor/sponsor.controller.js";
import {SponsorService} from "./sponsor/sponsor.service.js";

export interface AppDependencies {
  readonly chains: ChainRegistry;
  readonly policies: PolicySource;
  readonly signer: SponsorshipSigner;
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
    const sponsorService = new SponsorService({
      chains: deps.chains,
      policies: deps.policies,
      policyEngine: new PolicyEngine(),
      signatureEngine: new SignatureEngine(deps.signer),
      options: {
        validitySeconds: deps.env.SPONSORSHIP_VALIDITY_SECONDS,
        paymasterVerificationGasLimit: deps.env.PAYMASTER_VERIFICATION_GAS_LIMIT,
        postOpGasLimit: deps.env.POSTOP_GAS_LIMIT,
        defaultPolicyId: deps.env.DEFAULT_POLICY_ID,
      },
    });

    const healthDeps: HealthDeps = {chains: deps.chains, policies: deps.policies};

    return {
      module: AppModule,
      controllers: [SponsorController, HealthController],
      providers: [
        {provide: SPONSOR_SERVICE, useValue: sponsorService},
        {provide: HEALTH_DEPS, useValue: healthDeps},
      ],
    };
  }
}

/**
 * Builds the dependency graph from validated environment.
 *
 * Deliberately not inside AppModule: constructing the graph is separable from serving HTTP, and
 * this is the seam where a KMS signer replaces the local one in production.
 */
export async function buildDependencies(env: Env, policies: readonly Policy[]): Promise<AppDependencies> {
  const chains = ChainRegistry.fromConfigs(parseChainsJson(env.CHAINS));

  const repository: PolicyRepository = {load: async () => policies};
  const policySource = new PolicySource(repository);
  await policySource.reload();

  return {
    chains,
    policies: policySource,
    signer: new LocalSponsorshipSigner(env.SPONSORSHIP_SIGNER_KEY),
    env,
  };
}
