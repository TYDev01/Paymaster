import {hashTypedData, type Address, type Hex} from "viem";

import {sponsorshipDomain} from "./typedData.js";
import type {SponsorshipSigner} from "./signer.js";

/**
 * Must match `CONTROLLER_TYPEHASH` in TenantPaymaster.sol. Field order is part of the hash.
 */
export const CONTROLLER_ASSIGNMENT_TYPES = {
  ControllerAssignment: [
    {name: "tenant", type: "bytes32"},
    {name: "controller", type: "address"},
    {name: "nonce", type: "uint256"},
    {name: "deadline", type: "uint48"},
  ],
} as const;

export interface ControllerAssignmentParams {
  readonly chainId: number;
  readonly paymaster: Address;
  readonly tenant: Hex;
  readonly controller: Address;
  readonly nonce: bigint;
  /** Unix seconds after which the contract refuses the claim. */
  readonly deadline: number;
}

export interface ControllerAssignment extends ControllerAssignmentParams {
  readonly signature: Hex;
  readonly signer: Address;
}

/**
 * The digest `claimController` recovers a signer from. Same EIP-712 domain as the tenant
 * sponsorship, because it is the same contract; `tenantDifferential.test.ts` checks it against
 * `getControllerAssignmentHash` on real bytecode.
 */
export function controllerAssignmentDigest(params: ControllerAssignmentParams): Hex {
  return hashTypedData({
    domain: sponsorshipDomain(params.chainId, params.paymaster, "tenant"),
    types: CONTROLLER_ASSIGNMENT_TYPES,
    primaryType: "ControllerAssignment",
    message: {
      tenant: params.tenant,
      controller: params.controller,
      nonce: params.nonce,
      deadline: params.deadline,
    },
  });
}

/**
 * Signs a controller assignment with the sponsorship signer.
 *
 * The same key, deliberately: it is already the key the contract trusts, and a second on-chain
 * signer set would be a second thing to rotate. What stops that key from being turned against
 * customers' funds is the contract, not this function — a claim only works for a tenant with no
 * controller yet, and the claimed wallet cannot withdraw for a day, during which the owner can void
 * it.
 */
export async function signControllerAssignment(
  signer: SponsorshipSigner,
  params: ControllerAssignmentParams,
): Promise<ControllerAssignment> {
  const signature = await signer.signDigest(controllerAssignmentDigest(params));
  return {...params, signature, signer: signer.address};
}
