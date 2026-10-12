import { ValidationErrorDetails } from "@blockforge/contracts";
import type { ApiErrorCode } from "@blockforge/contracts";

/** Codes produced by the client itself (no server response, or an unusable one). */
export type ClientErrorCode = "NETWORK_ERROR" | "INVALID_RESPONSE";
export type ErrorCode = ApiErrorCode | ClientErrorCode;

/** Codes that mean "the session cannot make this request; send the user somewhere else". */
export const AUTH_REDIRECT_CODES: readonly ErrorCode[] = [
  "UNAUTHENTICATED",
  "MFA_REQUIRED",
  "SETUP_REQUIRED",
];

/** Typed error for every failed API call. `message` is safe to show to the user. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: ErrorCode;
  /** HTTP status; 0 when the request never reached the server. */
  readonly status: number;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(init: {
    code: ErrorCode;
    message: string;
    status: number;
    requestId?: string | null;
    details?: unknown;
  }) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.details = init.details;
  }

  get isAuthRedirect(): boolean {
    return AUTH_REDIRECT_CODES.includes(this.code);
  }

  /** Worth retrying automatically (transient server/network failure, never 4xx). */
  get isRetryable(): boolean {
    return this.code === "NETWORK_ERROR" || this.status >= 500 || this.code === "RATE_LIMITED";
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Fallback code when a non-2xx response carries no parseable `ApiError` body. */
export function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "VALIDATION_FAILED";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 412:
      return "PRECONDITION_FAILED";
    case 429:
      return "RATE_LIMITED";
    case 502:
    case 503:
    case 504:
      return "UPSTREAM_ERROR";
    default:
      return "INTERNAL";
  }
}

/** Short, user-facing description of an error for toasts and inline alerts. */
export function describeError(err: unknown): { title: string; detail: string | null } {
  if (isApiError(err)) {
    const parts = [`Code ${err.code}`];
    if (err.requestId) parts.push(`request ${err.requestId}`);
    return { title: err.message, detail: parts.join(" · ") };
  }
  if (err instanceof Error) return { title: err.message, detail: null };
  return { title: "Something went wrong", detail: null };
}

/**
 * Field-level messages from a `VALIDATION_FAILED` error (`ValidationErrorDetails`), keyed by the
 * top-level field of the dot-joined path ("gameplay.maxPlayers" → "gameplay"; "" → "form").
 */
export function fieldErrorsFrom(err: unknown): Record<string, string> {
  if (!isApiError(err) || err.code !== "VALIDATION_FAILED") return {};
  const parsed = ValidationErrorDetails.safeParse(err.details);
  if (!parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.data.issues) {
    const key = issue.path.split(".")[0] || "form";
    out[key] ??= issue.message;
  }
  return out;
}
