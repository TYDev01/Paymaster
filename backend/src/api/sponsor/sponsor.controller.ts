import {Body, Controller, Inject, Ip, Post, UsePipes} from "@nestjs/common";

import {sponsorRequestSchema, type SponsorRequest} from "../dto/sponsorRequest.js";
import type {SponsorResponse} from "../dto/sponsorResponse.js";
import {ZodValidationPipe} from "../pipes/zodValidation.pipe.js";
import type {SponsorService} from "./sponsor.service.js";

export const SPONSOR_SERVICE = Symbol("SPONSOR_SERVICE");

/**
 * The public sponsorship endpoint.
 *
 * Thin by design: validate, identify the caller, delegate, return. Every decision lives in
 * SponsorService, which knows nothing about HTTP.
 */
@Controller("paymaster")
export class SponsorController {
  constructor(@Inject(SPONSOR_SERVICE) private readonly service: SponsorService) {}

  @Post("sponsor")
  @UsePipes(new ZodValidationPipe(sponsorRequestSchema))
  async sponsor(@Body() request: SponsorRequest, @Ip() clientIp: string): Promise<SponsorResponse> {
    // apiKeyId will come from the auth guard once API keys land; until then per-key quotas simply
    // have no subject and, per their default, deny rather than silently not apply.
    return this.service.sponsor(request, {clientIp});
  }
}
