import {getAddress, type Address, type Hex} from "viem";

import type {ChainRegistry} from "../chain/chainRegistry.js";
import type {TenantId} from "../db/scope.js";
import {onChainTenantKey} from "../signature/paymasterLayout.js";
import type {Plan} from "./plans.js";

/**
 * Why a claimed payment was not accepted. The message is customer-facing: it is what they read on
 * the billing page after sending money, so it says what to do next.
 */
export class PaymentVerificationError extends Error {
  constructor(
    readonly code:
      | "NOT_SOLD_ON_CHAIN"
      | "NOT_FOUND"
      | "REVERTED"
      | "WRONG_RECIPIENT"
      | "WRONG_ACCOUNT"
      | "UNDERPAID"
      | "UNCONFIRMED",
    message: string,
  ) {
    super(message);
    this.name = "PaymentVerificationError";
  }
}

export interface PaymentVerifierOptions {
  /** Where subscription payments are sent. The same address on every chain. */
  readonly treasury: Address;
  /** Blocks a payment must be buried under before it buys time. */
  readonly confirmations: number;
  /** Cap on periods one transfer may buy, so an extra zero does not sell a decade. */
  readonly maxPeriodsPerPayment: number;
}

export interface VerifiedPayment {
  readonly chainId: number;
  readonly txHash: Hex;
  readonly from: Address;
  readonly amountWei: bigint;
  /** Whole periods the amount pays for, at least 1. */
  readonly periods: number;
}

/**
 * Turns "I paid" into a fact, by reading the transaction from the chain.
 *
 * Payment detection without a platform operator in the loop. The customer sends the plan price to
 * the treasury with their tenant key as the transaction data, and then claims it by hash. Every
 * property that decides whether time is granted is read from the chain here — the customer supplies
 * only the hash, never the amount, recipient or account.
 *
 * WHY THE TENANT KEY IS IN THE CALLDATA. A plain transfer says who sent it, and a sender is not an
 * account: wallets are shared, rotated and used across organisations. Without the key in the data,
 * any customer could claim any other customer's payment by hash. With it, the transfer names the
 * account it was for and the claim is checked against the claimer's own account.
 *
 * Double-claiming is not this class's problem: the unique index on (chain_id, tx_hash) makes a
 * transaction buy time exactly once, whoever claims it and however often.
 */
export class PaymentVerifier {
  readonly #chains: ChainRegistry;
  readonly #options: PaymentVerifierOptions;

  constructor(chains: ChainRegistry, options: PaymentVerifierOptions) {
    this.#chains = chains;
    this.#options = {...options, treasury: getAddress(options.treasury)};
  }

  get treasury(): Address {
    return this.#options.treasury;
  }

  /** What the transaction data must be for a payment to count for this tenant. */
  paymentData(tenant: TenantId): Hex {
    return onChainTenantKey(tenant);
  }

  async verify(request: {chainId: number; txHash: Hex; tenant: TenantId; plan: Plan}): Promise<VerifiedPayment> {
    const {chainId, txHash, tenant, plan} = request;

    const price = plan.priceWei.get(chainId);
    if (price === undefined) {
      throw new PaymentVerificationError(
        "NOT_SOLD_ON_CHAIN",
        `the ${plan.name} plan cannot be paid for on chain ${chainId}`,
      );
    }

    const chain = this.#chains.getEvenIfDisabled(chainId);
    const transfer = await chain.getNativeTransfer(txHash);
    if (transfer === undefined) {
      throw new PaymentVerificationError(
        "NOT_FOUND",
        "that transaction is not on chain yet — if you just sent it, wait for it to be mined and claim again",
      );
    }
    if (!transfer.success) {
      throw new PaymentVerificationError("REVERTED", "that transaction reverted, so nothing was paid");
    }
    if (transfer.to === null || getAddress(transfer.to) !== this.#options.treasury) {
      throw new PaymentVerificationError(
        "WRONG_RECIPIENT",
        `that transaction was not sent to the subscription address ${this.#options.treasury}`,
      );
    }
    if (transfer.input.toLowerCase() !== this.paymentData(tenant).toLowerCase()) {
      throw new PaymentVerificationError(
        "WRONG_ACCOUNT",
        "that transaction does not carry this account's payment reference as its data, so it cannot be " +
          "credited here. If it was meant for this account, contact your platform operator with the hash.",
      );
    }
    if (transfer.valueWei < price) {
      throw new PaymentVerificationError(
        "UNDERPAID",
        `that transaction paid ${transfer.valueWei} wei; the ${plan.name} plan costs ${price} wei on this chain`,
      );
    }

    const head = await chain.blockNumber();
    const depth = head - transfer.blockNumber + 1n;
    if (depth < BigInt(this.#options.confirmations)) {
      throw new PaymentVerificationError(
        "UNCONFIRMED",
        `that payment has ${depth} of the ${this.#options.confirmations} confirmations it needs — claim again shortly`,
      );
    }

    // Overpayment buys whole extra periods rather than being kept; a remainder smaller than one
    // period is not refundable on chain and is recorded as paid.
    const periods = Number(transfer.valueWei / price);
    return {
      chainId,
      txHash,
      from: transfer.from,
      amountWei: transfer.valueWei,
      periods: Math.max(1, Math.min(periods, this.#options.maxPeriodsPerPayment)),
    };
  }
}
