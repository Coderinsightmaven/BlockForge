import type { ApiErrorCode, ValidationErrorDetails } from "@blockforge/contracts";

/**
 * Codes used on the wire. `ENROLLMENT_TOKEN_INVALID` is documented in agent-protocol.md for the
 * agent enrollment endpoint but is not (yet) part of the contracts' `ApiErrorCode` enum.
 */
export type WireErrorCode = ApiErrorCode | "ENROLLMENT_TOKEN_INVALID";

/** An error with a stable API code. Anything else that reaches the error handler becomes 500 INTERNAL. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: WireErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Details for a `VALIDATION_FAILED` error (contracts `ValidationErrorDetails`); `path` "" = whole request. */
export const validationDetails = (message: string, path = ""): ValidationErrorDetails => ({ issues: [{ path, message }] });

export const badRequest = (message: string, details: ValidationErrorDetails = validationDetails(message)) =>
  new AppError(400, "VALIDATION_FAILED", message, details);
export const unauthenticated = (message = "Authentication required") => new AppError(401, "UNAUTHENTICATED", message);
export const mfaRequired = () => new AppError(401, "MFA_REQUIRED", "Multi-factor verification required");
export const forbidden = (message = "You do not have permission to perform this action") =>
  new AppError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, "CONFLICT", message, details);
export const preconditionFailed = (message: string, details?: unknown) =>
  new AppError(412, "PRECONDITION_FAILED", message, details);
export const invalidState = (message: string, details?: unknown) => new AppError(409, "INVALID_STATE", message, details);
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError(
    429,
    "RATE_LIMITED",
    "Too many requests, try again later",
    { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) },
    { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  );
export const nodeUnavailable = (message = "Node is not connected") => new AppError(503, "NODE_UNAVAILABLE", message);
export const upstreamError = (message: string, details?: unknown) => new AppError(502, "UPSTREAM_ERROR", message, details);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
