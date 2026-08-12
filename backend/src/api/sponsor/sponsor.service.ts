import {slice, toHex, type Address, type Hex} from "viem";

import {calculateMaxCost} from "../../chain/gas.js";
import type {ChainRegistry} from "../../chain/chainRegistry.js";
import type {TenantBalanceReader} from "../../chain/tenantBalance.js";
import type {SubscriptionService} from "../../billing/subscription.js";
import {noopTracer, withSpan, type Span, type Tracer} from "../../monitoring/tracing.js";
import type {TenantId} from "../../db/scope.js";
import {decodeCallTargets} from "../../policy/callData.js";
import {deny, type PolicyContext, type PolicyDenial} from "../../policy/context.js";
import type {PolicyEngine} from "../../policy/engine.js";
import type {PolicySource} from "../../policy/policySource.js";
import {onChainTenantKey} from "../../signature/paymasterLayout.js";
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
  constructor(
    readonly denial: PolicyDenial,
    readonly policyId: string,
  ) {
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

/**
 * Records what we committed to pay. A port, so this service does not depend on PostgreSQL —
 * SponsorshipRepository satisfies it structurally.
 */
export interface SponsorshipRecorder {
  record(sponsorship: {
    chainId: number;
    sender: Address;
    nonce: bigint;
    paymaster: Address;
    entryPoint: Address;
    tenantId: TenantId;
    apiKeyId: string;
    policyId: string;
    signer: Address;
    maxCostWei: bigint;
    validAfter: number;
    validUntil: number;
  }): Promise<unknown>;
}

export interface SponsorServiceDeps {
  readonly chains: ChainRegistry;
  readonly policies: PolicySource;
  readonly policyEngine: PolicyEngine;
  readonly signatureEngine: SignatureEngine;
  /**
   * Optional. When absent — a single-node deployment with no database — attestations are issued
   * but not recorded, and there is no audit trail. `bootstrap` warns about this.
   */
  readonly sponsorships?: SponsorshipRecorder | undefined;
  /**
   * Reads tenant balances so an unfunded request is refused before it is signed. Optional: absent
   * on a deployment with no multi-tenant chain, and absent in tests that do not care. When it is
   * absent the contract still refuses the operation — see the note at the call site.
   */
  readonly tenantBalances?: TenantBalanceReader | undefined;
  /**
   * Decides whether the tenant's platform subscription still permits sponsorship. Optional: absent
   * on a deployment that does not sell subscriptions, where every request proceeds.
   */
  readonly subscriptions?: SubscriptionService | undefined;
  readonly options: SponsorServiceOptions;
  /** Injected so evaluation is deterministic and testable. Unix seconds. */
  readonly now?: () => number;
  /** Optional sink for sponsorship-outcome metrics. Absent in tests and when metrics are disabled. */
  readonly metrics?: SponsorshipMetrics | undefined;
  /** Optional tracer. Defaults to the no-op, so tracing is free when it is off. */
  readonly tracer?: Tracer | undefined;
}

/** The metrics this service emits. A port so the service does not depend on the metrics facade. */
export interface SponsorshipMetrics {
  recordSponsorship(chainId: number, outcome: "issued" | "denied" | "error", committedWei?: bigint): void;
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

  /**
   * Traced at this boundary rather than inside: one span per sponsorship, carrying the decision and
   * the amount committed, is what makes a slow or denied request answerable from a trace alone. The
   * span joins the HTTP server span above it through the ambient context, so no plumbing is needed.
   */
  async sponsor(request: SponsorRequest, caller: CallerIdentity): Promise<SponsorResponse> {
    return withSpan(
      this.#deps.tracer ?? noopTracer,
      "sponsor",
      {
        kind: "internal",
        attributes: {"paymaster.chain_id": request.chainId},
        expected: (error) => error instanceof SponsorshipDeniedError,
      },
      (span) => this.#sponsor(request, caller, span),
    );
  }

  /**
   * Fails OPEN when the balance cannot be read.
   *
   * That is deliberate and is only defensible because of what this check is: an early, friendlier
   * rejection of something the CONTRACT would refuse anyway. Failing closed would convert an RPC
   * blip into a total sponsorship outage for every multi-tenant chain, to protect money that is
   * already protected on chain. An unreadable balance therefore proceeds to signing, and an
   * unfunded tenant gets the `AA33` it would have got before this check existed.
   */
  async #readBalance(chainId: number, tenant: TenantId): Promise<bigint | undefined> {
    const balances = this.#deps.tenantBalances;
    if (balances === undefined) return undefined;
    try {
      return await balances.balanceOf(chainId, tenant);
    } catch {
      return undefined;
    }
  }

  async #sponsor(request: SponsorRequest, caller: CallerIdentity, span: Span): Promise<SponsorResponse> {
    const {chains, policies, policyEngine, signatureEngine, options} = this.#deps;

    // Throws UnknownChainError / ChainDisabledError, which the filter maps to 4xx.
    const chain = chains.get(request.chainId);
    const policyId = request.policyId ?? options.defaultPolicyId;
    // Resolved within the CALLER'S tenant. Two tenants may both have a policy called "default",
    // and serving one tenant the other's rules is the failure this whole boundary exists to make
    // impossible — so the tenant is required here, not defaulted.
    const policy = policies.get(caller.tenantId, policyId);
    span.setAttribute("paymaster.policy_id", policyId);

    const userOp = toPackedUserOperation(request.userOperation);

    // Priced against the limits WE will commit to, not anything the caller supplied.
    const maxCost = calculateMaxCost({
      userOp,
      paymasterVerificationGasLimit: options.paymasterVerificationGasLimit,
      postOpGasLimit: options.postOpGasLimit,
    });

    /**
     * The subscription is checked before the balance, and both before policy, because this is the
     * cheapest question and the one whose answer changes least often.
     *
     * A LAPSED subscription stops sponsorship and nothing else — the customer can still sign in,
     * read their balance, see what they owe and pay. Modelling this as `tenants.status =
     * 'suspended'` would have locked them out of the dashboard they need in order to fix it.
     */
    const subscription = await this.#deps.subscriptions?.statusOf(caller.tenantId);
    if (subscription !== undefined && !subscription.allowsSponsorship) {
      this.#deps.metrics?.recordSponsorship(request.chainId, "denied");
      span.setAttribute("paymaster.outcome", "denied");
      span.setAttribute("paymaster.denial_code", "SUBSCRIPTION_LAPSED");
      throw new SponsorshipDeniedError(
        deny(
          "subscription",
          "SUBSCRIPTION_LAPSED",
          subscription.graceEndsAt === undefined
            ? "no active subscription"
            : `subscription lapsed at ${new Date(subscription.graceEndsAt * 1000).toISOString()}`,
        ),
        policyId,
      );
    }

    /**
     * Checked BEFORE the policy is evaluated, so there is no reservation to unwind when it fails
     * and no RPC round-trip on a request policy would have refused anyway.
     *
     * This is a fail-fast, not the spend guard — the contract is the spend guard, and the reasons
     * this cannot be are written out in `TenantBalanceReader`. It exists so that the ordinary case
     * of a customer who has run out of money is a clean 402 instead of an `AA33` revert that costs
     * us bundler reputation to discover.
     */
    if (chain.config.paymasterKind === "tenant") {
      const balance = await this.#readBalance(request.chainId, caller.tenantId);
      if (balance !== undefined && balance < maxCost) {
        this.#deps.metrics?.recordSponsorship(request.chainId, "denied");
        span.setAttribute("paymaster.outcome", "denied");
        span.setAttribute("paymaster.denial_code", "TENANT_BALANCE_INSUFFICIENT");
        throw new SponsorshipDeniedError(
          deny(
            "tenantBalance",
            "TENANT_BALANCE_INSUFFICIENT",
            `tenant balance ${balance} wei is below the ${maxCost} wei this operation may cost`,
          ),
          policyId,
        );
      }
    }

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
      this.#deps.metrics?.recordSponsorship(request.chainId, "denied");
      // Attributes, not a span error: a denial is this service working correctly. The trace should
      // show WHICH rule refused without the request being counted as a failure.
      span.setAttribute("paymaster.outcome", "denied");
      span.setAttribute("paymaster.denial_rule", evaluation.decision.rule);
      span.setAttribute("paymaster.denial_code", evaluation.decision.code);
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
      const attestationRequest = {
        userOp,
        chainId: request.chainId,
        paymaster: chain.config.paymaster,
        paymasterVerificationGasLimit: options.paymasterVerificationGasLimit,
        postOpGasLimit: options.postOpGasLimit,
        validUntil,
        validAfter: 0,
      };
      /**
       * On a multi-tenant chain the tenant goes INSIDE the signature, so the caller's own tenant is
       * what the chain will debit. It is taken from the authenticated caller and never from the
       * request body — a tenant a caller could name is a tenant a caller could spend.
       */
      const attestation = await signatureEngine.attest(
        chain.config.paymasterKind === "verifying"
          ? {kind: "verifying", ...attestationRequest}
          : {kind: "tenant", ...attestationRequest, tenant: onChainTenantKey(caller.tenantId)},
      );

      // This tenant has just committed to spend, so the cached balance is now the most misleading
      // number we hold — it is precisely the tenant about to run out who will ask again next.
      this.#deps.tenantBalances?.invalidate(request.chainId, caller.tenantId);

      /**
       * Recorded BEFORE the attestation is returned, and awaited.
       *
       * This trades availability for auditability, deliberately. If the database is down we could
       * return the attestation anyway and stay up — but then we have signed a commitment to spend
       * money with no record of who asked, under what policy, or for how much. "We paid and cannot
       * say why" is a worse outcome than "we declined for ten minutes": the first is unbounded and
       * permanent, the second is bounded and recoverable.
       *
       * A failure here falls into the catch below, which releases the reservation and surfaces the
       * error — so the caller is not charged quota for a sponsorship they never received.
       */
      await this.#deps.sponsorships?.record({
        chainId: request.chainId,
        tenantId: caller.tenantId,
        sender: request.userOperation.sender,
        nonce: request.userOperation.nonce,
        paymaster: chain.config.paymaster,
        entryPoint: chain.config.entryPoint,
        apiKeyId: caller.apiKeyId ?? "anonymous",
        policyId,
        signer: attestation.signer,
        maxCostWei: maxCost,
        validAfter: attestation.validAfter,
        validUntil: attestation.validUntil,
      });

      this.#deps.metrics?.recordSponsorship(request.chainId, "issued", maxCost);
      span.setAttribute("paymaster.outcome", "issued");
      // A string: wei exceeds the integer range a tracing backend will render faithfully.
      span.setAttribute("paymaster.max_cost_wei", maxCost.toString());

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
      this.#deps.metrics?.recordSponsorship(request.chainId, "error");
      // Best-effort refund. A failed release leaks the caller's budget until the window rolls,
      // which is bad; masking the original error with a release failure would be worse.
      await policyEngine.releaseReservations(policy, context).catch(() => undefined);
      throw error;
    }
  }
}

export interface CallerIdentity {
  /**
   * Whose request this is. Required — every sponsorship belongs to a tenant, and there is no
   * anonymous sponsorship: the policy set, the spend caps and (later) the balance are all theirs.
   */
  readonly tenantId: TenantId;
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
