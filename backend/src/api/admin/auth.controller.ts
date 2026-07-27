import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";

import type {Principal} from "../../auth/authenticator.js";
import type {JwtService} from "../../auth/jwt.js";
import {ApiKeyGuard, CurrentPrincipal, JWT_VERIFIER} from "../guards/apiKey.guard.js";

/**
 * Exchanges a long-lived API key for a short-lived operator session token — td.md's "JWT admin auth".
 *
 * Guarded by the same `ApiKeyGuard`, so the caller must present a valid API key to mint a session.
 * The token carries the caller's OWN roles and pinned policy and nothing more, so it is never an
 * escalation: a session can do exactly what the key that minted it could. Its value is lifetime — the
 * key stops travelling on every admin request, and a stolen session expires on its own.
 */
@Controller("admin/auth")
@UseGuards(ApiKeyGuard)
export class AuthController {
  constructor(@Optional() @Inject(JWT_VERIFIER) private readonly jwt: JwtService | null = null) {}

  @Post("token")
  @HttpCode(HttpStatus.OK)
  issueToken(@CurrentPrincipal() principal: Principal): TokenResponse {
    if (this.jwt === null) {
      // The guard authenticated the key, but there is nothing to sign with. 503, not 500: this is a
      // deployment that has not enabled JWT auth, not an error in the request.
      throw new ServiceUnavailableException({
        error: "JWT_DISABLED",
        message: "session tokens are not enabled; set ADMIN_JWT_SECRET to use /admin/auth/token",
      });
    }

    const {token, expiresAt} = this.jwt.sign({
      sub: principal.apiKeyId,
      name: principal.name,
      roles: principal.roles,
      policyId: principal.policyId,
    });

    return {
      tokenType: "Bearer",
      token,
      expiresAt,
      expiresAtIso: new Date(expiresAt * 1000).toISOString(),
    };
  }
}

interface TokenResponse {
  readonly tokenType: "Bearer";
  readonly token: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly expiresAtIso: string;
}
