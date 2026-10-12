import type { ValidationErrorDetails } from "@blockforge/contracts";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError, validationDetails, type WireErrorCode } from "../lib/errors.js";

export interface ErrorBody {
  error: { code: WireErrorCode; message: string; requestId: string; details?: unknown };
}

export function errorBody(req: FastifyRequest, code: WireErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, requestId: String(req.id), ...(details === undefined ? {} : { details }) } };
}

export function zodDetails(err: ZodError): ValidationErrorDetails {
  return { issues: err.issues.slice(0, 50).map((i) => ({ path: i.path.map(String).join("."), message: i.message })) };
}

function isFastifyError(err: unknown): err is FastifyError {
  return typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string";
}

/** SQLSTATE of a Postgres error, possibly wrapped by drizzle (`DrizzleQueryError.cause`). */
export function pgErrorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    const severity = (e as { severity?: unknown }).severity;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string") return code;
  }
  return null;
}

/** Maps every error to the contracts' `ApiError` body; unknown errors become an opaque 500. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      if (err.statusCode >= 500) req.log.warn({ code: err.code, msg: err.message }, "request failed");
      return reply.status(err.statusCode).send(errorBody(req, err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      return reply.status(400).send(errorBody(req, "VALIDATION_FAILED", "Request validation failed", zodDetails(err)));
    }
    if (isFastifyError(err) && typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      if (err.statusCode === 429) return reply.status(429).send(errorBody(req, "RATE_LIMITED", "Too many requests, try again later"));
      // Body parse errors, payload too large, unsupported media type…
      return reply.status(err.statusCode).send(errorBody(req, "VALIDATION_FAILED", err.message, validationDetails(err.message)));
    }
    const sqlState = pgErrorCode(err);
    // Races that slip past explicit checks (unique / foreign-key violations) are conflicts, not crashes.
    if (sqlState === "23505") return reply.status(409).send(errorBody(req, "CONFLICT", "A resource with these values already exists"));
    if (sqlState === "23503") return reply.status(409).send(errorBody(req, "CONFLICT", "The resource is referenced by or references another resource"));
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send(errorBody(req, "INTERNAL", "Internal server error"));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(errorBody(req, "NOT_FOUND", `Route ${req.method} ${req.url.split("?")[0]} not found`));
  });
}
