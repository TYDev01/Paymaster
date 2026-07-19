import {type Address, type Hex} from "viem";

import {BundlerClient} from "./bundlerClient.js";
import {PaymasterClient} from "./paymasterClient.js";
import {getUserOperationHash, toRpcUserOperation} from "./userOpHash.js";
import {PaymasterSdkError, type TransportOptions} from "./transport.js";
import type {SignUserOperationHash, UserOperation, UserOperationReceipt, UserOperationRequest} from "./types.js";

export interface SponsoredBundlerConfig {
  readonly entryPoint: Address;
  readonly chainId: number;
  readonly bundler: {endpoint: string; transport?: TransportOptions};
  readonly paymaster: {endpoint: string; apiKey?: string; policyId?: string; transport?: TransportOptions};
  /**
   * Default fees when a request omits them. Most callers should instead read fees from the chain
   * and pass them in — a fee below the chain's floor gets the operation rejected by the bundler.
   */
  readonly defaultMaxFeePerGas?: bigint;
  readonly defaultMaxPriorityFeePerGas?: bigint;
}

export interface SendOptions {
  readonly signUserOperationHash: SignUserOperationHash;
  /** Override or supply fees for this operation. */
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly waitTimeoutMs?: number;
}

/**
 * The one call td2.md asks for: a wallet hands over what it wants to do, and this drives the whole
 * pipeline — estimate at the bundler, sponsor at the paymaster, sign via the wallet's callback,
 * submit to the bundler.
 *
 * The ORDER is the subtle part, and it is not negotiable:
 *
 *   1. estimate gas          — the paymaster prices the sponsorship from these limits
 *   2. sponsor               — produces paymasterAndData
 *   3. compute the hash      — which now covers paymasterAndData
 *   4. sign                  — the account signature is over that hash
 *   5. submit
 *
 * Signing before sponsoring would sign a hash that does not include the paymaster, and the
 * operation would be rejected: the signed bytes and the submitted bytes would differ. This class
 * exists largely to make that ordering impossible to get wrong.
 */
export class SponsoredBundlerClient {
  readonly bundler: BundlerClient;
  readonly paymaster: PaymasterClient;
  readonly #config: SponsoredBundlerConfig;

  constructor(config: SponsoredBundlerConfig) {
    this.#config = config;
    this.bundler = new BundlerClient({
      endpoint: config.bundler.endpoint,
      ...(config.bundler.transport === undefined ? {} : {transport: config.bundler.transport}),
    });
    this.paymaster = new PaymasterClient({
      endpoint: config.paymaster.endpoint,
      chainId: config.chainId,
      ...(config.paymaster.apiKey === undefined ? {} : {apiKey: config.paymaster.apiKey}),
      ...(config.paymaster.policyId === undefined ? {} : {policyId: config.paymaster.policyId}),
      ...(config.paymaster.transport === undefined ? {} : {transport: config.paymaster.transport}),
    });
  }

  /**
   * Prepares a fully signed, sponsored operation without submitting it.
   *
   * Separate from `sendUserOperation` so a caller can inspect what will be sent, dry-run, or submit
   * through a different path. `sendUserOperation` is this plus a submit and a wait.
   */
  async prepareUserOperation(request: UserOperationRequest, options: SendOptions): Promise<UserOperation> {
    const maxFeePerGas = options.maxFeePerGas ?? request.maxFeePerGas ?? this.#config.defaultMaxFeePerGas;
    const maxPriorityFeePerGas =
      options.maxPriorityFeePerGas ?? request.maxPriorityFeePerGas ?? this.#config.defaultMaxPriorityFeePerGas;
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      throw new PaymasterSdkError("maxFeePerGas and maxPriorityFeePerGas are required (pass them or set defaults)");
    }

    // A draft with generous placeholder gas, so the first sponsorship and the estimation have
    // valid fields to work with.
    const draft: UserOperation = {
      sender: request.sender,
      nonce: request.nonce,
      ...(request.factory === undefined ? {} : {factory: request.factory, factoryData: request.factoryData}),
      callData: request.callData,
      callGasLimit: request.callGasLimit ?? 1_000_000n,
      verificationGasLimit: request.verificationGasLimit ?? 1_000_000n,
      preVerificationGas: request.preVerificationGas ?? 100_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      signature: DUMMY_SIGNATURE,
    };

    /**
     * The chicken-and-egg: estimation must see a paymaster or the account is charged the prefund
     * and validation reverts (AA23) because a smart account holds no ETH — but the sponsorship
     * signature covers the gas limits, which is what estimation is trying to discover. Resolved
     * the way production paymaster stacks resolve it: a PRELIMINARY sponsorship over the placeholder
     * limits, used only to make the operation simulate as sponsored during estimation, then a
     * FINAL sponsorship over the estimated limits, which is the one that gets signed and submitted.
     */
    // 1. Preliminary sponsorship — a valid attestation over the placeholder limits.
    const stubbed = await this.paymaster.applySponsorshipTo(draft);

    // 2. Estimate, with the paymaster present so the account is not the payer.
    const estimate = await this.bundler.estimateUserOperationGas(toRpcUserOperation(stubbed), this.#config.entryPoint);
    const estimated: UserOperation = {
      ...draft,
      callGasLimit: estimate.callGasLimit,
      verificationGasLimit: estimate.verificationGasLimit,
      preVerificationGas: estimate.preVerificationGas,
    };

    // 3. Final sponsorship — priced against and signed over the estimated limits.
    const sponsored = await this.paymaster.applySponsorshipTo(estimated);

    // 4 + 5. Hash NOW — it covers the final paymasterAndData — then sign.
    const userOpHash = getUserOperationHash(sponsored, this.#config.entryPoint, this.#config.chainId);
    const signature = await options.signUserOperationHash(userOpHash);

    return {...sponsored, signature};
  }

  /** prepare + submit + wait. The single call for "sponsor and send this operation." */
  async sendUserOperation(request: UserOperationRequest, options: SendOptions): Promise<UserOperationReceipt> {
    const op = await this.prepareUserOperation(request, options);
    const userOpHash = await this.bundler.sendUserOperation(op, this.#config.entryPoint);
    return this.bundler.waitForUserOperationReceipt(userOpHash, {
      ...(options.waitTimeoutMs === undefined ? {} : {timeoutMs: options.waitTimeoutMs}),
    });
  }

  /** The hash a caller would sign for `op`, for building custom flows. */
  hashUserOperation(op: UserOperation): Hex {
    return getUserOperationHash(op, this.#config.entryPoint, this.#config.chainId);
  }
}

/**
 * A structurally valid 65-byte ECDSA signature used only for gas estimation.
 *
 * Estimation never verifies this signature, but it must survive two checks that a random 65 bytes
 * does not:
 *   - EXACTLY 65 bytes of valid (even-length) hex, or the bundler fails to deserialize the request
 *     and rundler reports it as an opaque "did not match any variant" error naming nothing;
 *   - a LOW `s` value. OpenZeppelin's ECDSA.recover reverts on a high-s signature (EIP-2
 *     malleability guard), and a reverting account validation surfaces as AA23 — which looks like a
 *     paymaster or funding problem, not a signature-shape one.
 *
 * Layout: 32-byte r ++ 32-byte s (top byte 0x7a keeps it below n/2) ++ v. This is the widely used
 * dummy; it is not valid for any key and is replaced before submission.
 */
const DUMMY_SIGNATURE: Hex = `0x${"ff".repeat(15)}f0${"00".repeat(16)}7a${"aa".repeat(31)}1c`;
