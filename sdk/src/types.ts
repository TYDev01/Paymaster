import type {Address, Hex} from "viem";

/**
 * An EntryPoint v0.7 UserOperation in its UNPACKED, JSON-RPC form.
 *
 * This is the shape `eth_sendUserOperation` and `eth_estimateUserOperationGas` take, and the shape
 * our sponsorship API takes — not the packed on-chain struct. Clients work in the unpacked form;
 * packing happens once, inside the hash computation, where it is differentially tested against the
 * deployed EntryPoint.
 *
 * Quantities are bigint throughout the public API. They cross the wire as hex strings, but a
 * caller should never have to hex-encode a fee — the client does that at the boundary.
 */
export interface UserOperation {
  readonly sender: Address;
  readonly nonce: bigint;
  /** Account-deployment fields. Both present or both absent. */
  readonly factory?: Address | undefined;
  readonly factoryData?: Hex | undefined;
  readonly callData: Hex;
  readonly callGasLimit: bigint;
  readonly verificationGasLimit: bigint;
  readonly preVerificationGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** Paymaster fields, populated by a sponsorship. */
  readonly paymaster?: Address | undefined;
  readonly paymasterVerificationGasLimit?: bigint | undefined;
  readonly paymasterPostOpGasLimit?: bigint | undefined;
  readonly paymasterData?: Hex | undefined;
  readonly signature: Hex;
}

/**
 * A UserOperation before gas estimation and signing.
 *
 * Gas fields are optional: `estimateUserOperationGas` fills the limits and `sponsor` implies the
 * paymaster fields, so a caller supplies only what defines the operation — who is sending, and
 * what it does.
 */
export interface UserOperationRequest {
  readonly sender: Address;
  readonly nonce: bigint;
  readonly factory?: Address | undefined;
  readonly factoryData?: Hex | undefined;
  readonly callData: Hex;
  readonly callGasLimit?: bigint | undefined;
  readonly verificationGasLimit?: bigint | undefined;
  readonly preVerificationGas?: bigint | undefined;
  readonly maxFeePerGas?: bigint | undefined;
  readonly maxPriorityFeePerGas?: bigint | undefined;
}

/** What the sponsorship API returns: the paymaster fields to put on the operation. */
export interface Sponsorship {
  readonly paymaster: Address;
  readonly paymasterVerificationGasLimit: bigint;
  readonly paymasterPostOpGasLimit: bigint;
  readonly paymasterData: Hex;
  readonly validUntil: number;
  readonly validAfter: number;
  readonly maxCost: bigint;
}

/** Gas limits returned by `eth_estimateUserOperationGas`. */
export interface GasEstimate {
  readonly preVerificationGas: bigint;
  readonly verificationGasLimit: bigint;
  readonly callGasLimit: bigint;
  readonly paymasterVerificationGasLimit?: bigint | undefined;
  readonly paymasterPostOpGasLimit?: bigint | undefined;
}

/** The receipt returned by `eth_getUserOperationReceipt`, trimmed to the fields callers use. */
export interface UserOperationReceipt {
  readonly userOpHash: Hex;
  readonly sender: Address;
  readonly success: boolean;
  readonly actualGasCost: bigint;
  readonly actualGasUsed: bigint;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
}

/**
 * Signs the UserOperation hash on behalf of the sending account.
 *
 * The SDK never holds a key. It hands the raw hash to this callback, and the caller signs it
 * however their account expects — a SimpleAccount applies the EIP-191 personal-sign prefix, a
 * different account may not. Keeping this a callback is what makes the SDK account-agnostic.
 */
export type SignUserOperationHash = (userOpHash: Hex) => Promise<Hex> | Hex;
