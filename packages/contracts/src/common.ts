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

/** Cursor pagination request/response. Cursors are opaque strings. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };

/** Header the SPA must send on every state-changing request. */
export const CSRF_HEADER = "x-blockforge-csrf";
export const REQUEST_ID_HEADER = "x-request-id";
/** Optional on job-creating POST/DELETE routes; a replay within 24 h returns the original response. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const SESSION_COOKIE = "bf_session";
export const CSRF_COOKIE = "bf_csrf";
