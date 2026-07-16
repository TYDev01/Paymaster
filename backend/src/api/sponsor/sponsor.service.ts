import {slice, toHex, type Hex} from "viem";

import {calculateMaxCost} from "../../chain/gas.js";
import type {ChainRegistry} from "../../chain/chainRegistry.js";
import {decodeCallTargets} from "../../policy/callData.js";
import type {PolicyContext, PolicyDenial} from "../../policy/context.js";
import type {PolicyEngine} from "../../policy/engine.js";
import type {PolicySource} from "../../policy/policySource.js";
import type {SignatureEngine} from "../../signature/signatureEngine.js";
import {
  PAYMASTER_DATA_OFFSET,
  PAYMASTER_POSTOP_GAS_OFFSET,
  PAYMASTER_VALIDATION_GAS_OFFSET,
} from "../../signature/paymasterAndData.js";
import {toPackedUserOperation, type SponsorRequest} from "../dto/sponsorRequest.js";
import type {SponsorResponse} from "../dto/sponsorResponse.js";

/** Raised when policy refuses. Carries the denial so the HTTP layer can decide what to reveal. */
export class SponsorshipDeniedError extends Error {
  constructor(readonly denial: PolicyDenial, readonly policyId: string) {
    super(`sponsorship denied by ${denial.rule}: ${denial.reason}`);
    this.name = "SponsorshipDeniedError";
  }
}

export interface SponsorServiceOptions {
  /** How long an attestation stays valid. Short by default — see `validUntil` below. */
  readonly validitySeconds: number;
  readonly paymasterVerificationGasLimit: bigint;
  readonly postOpGasLimit: bigint;
  readonly defaultPolicyId: string;
}

export interface SponsorServiceDeps {
  readonly chains: ChainRegistry;
  readonly policies: PolicySource;
  readonly policyEngine: PolicyEngine;
  readonly signatureEngine: SignatureEngine;
  readonly options: SponsorServiceOptions;
  /** Injected so evaluation is deterministic and testable. Unix seconds. */
  readonly now?: () => number;
}

/**
 * Orchestrates one sponsorship: pack, price, authorise, attest.
 *
 * Framework-free on purpose. The NestJS controller is a thin adapter over this, so the decision
 * path can be tested without an HTTP server and could be driven from a queue consumer or a
 * gRPC handler without change.
 */
export class SponsorService {
  readonly #deps: SponsorServiceDeps;
  readonly #now: () => number;

  constructor(deps: SponsorServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async sponsor(request: SponsorRequest, caller: CallerIdentity = {}): Promise<SponsorResponse> {
    const {chains, policies, policyEngine, signatureEngine, options} = this.#deps;

    // Throws UnknownChainError / ChainDisabledError, which the filter maps to 4xx.
    const chain = chains.get(request.chainId);
    const policyId = request.policyId ?? options.defaultPolicyId;
    const policy = policies.get(policyId);

    const userOp = toPackedUserOperation(request.userOperation);

    // Priced against the limits WE will commit to, not anything the caller supplied.
    const maxCost = calculateMaxCost({
      userOp,
      paymasterVerificationGasLimit: options.paymasterVerificationGasLimit,
      postOpGasLimit: options.postOpGasLimit,
    });

    const now = this.#now();
    const context: PolicyContext = {
      chainId: request.chainId,
      sender: request.userOperation.sender,
      userOp,
      calls: decodeCallTargets(request.userOperation.callData),
      clientIp: caller.clientIp,
      apiKeyId: caller.apiKeyId,
      maxCost,
      now,
    };

    const evaluation = await policyEngine.evaluate(policy, context);
    if (!evaluation.decision.allowed) {
      throw new SponsorshipDeniedError(evaluation.decision, policyId);
    }

    /**
     * From here the policy has already RESERVED budget. Anything that fails before we return a
     * usable attestation must give it back, or a caller is charged for a sponsorship they never
     * received. This is the compensation the engine cannot perform itself: only we know whether
     * the attestation actually made it out.
     */
    try {
      const validUntil = now + options.validitySeconds;
      const attestation = await signatureEngine.attest({
        userOp,
        chainId: request.chainId,
        paymaster: chain.config.paymaster,
        paymasterVerificationGasLimit: options.paymasterVerificationGasLimit,
        postOpGasLimit: options.postOpGasLimit,
        validUntil,
        validAfter: 0,
      });

      return {
        paymaster: chain.config.paymaster,
        paymasterVerificationGasLimit: toHex(options.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: toHex(options.postOpGasLimit),
        paymasterData: paymasterDataOf(attestation.paymasterAndData),
        paymasterAndData: attestation.paymasterAndData,
        validUntil: attestation.validUntil,
        validAfter: attestation.validAfter,
        expiresAt: new Date(attestation.validUntil * 1000).toISOString(),
        metadata: {
          chainId: request.chainId,
          policyId,
          signer: attestation.signer,
          maxCost: maxCost.toString(),
          entryPoint: chain.config.entryPoint,
        },
      };
    } catch (error) {
      // Best-effort refund. A failed release leaks the caller's budget until the window rolls,
      // which is bad; masking the original error with a release failure would be worse.
      await policyEngine.releaseReservations(policy, context).catch(() => undefined);
      throw error;
    }
  }
}

export interface CallerIdentity {
  readonly clientIp?: string | undefined;
  readonly apiKeyId?: string | undefined;
}

/**
 * The paymaster-specific tail: everything after the address and the two gas limits.
 *
 * Sliced from the bytes the engine produced rather than rebuilt from the same inputs. Rebuilding
 * would be a second implementation of the layout that could drift from the first.
 */
function paymasterDataOf(paymasterAndData: Hex): Hex {
  return slice(paymasterAndData, PAYMASTER_DATA_OFFSET);
}

/** Re-exported so the offsets above are visibly the same constants the codec uses. */
export const PAYMASTER_FIELD_OFFSETS = {
  PAYMASTER_VALIDATION_GAS_OFFSET,
  PAYMASTER_POSTOP_GAS_OFFSET,
  PAYMASTER_DATA_OFFSET,
} as const;
