import {
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import {Reflector} from "@nestjs/core";
import type {FastifyRequest} from "fastify";

import {extractApiKey, type ApiKeyAuthenticator, type Principal} from "../../auth/authenticator.js";
import type {Permission} from "../../auth/permissions.js";

export const API_KEY_AUTHENTICATOR = Symbol("API_KEY_AUTHENTICATOR");

const PERMISSIONS_KEY = "required_permissions";

/**
 * Declares what a handler needs. Checks are on permissions, never roles — see permissions.ts.
 *
 * A handler with no decorator requires no permission, which is the dangerous default: it is why
 * the guard is applied per-controller rather than globally with opt-out. Forgetting to opt in
 * leaves an endpoint unprotected; forgetting to opt out only breaks it loudly.
 */
export const RequirePermissions = (...permissions: readonly Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const result = await this.authenticator.authenticate(
      extractApiKey(request.headers),
      Math.floor(Date.now() / 1000),
    );

    if (!result.ok) {
      throw new UnauthorizedException({error: "UNAUTHORIZED", message: "invalid or missing API key"});
    }

    const required =
      this.reflector.getAllAndOverride<readonly Permission[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const missing = required.filter((permission) => !result.principal.permissions.has(permission));
    if (missing.length > 0) {
      // 403, not 401: the caller IS authenticated and retrying with the same key will not help.
      // Naming the missing permission is safe and saves an integrator a support ticket — it
      // describes their own key, not the policy set.
      throw new ForbiddenException({
        error: "FORBIDDEN",
        message: `missing required permission: ${missing.join(", ")}`,
      });
    }

    request.principal = result.principal;
    return true;
  }
}
