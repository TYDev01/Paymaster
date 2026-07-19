import {numberToHex, type Address, type Hex} from "viem";

import {httpApi, type TransportOptions} from "./transport.js";
import type {Sponsorship, UserOperation} from "./types.js";

export interface PaymasterClientConfig {
  /** Base URL of the sponsorship API, e.g. https://paymaster.example.com */
  readonly endpoint: string;
  readonly chainId: number;
  /** API key. Sent as a Bearer token — the endpoint refuses unauthenticated requests. */
  readonly apiKey?: string | undefined;
  /** Names a policy explicitly. Ignored by the server when the key pins its own policy. */
  readonly policyId?: string | undefined;
  readonly transport?: TransportOptions | undefined;
}

interface SponsorApiResponse {
  paymaster: Address;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  paymasterData: Hex;
  validUntil: number;
  validAfter: number;
  metadata: {maxCost: string};
}

/**
 * Talks to the sponsorship API — td.md's `PaymasterClient`.
 *
 *   const paymaster = new PaymasterClient({ endpoint, chainId: 8453, apiKey });
 *   const sponsorship = await paymaster.sponsor(userOperation);
 *
 * The operation passed to `sponsor` must already carry its gas limits: the paymaster prices the
 * sponsorship from them, and a sponsorship priced against different limits than the ones finally
 * submitted would be rejected on-chain. Estimate gas first (BundlerClient.estimateUserOperationGas),
 * then sponsor.
 */
export class PaymasterClient {
  readonly #config: PaymasterClientConfig;

  constructor(config: PaymasterClientConfig) {
    this.#config = config;
  }

  get chainId(): number {
    return this.#config.chainId;
  }

  async sponsor(userOp: UserOperation): Promise<Sponsorship> {
    const body = {
      chainId: this.#config.chainId,
      ...(this.#config.policyId === undefined ? {} : {policyId: this.#config.policyId}),
      userOperation: {
        sender: userOp.sender,
        nonce: numberToHex(userOp.nonce),
        ...(userOp.factory === undefined ? {} : {factory: userOp.factory, factoryData: userOp.factoryData ?? "0x"}),
        callData: userOp.callData,
        callGasLimit: numberToHex(userOp.callGasLimit),
        verificationGasLimit: numberToHex(userOp.verificationGasLimit),
        preVerificationGas: numberToHex(userOp.preVerificationGas),
        maxFeePerGas: numberToHex(userOp.maxFeePerGas),
        maxPriorityFeePerGas: numberToHex(userOp.maxPriorityFeePerGas),
      },
    };

    const response = await httpApi<SponsorApiResponse>(
      `${trimTrailingSlash(this.#config.endpoint)}/paymaster/sponsor`,
      body,
      this.#authTransport(),
    );

    return {
      paymaster: response.paymaster,
      paymasterVerificationGasLimit: BigInt(response.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: BigInt(response.paymasterPostOpGasLimit),
      paymasterData: response.paymasterData,
      validUntil: response.validUntil,
      validAfter: response.validAfter,
      maxCost: BigInt(response.metadata.maxCost),
    };
  }

  /** Returns the operation with the sponsorship's paymaster fields applied. */
  async applySponsorshipTo(userOp: UserOperation): Promise<UserOperation> {
    const sponsorship = await this.sponsor(userOp);
    return {
      ...userOp,
      paymaster: sponsorship.paymaster,
      paymasterVerificationGasLimit: sponsorship.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: sponsorship.paymasterPostOpGasLimit,
      paymasterData: sponsorship.paymasterData,
    };
  }

  #authTransport(): TransportOptions {
    const base = this.#config.transport ?? {};
    if (this.#config.apiKey === undefined) return base;
    return {
      ...base,
      headers: {...base.headers, authorization: `Bearer ${this.#config.apiKey}`},
    };
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
