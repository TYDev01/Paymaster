import {decodeFunctionData, parseAbi, size, slice, type Hex} from "viem";

import type {DecodedCall} from "./context.js";

/**
 * Account calldata shapes we can decode.
 *
 * ERC-4337 does not standardise the account's execution interface — `callData` is opaque bytes the
 * EntryPoint hands to the account. In practice most accounts converge on these two shapes, which
 * SimpleAccount, Kernel, Biconomy and others implement compatibly.
 *
 * Selectors verified against the compiled SimpleAccount artifact:
 *   execute(address,uint256,bytes)              -> 0xb61d27f6
 *   executeBatch(address[],uint256[],bytes[])   -> 0x47e1da2a
 *
 * Accounts using a different interface decode to `undefined`, NOT to an empty call list. The
 * distinction is load-bearing: "this calls nothing" would let an unrecognised account slip past a
 * target allowlist, whereas "we cannot tell" makes target-dependent rules deny.
 */
const ACCOUNT_EXECUTION_ABI = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
]);

const SELECTOR_SIZE = 4;

/**
 * Decodes the calls a UserOperation's `callData` will make.
 *
 * Returns `undefined` when the calldata does not match a known account interface, which callers
 * must treat as "unknown", never as "harmless".
 */
export function decodeCallTargets(callData: Hex): readonly DecodedCall[] | undefined {
  if (size(callData) < SELECTOR_SIZE) return undefined;

  let decoded: ReturnType<typeof decodeFunctionData<typeof ACCOUNT_EXECUTION_ABI>>;
  try {
    decoded = decodeFunctionData({abi: ACCOUNT_EXECUTION_ABI, data: callData});
  } catch {
    // Unknown selector, or arguments that do not match the shape the selector claims.
    return undefined;
  }

  if (decoded.functionName === "execute") {
    const [dest, value, func] = decoded.args;
    return [toCall(dest, value, func)];
  }

  const [dests, values, funcs] = decoded.args;
  // A well-formed batch has parallel arrays. Ragged input is a malformed request, not an empty
  // batch, so it decodes to "unknown" and target rules deny.
  if (dests.length !== values.length || dests.length !== funcs.length) return undefined;

  return dests.map((dest, i) => toCall(dest, values[i]!, funcs[i]!));
}

function toCall(target: string, value: bigint, data: Hex): DecodedCall {
  return {
    target: target as DecodedCall["target"],
    value,
    selector: size(data) >= SELECTOR_SIZE ? slice(data, 0, SELECTOR_SIZE) : undefined,
    data,
  };
}
