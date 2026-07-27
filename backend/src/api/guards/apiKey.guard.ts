import {
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import {Reflector} from "@nestjs/core";
import type {FastifyRequest} from "fastify";

import {isWellFormedApiKey} from "../../auth/apiKey.js";
import {extractApiKey, type ApiKeyAuthenticator, type Principal} from "../../auth/authenticator.js";
import type {JwtService} from "../../auth/jwt.js";
import {permissionsFor, type Permission} from "../../auth/permissions.js";
import type {IpThrottle} from "../../security/ipThrottle.js";

export const API_KEY_AUTHENTICATOR = Symbol("API_KEY_AUTHENTICATOR");
/** Optional JWT verifier. Present only when ADMIN_JWT_SECRET is configured. */
export const JWT_VERIFIER = Symbol("JWT_VERIFIER");
/** Optional IP throttle. Present only when pre-auth throttling is configured; fed auth failures. */
export const SECURITY_IP_THROTTLE = Symbol("SECURITY_IP_THROTTLE");

const PERMISSIONS_KEY = "required_permissions";

/**
 * Declares what a handler needs. Checks are on permissions, never roles — see permissions.ts.
 *
 * A handler with no decorator requires no permission, which is the dangerous default: it is why
 * the guard is applied per-controller rather than globally with opt-out. Forgetting to opt in
 * leaves an endpoint unprotected; forgetting to opt out only breaks it loudly.
 */
export const RequirePermissions = (...permissions: readonly Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Injects the authenticated caller into a handler parameter. */
export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  const principal = request.principal;
  if (principal === undefined) {
    // Only reachable if a handler asks for a principal without the guard in front of it.
    throw new Error("CurrentPrincipal used on a route without ApiKeyGuard");
  }
  return principal;
});

export interface AuthenticatedRequest extends FastifyRequest {
  principal?: Principal;
}

/**
 * Authenticates the API key and enforces the handler's required permissions.
 *
 * Failure responses are deliberately uniform: 401 for any authentication failure, with no
 * indication of which. Distinguishing "unknown key" from "revoked key" from "expired key" tells an
 * attacker whether a credential they hold was ever valid, which is exactly what someone testing a
 * leaked key wants to know. The specific reason goes to the observer, for alerting.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_AUTHENTICATOR) private readonly authenticator: ApiKeyAuthenticator,
    // Explicitly injected: with emitDecoratorMetadata off, Nest cannot infer even its own
    // Reflector from the type annotation alone.
    @Inject(Reflector) private readonly reflector: Reflector,
    // Optional: only present when JWT auth is configured. When absent, only API keys authenticate.
    @Optional() @Inject(JWT_VERIFIER) private readonly jwt: JwtService | null = null,
    // Optional: only present when pre-auth throttling is configured. Auth failures feed abuse
    // detection so a credential-stuffing run from one IP is blocked after a threshold.
    @Optional() @Inject(SECURITY_IP_THROTTLE) private readonly ipThrottle: IpThrottle | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const principal = await this.#resolvePrincipal(request);
    if (principal === undefined) {
      // Record the failure for abuse detection BEFORE responding. Best-effort: a throttle-store
      // blip must not convert an auth failure into a 500.
      await this.ipThrottle?.recordAuthFailure(request.ip, Math.floor(Date.now() / 1000)).catch(() => undefined);
      throw new UnauthorizedException({error: "UNAUTHORIZED", message: "invalid or missing credentials"});
    }

    const required =
      this.reflector.getAllAndOverride<readonly Permission[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const missing = required.filter((permission) => !principal.permissions.has(permission));
    if (missing.length > 0) {
      // 403, not 401: the caller IS authenticated and retrying with the same credential will not
      // help. Naming the missing permission is safe and saves an integrator a support ticket — it
      // describes their own credential, not the policy set.
      throw new ForbiddenException({
        error: "FORBIDDEN",
        message: `missing required permission: ${missing.join(", ")}`,
      });
    }

    request.principal = principal;
    return true;
  }

  /**
   * Resolves a caller from either a session JWT or an API key.
   *
   * The two are disambiguated by shape, not by trying both: an API key has a fixed `pm_(live|test)_`
   * form, so a presented credential that is NOT a well-formed key is treated as a JWT (when JWT auth
   * is configured). This avoids sending a session token through the key store, and sending a key
   * through the JWT verifier — each credential reaches exactly its own path. Either way an invalid
   * credential resolves to `undefined`, which the caller turns into a uniform 401.
   */
  async #resolvePrincipal(request: AuthenticatedRequest): Promise<Principal | undefined> {
    const presented = extractApiKey(request.headers);
    const now = Math.floor(Date.now() / 1000);

    if (presented !== undefined && this.jwt !== null && !isWellFormedApiKey(presented)) {
      const verified = this.jwt.verify(presented, now);
      if (!verified.ok) return undefined;
      return {
        apiKeyId: verified.claims.sub,
        name: verified.claims.name,
        roles: verified.claims.roles,
        permissions: permissionsFor(verified.claims.roles),
        policyId: verified.claims.policyId,
      };
    }

    const result = await this.authenticator.authenticate(presented, now);
    return result.ok ? result.principal : undefined;
  }
}
