import { AppError, validationDetails } from "../lib/errors.js";
import type { ValidationErrorDetails } from "@blockforge/contracts";
import { AgentCommandError } from "./gateway.js";

/** Maps command dispatch failures to API errors (secret-free messages only). */
export function commandErrorToHttp(err: unknown): unknown {
  if (!(err instanceof AgentCommandError)) return err;
  if (err.code === "NODE_UNAVAILABLE" || err.code === "NOT_FOUND") {
    return new AppError(503, "NODE_UNAVAILABLE", err.message, { code: err.code, retryable: err.retryable });
  }
  if (err.code === "TIMEOUT") return new AppError(504, "UPSTREAM_ERROR", err.message, { code: err.code, retryable: true });
  if (err.code === "VALIDATION_FAILED") {
    return new AppError(400, "VALIDATION_FAILED", err.message, (err.details as ValidationErrorDetails | undefined) ?? validationDetails(err.message));
  }
  return new AppError(502, "UPSTREAM_ERROR", `Agent error: ${err.message}`, { code: err.code, retryable: err.retryable });
}
