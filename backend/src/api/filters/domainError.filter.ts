import {Catch, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter} from "@nestjs/common";
import {HttpException} from "@nestjs/common";
import type {FastifyReply} from "fastify";

import {ChainDisabledError, UnknownChainError} from "../../chain/chainRegistry.js";
import {UnknownPolicyError} from "../../policy/policySource.js";
import {InvalidSponsorshipRequestError} from "../../signature/signatureEngine.js";
import {InvalidRuleConfigError} from "../../policy/policyFactory.js";
import {PolicyNotFoundError} from "../../db/postgresPolicyRepository.js";
import {AdminUnavailableError, PolicyInUseError} from "../admin/admin.service.js";
import {SponsorshipDeniedError} from "../sponsor/sponsor.service.js";

/**
 * Maps domain errors to HTTP without leaking how the policy set is shaped.
 *
 * The rule on disclosure: return the stable denial CODE, never the reason string. The code
 * ("TARGET_NOT_ALLOWED") tells a legitimate integrator what to fix and tells an attacker nothing
 * they could not learn by observing allow-versus-deny anyway. The reason carries internals — rule
 * names, quota counts, thresholds — and goes to the log, not the response.
 *
 * The domain layer throws plain errors and knows nothing about status codes; that mapping lives
 * here so the same services can sit behind a queue consumer without dragging HTTP semantics along.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  readonly #logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const {status, body, logLevel} = this.#map(exception);

    if (logLevel === "error") {
      this.#logger.error(
        `${body.error}: ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      // Denials are expected traffic, not incidents. Logged at warn with the full reason, which
      // is the only place the reason appears.
      this.#logger.warn(`${body.error}: ${exception instanceof Error ? exception.message : String(exception)}`);
    }

    void reply.status(status).send(body);
  }

  #map(exception: unknown): {status: number; body: ErrorBody; logLevel: "warn" | "error"} {
    if (exception instanceof SponsorshipDeniedError) {
      const quota = exception.denial.code === "QUOTA_EXCEEDED" || exception.denial.code === "SPEND_CAP_EXCEEDED";
      return {
        // 429 for quota so clients back off; 403 for a policy that will never allow this request.
        status: quota ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.FORBIDDEN,
        body: {error: "SPONSORSHIP_DENIED", code: exception.denial.code},
        logLevel: "warn",
      };
    }

    if (exception instanceof UnknownChainError || exception instanceof UnknownPolicyError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {error: "NOT_CONFIGURED", message: exception.message},
        logLevel: "warn",
      };
    }

    if (exception instanceof ChainDisabledError) {
      // 503, not 400: the request is well-formed and may succeed later.
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: {error: "CHAIN_DISABLED", message: exception.message},
        logLevel: "warn",
      };
    }

    if (exception instanceof InvalidSponsorshipRequestError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {error: "INVALID_REQUEST", message: exception.message},
        logLevel: "warn",
      };
    }

    if (exception instanceof PolicyNotFoundError) {
      return {status: HttpStatus.NOT_FOUND, body: {error: "NOT_FOUND", message: exception.message}, logLevel: "warn"};
    }

    /**
     * A bad rule config is the operator's typo, not our failure. Reporting it as 500 would page
     * someone for a malformed request — and the message names the policy and rule, which is what
     * makes the mistake fixable. This is safe to disclose: admin routes require policy:write, so
     * the caller already knows the policy set.
     */
    if (exception instanceof InvalidRuleConfigError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {error: "INVALID_POLICY_CONFIG", message: exception.message},
        logLevel: "warn",
      };
    }

    // 409: the request is well-formed and the operator may resolve the conflict by unpinning keys.
    if (exception instanceof PolicyInUseError) {
      return {status: HttpStatus.CONFLICT, body: {error: "POLICY_IN_USE", message: exception.message}, logLevel: "warn"};
    }

    if (exception instanceof AdminUnavailableError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: {error: "ADMIN_UNAVAILABLE", message: exception.message},
        logLevel: "warn",
      };
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      return {
        status: exception.getStatus(),
        body: typeof response === "string" ? {error: "ERROR", message: response} : (response as ErrorBody),
        logLevel: exception.getStatus() >= 500 ? "error" : "warn",
      };
    }

    // Unknown failure: log everything, return nothing. An unexpected error's message can contain
    // anything, including secrets pulled into an exception from a config or a signer.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {error: "INTERNAL_ERROR", message: "an unexpected error occurred"},
      logLevel: "error",
    };
  }
}

interface ErrorBody {
  readonly error: string;
  readonly code?: string;
  readonly message?: string;
  readonly issues?: readonly {path: string; message: string}[];
}
