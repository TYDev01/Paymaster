import {BadRequestException, type PipeTransform} from "@nestjs/common";
import type {ZodType} from "zod";

/**
 * Validates a request body against a zod schema, or rejects it with 400.
 *
 * zod rather than class-validator: the fields here are hex strings and 256-bit quantities, which
 * need refinement and transformation (string -> bigint) rather than the presence-and-type checks
 * class-validator is built around. It also avoids depending on decorator metadata, which the test
 * pipeline cannot emit.
 *
 * The error detail returned is zod's, which names the offending path but never echoes a value.
 * That matters here: request bodies contain signatures, and validation errors get logged.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      error: "VALIDATION_FAILED",
      message: "request body failed validation",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
}
