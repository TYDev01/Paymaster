import {describe, expect, it} from "vitest";
import {recoverAddress, zeroAddress, type Address, type Hex} from "viem";

import {
  AdminService,
  ControllerAlreadyAssignedError,
  FundingNotApplicableError,
  type ActorContext,
} from "../src/api/admin/admin.service.js";
import type {ApiKeyStore} from "../src/auth/apiKeyStore.js";
import {permissionsFor} from "../src/auth/permissions.js";
import type {ChainRegistry} from "../src/chain/chainRegistry.js";
import {forTenant, tenantId} from "../src/db/scope.js";
import type {PolicySource} from "../src/policy/policySource.js";
import {controllerAssignmentDigest} from "../src/signature/controllerAssignment.js";
import {onChainTenantKey} from "../src/signature/paymasterLayout.js";
import {LocalSponsorshipSigner} from "../src/signature/signer.js";

const ACME = tenantId("t_acme");
const PAYMASTER = "0x9999999999999999999999999999999999999999" as Address;
const CUSTOMER = "0x2222222222222222222222222222222222222222" as Address;
const signer = new LocalSponsorshipSigner("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

function service(options: {kind?: "tenant" | "verifying"; controller?: Address; nonce?: bigint} = {}) {
  const asked: Hex[] = [];
  const chains = {
    get: (chainId: number) => ({
      config: {chainId, paymaster: PAYMASTER, paymasterKind: options.kind ?? "tenant"},
      getTenantController: async (tenant: Hex) => {
        asked.push(tenant);
        return {controller: options.controller ?? zeroAddress, nonce: options.nonce ?? 4n, activeAt: 0};
      },
    }),
  } as unknown as ChainRegistry;

  return {
    asked,
    admin: new AdminService({
      policies: undefined,
      policySource: {} as PolicySource,
      apiKeys: {} as ApiKeyStore,
      sponsorships: undefined,
      audit: undefined,
      chains,
      signer,
    }),
  };
}

const context: ActorContext = {
  actor: "did:privy:alice",
  clientIp: undefined,
  scope: forTenant(ACME),
  writeScope: forTenant(ACME),
  permissions: permissionsFor(["tenant_admin"]),
};

describe("controller attestation", () => {
  it("signs an assignment the platform signer can be recovered from, for the caller's own tenant", async () => {
    const {admin, asked} = service();
    const assignment = await admin.issueControllerAssignment(
      {chainId: 11155111, controller: CUSTOMER},
      context,
      1_800_000_000,
    );

    expect(asked).toEqual([onChainTenantKey(ACME)]);
    expect(assignment).toMatchObject({
      tenantKey: onChainTenantKey(ACME),
      controller: CUSTOMER,
      nonce: "4",
      deadline: 1_800_000_900,
    });

    const digest = controllerAssignmentDigest({
      chainId: 11155111,
      paymaster: PAYMASTER,
      tenant: assignment.tenantKey,
      controller: CUSTOMER,
      nonce: 4n,
      deadline: assignment.deadline,
    });
    expect(await recoverAddress({hash: digest, signature: assignment.signature})).toBe(signer.address);
  });

  it("refuses a balance that already has a controller — the signer must never replace one", async () => {
    const {admin} = service({controller: CUSTOMER});
    await expect(admin.issueControllerAssignment({chainId: 11155111, controller: CUSTOMER}, context)).rejects.toThrow(
      ControllerAlreadyAssignedError,
    );
  });

  it("refuses a chain with no per-tenant balances", async () => {
    const {admin} = service({kind: "verifying"});
    await expect(admin.issueControllerAssignment({chainId: 11155111, controller: CUSTOMER}, context)).rejects.toThrow(
      FundingNotApplicableError,
    );
  });

  it("gives a read-only member no way to ask for one", () => {
    expect(permissionsFor(["viewer"]).has("funding:write")).toBe(false);
    expect(permissionsFor(["tenant_admin"]).has("funding:write")).toBe(true);
  });
});
