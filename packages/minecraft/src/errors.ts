export type CatalogErrorCode =
  /** Upstream returned a non-2xx status or the request failed. */
  | "UPSTREAM_ERROR"
  /** Upstream answered but the payload did not match the expected shape. */
  | "INVALID_UPSTREAM_RESPONSE"
  /** The requested version or build does not exist upstream. */
  | "NOT_FOUND"
  /** The version exists but has no server artifact (e.g. pre-1.2.5 vanilla). */
  | "UNAVAILABLE"
  /** The software cannot be provisioned automatically (e.g. Spigot: no redistributable binary). */
  | "UNSUPPORTED"
  /** Caller supplied an invalid argument (version string, build id, URL). */
  | "INVALID_ARGUMENT"
  /** Upstream rate limit hit (HTTP 429); `retryAfterMs` says when to retry. */
  | "RATE_LIMITED";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  readonly status: number | undefined;
  readonly url: string | undefined;
  /** Back-off hint for `RATE_LIMITED` (milliseconds), otherwise undefined. */
  readonly retryAfterMs: number | undefined;

  constructor(code: CatalogErrorCode, message: string, opts: { status?: number; url?: string; cause?: unknown; retryAfterMs?: number } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CatalogError";
    this.code = code;
    this.status = opts.status;
    this.url = opts.url;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
