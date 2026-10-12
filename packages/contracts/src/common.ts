import { z } from "zod";

/** UUID v4 string used for every entity id. */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** Human-readable identifier: lowercase, digits, hyphens; 3–48 chars; no leading/trailing hyphen. */
export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/, "Use 3–48 lowercase letters, digits or hyphens");
export type Slug = z.infer<typeof Slug>;

/** Display name for user-facing entities. */
export const DisplayName = z.string().trim().min(1).max(80);

/** Unix epoch milliseconds. */
export const EpochMs = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof EpochMs>;

export const Bytes = z.number().int().nonnegative();
export const Port = z.number().int().min(1).max(65535);

/** Lowercase hex digests. */
export const Sha1Hex = z.string().regex(/^[a-f0-9]{40}$/, "lowercase hex SHA-1");
export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "lowercase hex SHA-256");
export const Sha512Hex = z.string().regex(/^[a-f0-9]{128}$/, "lowercase hex SHA-512");

/** True when an array has no duplicate (primitive) values. */
export const isUniqueArray = (values: readonly unknown[]): boolean => new Set(values).size === values.length;

/** Consistent error body for every non-2xx REST response. */
export const ApiErrorCode = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "MFA_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "RATE_LIMITED",
  "CSRF_INVALID",
  "SETUP_REQUIRED",
  "SETUP_ALREADY_COMPLETED",
  "ENROLLMENT_TOKEN_INVALID",
  /** File manager: path matches the template's fileDenylist (non-administrators). */
  "PATH_DENIED",
  /** File manager: the file was served redacted and cannot be saved back. */
  "REDACTED_CONTENT",
  "NODE_UNAVAILABLE",
  "CAPACITY_EXCEEDED",
  "INVALID_STATE",
  "UPSTREAM_ERROR",
  "INTERNAL",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/**
 * `details` of a `RATE_LIMITED` (HTTP 429) error; the response also carries a `Retry-After` header (whole
 * seconds, rounded up). `upstream` is set when an external service (Modrinth, Mojang) is rate-limiting the
 * control plane, rather than the control plane limiting the caller. `retryAfterSeconds` is the older field
 * of the per-key/login limiter, kept for compatibility (= ceil(retryAfterMs / 1000)).
 */
export const RateLimitedErrorDetails = z.object({
  retryAfterMs: z.number().int().positive(),
  retryAfterSeconds: z.number().int().positive().optional(),
  upstream: z.enum(["modrinth", "mojang"]).optional(),
});
export type RateLimitedErrorDetails = z.infer<typeof RateLimitedErrorDetails>;

/** `details` of a `VALIDATION_FAILED` error. `path` is dot-joined (e.g. "gameplay.maxPlayers"); "" = whole body. */
export const ValidationErrorDetails = z.object({
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type ValidationErrorDetails = z.infer<typeof ValidationErrorDetails>;

/** Cursor pagination request/response. Cursors are opaque strings. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * Header the SPA must send on every state-changing request once a session exists. The value is the
 * session-bound CSRF token, available as `Me.csrfToken` (also in `LoginResponse.me`) and mirrored in
 * the JS-readable `bf_csrf` cookie (SameSite=Strict); the server compares it with the token hash
 * stored on the session, not merely with the cookie. Pre-session routes (`/auth/login`, `/auth/setup`)
 * are exempt; they instead require `Content-Type: application/json` and an `Origin` matching PUBLIC_URL.
 */
export const CSRF_HEADER = "x-blockforge-csrf";
export const REQUEST_ID_HEADER = "x-request-id";
/** Optional on job-creating POST/DELETE routes; a replay within 24 h returns the original response. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const SESSION_COOKIE = "bf_session";
export const CSRF_COOKIE = "bf_csrf";
