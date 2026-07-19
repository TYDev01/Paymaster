import {type Address, type Hex} from "viem";

import {jsonRpc, type TransportOptions} from "./transport.js";
import {toRpcUserOperation} from "./userOpHash.js";
import type {GasEstimate, UserOperation, UserOperationReceipt} from "./types.js";

export interface BundlerClientConfig {
  /** The bundler's JSON-RPC endpoint. */
  readonly endpoint: string;
  readonly transport?: TransportOptions | undefined;
}

/**
 * Talks to the self-hosted bundler over ERC-4337 JSON-RPC.
 *
 * Deliberately thin: it speaks the standard methods and converts hex to bigint at the boundary,
 * nothing more. Orchestration — estimate, sponsor, sign, send — is SponsoredBundlerClient's job,
 * so this stays usable on its own against any conforming bundler.
 */
export class BundlerClient {
  readonly #endpoint: string;
  readonly #transport: TransportOptions;

  constructor(config: BundlerClientConfig) {
    this.#endpoint = config.endpoint;
    this.#transport = config.transport ?? {};
  }

  async supportedEntryPoints(): Promise<Address[]> {
    return jsonRpc<Address[]>(this.#endpoint, "eth_supportedEntryPoints", [], this.#transport);
  }

  async chainId(): Promise<number> {
    return Number(await jsonRpc<Hex>(this.#endpoint, "eth_chainId", [], this.#transport));
  }

  /**
   * Estimates gas for an operation.
   *
   * The operation need not be signed — estimation runs a simulation, and the account signature is
   * not checked during it. It DOES need its paymaster fields if it will be sponsored, because the
   * paymaster's validation gas is part of what is being estimated.
   */
  async estimateUserOperationGas(op: PartialForEstimate, entryPoint: Address): Promise<GasEstimate> {
    const result = await jsonRpc<Record<string, Hex>>(
      this.#endpoint,
      "eth_estimateUserOperationGas",
      [op, entryPoint],
      this.#transport,
    );

    return {
      preVerificationGas: BigInt(result["preVerificationGas"] ?? "0x0"),
      verificationGasLimit: BigInt(result["verificationGasLimit"] ?? "0x0"),
      callGasLimit: BigInt(result["callGasLimit"] ?? "0x0"),
      ...(result["paymasterVerificationGasLimit"] === undefined
        ? {}
        : {paymasterVerificationGasLimit: BigInt(result["paymasterVerificationGasLimit"])}),
      ...(result["paymasterPostOpGasLimit"] === undefined
        ? {}
        : {paymasterPostOpGasLimit: BigInt(result["paymasterPostOpGasLimit"])}),
    };
  }

  /** Submits a fully signed operation. Returns its hash. Throws JsonRpcError on rejection. */
  async sendUserOperation(op: UserOperation, entryPoint: Address): Promise<Hex> {
    return jsonRpc<Hex>(this.#endpoint, "eth_sendUserOperation", [toRpcUserOperation(op), entryPoint], this.#transport);
  }

  /** The receipt, or null if the operation has not been mined yet. */
  async getUserOperationReceipt(userOpHash: Hex): Promise<UserOperationReceipt | null> {
    const raw = await jsonRpc<RpcReceipt | null>(
      this.#endpoint,
      "eth_getUserOperationReceipt",
      [userOpHash],
      this.#transport,
    );
    if (raw == null) return null;

    return {
      userOpHash: raw.userOpHash,
      sender: raw.sender,
      success: raw.success,
      actualGasCost: BigInt(raw.actualGasCost),
      actualGasUsed: BigInt(raw.actualGasUsed),
      transactionHash: raw.receipt.transactionHash,
      blockNumber: BigInt(raw.receipt.blockNumber),
    };
  }

  /**
   * Polls until the operation is mined.
   *
   * The bundler mines on its own schedule, so this is a poll, not a subscription. It throws on
   * timeout rather than returning null, because "not yet" and "never" are different outcomes a
   * caller must handle differently, and a silent null conflates them.
   */
  async waitForUserOperationReceipt(
    userOpHash: Hex,
    options: {timeoutMs?: number; pollIntervalMs?: number} = {},
  ): Promise<UserOperationReceipt> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const receipt = await this.getUserOperationReceipt(userOpHash);
      if (receipt !== null) return receipt;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`UserOperation ${userOpHash} was not mined within ${timeoutMs}ms`);
  }
}

/** For estimation: a UserOperation without the gas fields being estimated. */
export type PartialForEstimate = Record<string, unknown>;

interface RpcReceipt {
  userOpHash: Hex;
  sender: Address;
  success: boolean;
  actualGasCost: Hex;
  actualGasUsed: Hex;
  receipt: {transactionHash: Hex; blockNumber: Hex};
}
