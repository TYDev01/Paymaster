import {Logger} from "@nestjs/common";
import type {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";

import type {IpThrottle} from "./ipThrottle.js";
import type {RequestSignatureVerifier} from "./requestSignature.js";

/**
 * Registers the edge security layer as Fastify hooks — the part that must run BEFORE authentication.
 *
 * Fastify hooks run ahead of the Nest route handler (and therefore ahead of `ApiKeyGuard`), which is
 * exactly the property the per-IP quota lacked: these protect the auth path itself.
 *
 *   * `onRequest` (no body needed): IP throttle + abuse block. A flood or a blocked IP is rejected
 *     here, before a single line of auth code runs.
 *   * `preValidation` (body parsed, `rawBody` captured by Nest's `rawBody: true`): HMAC signature
 *     verification over the exact bytes received.
 *
 * Both are no-ops unless their dependency is provided, so a deployment turns each on independently.
 * Health and metrics are always exempt — a throttled `/health` would make a load balancer evict a
 * healthy pod, and a scraper must never be rate-limited off the metrics it exists to collect.
 */
export interface SecurityHooks {
  readonly ipThrottle?: IpThrottle | undefined;
  readonly signatureVerifier?: RequestSignatureVerifier | undefined;
  readonly now?: () => number;
}

const EXEMPT_PREFIXES = ["/health", "/metrics"];

export function registerSecurity(fastify: FastifyInstance, hooks: SecurityHooks): void {
  const logger = new Logger("security");
  const now = hooks.now ?? (() => Math.floor(Date.now() / 1000));

  if (hooks.ipThrottle !== undefined) {
    const throttle = hooks.ipThrottle;
    fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      if (isExempt(request.url)) return;
      const decision = await throttle.check(clientIp(request), now());
      if (!decision.allowed) {
        // Awaiting the send inside the hook halts the lifecycle: the request never reaches auth.
        await reply
          .code(decision.reason === "blocked" ? 403 : 429)
          .header("retry-after", String(decision.retryAfterSeconds))
          .send({
            error: decision.reason === "blocked" ? "FORBIDDEN" : "TOO_MANY_REQUESTS",
            message: `request ${decision.reason}`,
          });
      }
    });
  }

  if (hooks.signatureVerifier !== undefined) {
    const verifier = hooks.signatureVerifier;
    fastify.addHook("preValidation", async (request: FastifyRequest, reply: FastifyReply) => {
      if (isExempt(request.url) || !methodHasBody(request.method)) return;

      const signature = headerValue(request, "x-signature");
      const timestamp = headerValue(request, "x-timestamp");
      // `rawBody` is populated by NestFactory's `rawBody: true`; absent means an empty body.
      const rawBody = (request as {rawBody?: Buffer | string}).rawBody;
      const body = rawBody === undefined ? "" : rawBody.toString();

      const result = verifier.verify({method: request.method, path: request.url, timestamp, body, signature}, now());
      if (!result.ok) {
        // Uniform 401 to the caller; the specific reason goes only to the log, so a prober cannot
        // learn whether it was the timestamp, the signature, or a missing header that failed.
        logger.warn(
          `request signature rejected (${result.reason}) from ${clientIp(request)} ${request.method} ${request.url}`,
        );
        await reply.code(401).send({error: "UNAUTHORIZED", message: "invalid request signature"});
      }
    });
  }
}

function isExempt(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function methodHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

function headerValue(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === "string" ? value : "";
}

function clientIp(request: FastifyRequest): string {
  return request.ip;
}
