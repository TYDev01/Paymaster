import {
  callGasLimit,
  maxFeePerGas,
  verificationGasLimit,
  type PackedUserOperation,
} from "../domain/userOperation.js";

export interface MaxCostParams {
  readonly userOp: PackedUserOperation;
  /** The limits WE are about to commit to, not whatever is on the incoming userOp. */
  readonly paymasterVerificationGasLimit: bigint;
  readonly postOpGasLimit: bigint;
}

/**
 * The most this operation can cost the paymaster's EntryPoint deposit, in wei.
 *
 * This mirrors `EntryPoint._getRequiredPrefund` exactly:
 *
 *   requiredGas = verificationGasLimit
 *               + callGasLimit
 *               + paymasterVerificationGasLimit
 *               + paymasterPostOpGasLimit
 *               + preVerificationGas
 *   prefund     = requiredGas * maxFeePerGas
 *
 * Two details are easy to get wrong and both matter:
 *
 * `maxFeePerGas` is used, not the effective gas price. The EntryPoint requires the paymaster to
 * have the full worst-case amount on deposit before it will run the operation, even though the
 * eventual charge is usually lower. A spend cap computed from the effective price would approve
 * operations the EntryPoint then refuses for insufficient deposit (AA31).
 *
 * The paymaster's own gas limits are part of the total. They come from the arguments rather than
 * from `userOp.paymasterAndData` because at policy-evaluation time we have not written them yet —
 * and using a caller-supplied value here would let a caller understate the cost we charge against
 * their quota.
 *
 * Verified against a real EntryPoint in `maxCost.test.ts`: funding the paymaster with exactly this
 * amount lets the operation through, and one wei less fails with AA31.
 */
export function calculateMaxCost(params: MaxCostParams): bigint {
  const {userOp, paymasterVerificationGasLimit, postOpGasLimit} = params;

  const requiredGas =
    verificationGasLimit(userOp) +
    callGasLimit(userOp) +
    paymasterVerificationGasLimit +
    postOpGasLimit +
    userOp.preVerificationGas;

  return requiredGas * maxFeePerGas(userOp);
}
