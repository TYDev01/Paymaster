import {Body, Controller, Inject, Ip, Post, UseGuards} from "@nestjs/common";

import type {Principal} from "../../auth/authenticator.js";
import {ApiKeyGuard, CurrentPrincipal, RequirePermissions} from "../guards/apiKey.guard.js";
import {sponsorRequestSchema, type SponsorRequest} from "../dto/sponsorRequest.js";
import type {SponsorResponse} from "../dto/sponsorResponse.js";
import {ZodValidationPipe} from "../pipes/zodValidation.pipe.js";
import type {SponsorService} from "./sponsor.service.js";

export const SPONSOR_SERVICE = Symbol("SPONSOR_SERVICE");

/**
 * The public sponsorship endpoint.
 *
 * Thin by design: authenticate, validate, identify, delegate. Every decision lives in
 * SponsorService, which knows nothing about HTTP.
 */
@Controller("paymaster")
@UseGuards(ApiKeyGuard)
export class SponsorController {
  constructor(@Inject(SPONSOR_SERVICE) private readonly service: SponsorService) {}

  @Post("sponsor")
  @RequirePermissions("sponsor:create")
  // Scoped to the body, not @UsePipes at method level: a method-level pipe is applied to EVERY
  // parameter, including custom param decorators, and would try to validate the Principal and the
  // IP against this schema.
  async sponsor(
    @Body(new ZodValidationPipe(sponsorRequestSchema)) request: SponsorRequest,
    @CurrentPrincipal() principal: Principal,
    @Ip() clientIp: string,
  ): Promise<SponsorResponse> {
    /**
     * The key's policy wins over the body's.
     *
     * A caller must not be able to name a policy their key was not issued for — otherwise
     * `policyId` in the request body is a privilege escalation: point at a more permissive
     * policy and the quotas and allowlists that key was scoped to simply do not apply. The body's
     * policyId is only honoured for keys that pin no policy of their own.
     */
    const scoped: SponsorRequest = {
      ...request,
      ...(principal.policyId !== undefined ? {policyId: principal.policyId} : {}),
    };

    return this.service.sponsor(scoped, {clientIp, apiKeyId: principal.apiKeyId});
  }
}
