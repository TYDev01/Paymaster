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
import type {AdminService} from "./admin.service.js";

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
  async listPolicies() {
    return {policies: await this.service.listPolicies()};
  }

  @Get("policies/:id")
  @RequirePermissions("policy:read")
  async getPolicy(@Param("id") id: string) {
    return this.service.getPolicy(id);
  }

  @Post("policies")
  @RequirePermissions("policy:write")
  async upsertPolicy(
    @Body(new ZodValidationPipe(upsertPolicySchema)) request: UpsertPolicyRequest,
    @CurrentPrincipal() principal: Principal,
    @Ip() clientIp: string,
  ) {
    return this.service.upsertPolicy(request, {actor: principal.apiKeyId, clientIp});
  }

  @Delete("policies/:id")
  @RequirePermissions("policy:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePolicy(@Param("id") id: string, @CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    const deleted = await this.service.deletePolicy(id, {actor: principal.apiKeyId, clientIp});
    if (!deleted) throw new NotFoundException({error: "NOT_FOUND", message: `no policy with id ${id}`});
  }

  /** Hot reload on demand. Also runs on a timer; this is the "apply it now" button. */
  @Post("policies/reload")
  @RequirePermissions("policy:write")
  @HttpCode(HttpStatus.OK)
  async reload(@CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    return this.service.reloadPolicies({actor: principal.apiKeyId, clientIp});
  }

  // ------------------------------------------------------------------------------------------
  // api keys
  // ------------------------------------------------------------------------------------------

  @Get("keys")
  @RequirePermissions("key:read")
  async listKeys() {
    // Contains no secrets: they are not stored and cannot be recovered.
    return {keys: await this.service.listKeys()};
  }

  /** The only response in the system that ever contains a key secret. */
  @Post("keys")
  @RequirePermissions("key:write")
  async createKey(
    @Body(new ZodValidationPipe(createKeySchema)) request: CreateKeyRequest,
    @CurrentPrincipal() principal: Principal,
    @Ip() clientIp: string,
  ) {
    const created = await this.service.createKey(request, {actor: principal.apiKeyId, clientIp});
    return {
      ...created,
      warning: "The secret is shown once and is not recoverable. Store it now.",
    };
  }

  @Delete("keys/:id")
  @RequirePermissions("key:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeKey(@Param("id") id: string, @CurrentPrincipal() principal: Principal, @Ip() clientIp: string) {
    const revoked = await this.service.revokeKey(id, {actor: principal.apiKeyId, clientIp});
    if (!revoked) {
      throw new NotFoundException({error: "NOT_FOUND", message: `no active key with id ${id}`});
    }
  }

  // ------------------------------------------------------------------------------------------
  // reporting
  // ------------------------------------------------------------------------------------------

  @Get("sponsorships")
  @RequirePermissions("metrics:read")
  async listSponsorships(@Query(new ZodValidationPipe(listSponsorshipsSchema)) query: Record<string, never>) {
    const rows = await this.service.listSponsorships(query);
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
  async listAudit(@Query(new ZodValidationPipe(listAuditSchema)) query: Record<string, never>) {
    const entries = await this.service.listAudit(query);
    return {entries: entries.map((entry) => ({...entry, id: entry.id.toString()}))};
  }
}
