import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {z} from "zod";

import type {Membership} from "../../db/tenantRepository.js";
import type {SessionResult, TenantSessionService} from "../../auth/tenantSession.js";
import {ZodValidationPipe} from "../pipes/zodValidation.pipe.js";

export const TENANT_SESSION_SERVICE = Symbol("TENANT_SESSION_SERVICE");

const sessionSchema = z.object({
  /** The identity provider's token, from the browser. */
  token: z.string().min(1),
  /** Which tenant to act within. Optional when the caller belongs to exactly one. */
  tenantId: z.string().min(1).max(64).optional(),
});

const signUpSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(120),
});

/**
 * The dashboard's front door: a person's identity in, a tenant-scoped session out.
 *
 * Deliberately NOT behind `ApiKeyGuard` — this is where someone who has no API key gets one of
 * their own. The credential presented here is the identity provider's token, verified against the
 * provider's published keys, and it authenticates a person rather than authorising anything: what
 * they may do comes from `tenant_members` on our side.
 *
 * Every failure returns the same 401 with the same body. The reasons are distinguishable
 * internally — expired token, not a member, ambiguous tenant — and telling the caller which would
 * let someone enumerate tenants they do not belong to by watching the error change.
 */
@Controller("auth")
export class TenantAuthController {
  constructor(
    @Optional() @Inject(TENANT_SESSION_SERVICE) private readonly sessions: TenantSessionService | null = null,
  ) {}

  /**
   * Which tenants this person belongs to.
   *
   * Called before `session` when the dashboard needs to offer a choice. Returns only the caller's
   * own memberships, so it discloses nothing they could not already see.
   */
  @Post("tenants")
  @HttpCode(HttpStatus.OK)
  async listTenants(@Body(new ZodValidationPipe(z.object({token: z.string().min(1)}))) body: {token: string}) {
    const service = this.#service();
    const result = await service.membershipsFor(body.token);
    if (result === undefined) throw unauthorized();

    return {
      subject: result.subject,
      tenants: result.memberships.map(toView),
    };
  }

  @Post("session")
  @HttpCode(HttpStatus.OK)
  async session(@Body(new ZodValidationPipe(sessionSchema)) body: {token: string; tenantId?: string}) {
    const result = await this.#service().issue(body.token, body.tenantId);
    return this.#respond(result);
  }

  /**
   * Creates a tenant with the caller as its owner.
   *
   * Returns 503 rather than 401 when self-service signup is disabled: the caller's credentials may
   * be perfectly good, and the honest answer is that this deployment does not offer signup.
   */
  @Post("signup")
  @HttpCode(HttpStatus.CREATED)
  async signUp(@Body(new ZodValidationPipe(signUpSchema)) body: {token: string; name: string}) {
    const result = await this.#service().signUp(body.token, body.name);
    if (!result.ok && result.reason === "signup-disabled") {
      throw new ServiceUnavailableException({
        error: "SIGNUP_DISABLED",
        message: "self-service signup is not enabled on this deployment",
      });
    }
    return this.#respond(result);
  }

  #respond(result: SessionResult) {
    if (!result.ok) throw unauthorized();

    return {
      tokenType: "Bearer" as const,
      token: result.token,
      expiresAt: result.expiresAt,
      expiresAtIso: new Date(result.expiresAt * 1000).toISOString(),
      subject: result.subject,
      tenant: toView(result.membership),
    };
  }

  #service(): TenantSessionService {
    if (this.sessions === null) {
      // Not an error in the request: this deployment has no identity provider configured, which is
      // the single-tenant operator setup. 503 says so without implying the caller did anything wrong.
      throw new ServiceUnavailableException({
        error: "IDENTITY_DISABLED",
        message: "dashboard sign-in is not enabled; set PRIVY_APP_ID and ADMIN_JWT_SECRET",
      });
    }
    return this.sessions;
  }
}

function toView(membership: Membership) {
  return {
    id: membership.tenant.id,
    name: membership.tenant.name,
    status: membership.tenant.status,
    role: membership.role,
  };
}

/** One shape for every failure, so the response cannot be used to probe. */
function unauthorized(): UnauthorizedException {
  return new UnauthorizedException({error: "UNAUTHORIZED", message: "invalid or missing credentials"});
}
