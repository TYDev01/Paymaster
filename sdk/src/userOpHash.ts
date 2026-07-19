import {concatHex, encodeAbiParameters, keccak256, numberToHex, size, type Address, type Hex} from "viem";

import type {UserOperation} from "./types.js";

/**
 * Packs two 128-bit values high-order first, matching EntryPoint's UserOperationLib.
 *
 * A silent overflow here would compute a hash over gas limits nobody asked for, so ranges are
 * checked rather than truncated.
 */
function packUint128Pair(high: bigint, low: bigint, label: string): Hex {
  const max = (1n << 128n) - 1n;
  if (high < 0n || high > max) throw new RangeError(`${label} high half out of uint128 range: ${high}`);
  if (low < 0n || low > max) throw new RangeError(`${label} low half out of uint128 range: ${low}`);
  return numberToHex((high << 128n) | low, {size: 32});
}

/**
 * `initCode` = factory ++ factoryData, or empty. The EntryPoint hashes this concatenation, so an
 * account being deployed and one already deployed produce different hashes for otherwise identical
 * operations — as they must, since only one of them pays account-creation gas.
 */
export function encodeInitCode(op: UserOperation): Hex {
  if (op.factory === undefined) return "0x";
  return concatHex([op.factory, op.factoryData ?? "0x"]);
}

/**
 * `paymasterAndData` = paymaster ++ verificationGasLimit ++ postOpGasLimit ++ paymasterData.
 *
 * Empty when there is no paymaster. The two gas limits are 16 bytes each, big-endian — the same
 * layout the paymaster contract parses and the sponsorship API returns.
 */
export function encodePaymasterAndData(op: UserOperation): Hex {
  if (op.paymaster === undefined) return "0x";
  return concatHex([
    op.paymaster,
    numberToHex(op.paymasterVerificationGasLimit ?? 0n, {size: 16}),
    numberToHex(op.paymasterPostOpGasLimit ?? 0n, {size: 16}),
    op.paymasterData ?? "0x",
  ]);
}

/**
 * The EntryPoint v0.7 UserOperation hash, computed locally.
 *
 * Equivalent to `EntryPoint.getUserOpHash(op)`:
 *
 *   inner = keccak256(abi.encode(
 *     sender, nonce, keccak256(initCode), keccak256(callData),
 *     accountGasLimits, preVerificationGas, gasFees, keccak256(paymasterAndData)))
 *   hash  = keccak256(abi.encode(inner, entryPoint, chainId))
 *
 * Computed locally rather than fetched, so a wallet can sign without a round-trip to an RPC — and
 * asserted equal to the deployed EntryPoint's own `getUserOpHash` in userOpHash.integration.test,
 * because a hash that disagrees by one field produces a signature the account rejects, for reasons
 * that are miserable to debug from a bundler error.
 */
export function getUserOperationHash(op: UserOperation, entryPoint: Address, chainId: number): Hex {
  const accountGasLimits = packUint128Pair(op.verificationGasLimit, op.callGasLimit, "accountGasLimits");
  const gasFees = packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas, "gasFees");

  const inner = keccak256(
    encodeAbiParameters(
      [
        {type: "address"},
        {type: "uint256"},
        {type: "bytes32"},
        {type: "bytes32"},
        {type: "bytes32"},
        {type: "uint256"},
        {type: "bytes32"},
        {type: "bytes32"},
      ],
      [
        op.sender,
        op.nonce,
        keccak256(encodeInitCode(op)),
        keccak256(op.callData),
        accountGasLimits,
        op.preVerificationGas,
        gasFees,
        keccak256(encodePaymasterAndData(op)),
      ],
    ),
  );

  return keccak256(
    encodeAbiParameters([{type: "bytes32"}, {type: "address"}, {type: "uint256"}], [
      inner,
      entryPoint,
      BigInt(chainId),
    ]),
  );
}

/** Serialises an operation to the hex-string JSON-RPC form a v0.7 bundler expects. */
export function toRpcUserOperation(op: UserOperation): Record<string, string> {
  const rpc: Record<string, string> = {
    sender: op.sender,
    nonce: numberToHex(op.nonce),
    callData: op.callData,
    callGasLimit: numberToHex(op.callGasLimit),
    verificationGasLimit: numberToHex(op.verificationGasLimit),
    preVerificationGas: numberToHex(op.preVerificationGas),
    maxFeePerGas: numberToHex(op.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(op.maxPriorityFeePerGas),
    signature: op.signature,
  };

  if (op.factory !== undefined) {
    rpc["factory"] = op.factory;
    rpc["factoryData"] = op.factoryData ?? "0x";
  }
  if (op.paymaster !== undefined) {
    rpc["paymaster"] = op.paymaster;
    rpc["paymasterVerificationGasLimit"] = numberToHex(op.paymasterVerificationGasLimit ?? 0n);
    rpc["paymasterPostOpGasLimit"] = numberToHex(op.paymasterPostOpGasLimit ?? 0n);
    rpc["paymasterData"] = op.paymasterData ?? "0x";
  }

  return rpc;
}

/** True when the paymaster fields describe a well-formed 20+16+16+tail layout. */
export function hasSponsorship(op: UserOperation): boolean {
  return op.paymaster !== undefined && op.paymasterData !== undefined && size(op.paymaster) === 20;
}
