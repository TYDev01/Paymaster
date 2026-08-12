import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import type {Principal} from "../../auth/authenticator.js";
import {ApiKeyGuard, CurrentPrincipal, RequirePermissions} from "../guards/apiKey.guard.js";
import {ZodValidationPipe} from "../pipes/zodValidation.pipe.js";
import {
  createKeySchema,
  listAuditSchema,
  listSponsorshipsSchema,
  upsertPolicySchema,
  type CreateKeyRequest,
  type UpsertPolicyRequest,
} from "./admin.dto.js";
import type {ActorContext, AdminService} from "./admin.service.js";
import {forTenant, PLATFORM_SCOPE} from "../../db/scope.js";

export const ADMIN_SERVICE = Symbol("ADMIN_SERVICE");

/**
 * td.md's admin dashboard API.
 *
 * Every route names the permission it needs. The guard is applied at the controller, but a route
 * without @RequirePermissions would still authenticate and then allow — so the decorator is the
 * actual authorisation, and its absence on a route here would be the bug.
 */
@Controller("admin")
@UseGuards(ApiKeyGuard)
export class AdminController {
  constructor(@Inject(ADMIN_SERVICE) private readonly service: AdminService) {}

  // ------------------------------------------------------------------------------------------
  // policies
  // ------------------------------------------------------------------------------------------

  @Get("policies")
  @RequirePermissions("policy:read")
  async listPolicies(@CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    return {policies: await this.service.listPolicies(actorContext(principal, clientIp))};
  }

  @Get("policies/:id")
  @RequirePermissions("policy:read")
  async getPolicy(@Param("id") id: string, @CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    return this.service.getPolicy(id, actorContext(principal, clientIp));
  }

  @Post("policies")
  @RequirePermissions("policy:write")
  async upsertPolicy(
    @Body(new ZodValidationPipe(upsertPolicySchema)) request: UpsertPolicyRequest,
    @CurrentPrincipal() principal: Principal,
    @Ip() clientIp: string,
  ) {
    return this.service.upsertPolicy(request, actorContext(principal, clientIp));
  }

  @Delete("policies/:id")
  @RequirePermissions("policy:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePolicy(@Param("id") id: string, @CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    const deleted = await this.service.deletePolicy(id, actorContext(principal, clientIp));
    if (!deleted) throw new NotFoundException({error: "NOT_FOUND", message: `no policy with id ${id}`});
  }

  /** Hot reload on demand. Also runs on a timer; this is the "apply it now" button. */
  @Post("policies/reload")
  @RequirePermissions("policy:write")
  @HttpCode(HttpStatus.OK)
  async reload(@CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    return this.service.reloadPolicies(actorContext(principal, clientIp));
  }

  // ------------------------------------------------------------------------------------------
  // api keys
  // ------------------------------------------------------------------------------------------

  @Get("keys")
  @RequirePermissions("key:read")
  async listKeys(@CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    // Contains no secrets: they are not stored and cannot be recovered.
    return {keys: await this.service.listKeys(actorContext(principal, clientIp))};
  }

  /** The only response in the system that ever contains a key secret. */
  @Post("keys")
  @RequirePermissions("key:write")
  async createKey(
    @Body(new ZodValidationPipe(createKeySchema)) request: CreateKeyRequest,
    @CurrentPrincipal() principal: Principal,
    @Ip() clientIp: string,
  ) {
    const created = await this.service.createKey(request, actorContext(principal, clientIp));
    return {
      ...created,
      warning: "The secret is shown once and is not recoverable. Store it now.",
    };
  }

  @Delete("keys/:id")
  @RequirePermissions("key:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeKey(@Param("id") id: string, @CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    const revoked = await this.service.revokeKey(id, actorContext(principal, clientIp));
    if (!revoked) {
      throw new NotFoundException({error: "NOT_FOUND", message: `no active key with id ${id}`});
    }
  }

  // ------------------------------------------------------------------------------------------
  // funding
  // ------------------------------------------------------------------------------------------

  /**
   * Where to send money, and what this tenant has.
   *
   * Gated on `key:read` rather than a new permission: it is account self-service, the same
   * authority as seeing your own keys, and it reveals nothing about anyone else. A tenant key is
   * derived from a tenant id, so it is not a secret — but it IS the only way to fund correctly,
   * which is why it needs an endpoint at all.
   */
  @Get("funding")
  @RequirePermissions("key:read")
  async listFunding(@CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    return {funding: await this.service.listFunding(actorContext(principal, clientIp))};
  }

  // ------------------------------------------------------------------------------------------
  // reporting
  // ------------------------------------------------------------------------------------------

  @Get("sponsorships")
  @RequirePermissions("metrics:read")
  async listSponsorships(
    @Query(new ZodValidationPipe(listSponsorshipsSchema)) query: Record<string, never>,
    @CurrentPrincipal() principal: Principal,
    @Ip() clientIp: string,
  ) {
    const rows = await this.service.listSponsorships(query, actorContext(principal, clientIp));
    return {
      // Named to resist the obvious misreading. These are commitments, not spend: most never land
      // on-chain, so summing them overstates cost.
      note: "Attestations issued (worst-case commitments). Not actual spend; many never execute.",
      sponsorships: rows.map((row) => ({
        ...row,
        id: row.id.toString(),
        nonce: row.nonce.toString(),
        maxCostWei: row.maxCostWei.toString(),
      })),
    };
  }

  @Get("audit")
  @RequirePermissions("metrics:read")
  async listAudit(
    @Query(new ZodValidationPipe(listAuditSchema)) query: Record<string, never>,
    @CurrentPrincipal() principal: Principal,
    @Ip() clientIp: string,
  ) {
    const entries = await this.service.listAudit(query, actorContext(principal, clientIp));
    return {entries: entries.map((entry) => ({...entry, id: entry.id.toString()}))};
  }
}

/**
 * The scope for an administrative request, derived from the authenticated principal.
 *
 * Built from the PRINCIPAL and nothing else — never from a header, a query parameter or a body
 * field. A caller-supplied tenant would let any authenticated key read and write inside any account
 * simply by naming it, which is the single most likely way a boundary like this gets broken.
 */
function actorContext(principal: Principal, clientIp: string | undefined): ActorContext {
  const own = forTenant(principal.tenantId);
  return {
    actor: principal.apiKeyId,
    clientIp,
    // Reads widen to every tenant only for a holder of `platform:read` — the operator console.
    // A tenant-scoped session can never hold it, because a role cannot be granted by someone who
    // does not have it (see AdminService.createKey).
    scope: principal.permissions.has("platform:read") ? PLATFORM_SCOPE : own,
    // Writes never widen. A platform operator editing a customer's policy from their own console
    // is a much larger grant than seeing it, and support does not need it.
    writeScope: own,
    permissions: principal.permissions,
  };
}
