import { pino, stdSerializers, type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Paths redacted from every log line. Request/response logging only records method/url/status, but
 * anything that accidentally logs a header bag or a credential-bearing object is caught here.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-blockforge-csrf']",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
  "password",
  "*.password",
  "currentPassword",
  "newPassword",
  "*.currentPassword",
  "*.newPassword",
  "secret",
  "*.secret",
  "token",
  "*.token",
  "secretToken",
  "*.secretToken",
  "setupToken",
  "*.setupToken",
  "csrfToken",
  "*.csrfToken",
  "url",
  "*.webhookUrl",
  "privateKey",
  "*.privateKey",
];

/**
 * Error serializer that never logs SQL parameters: drizzle's `DrizzleQueryError` embeds the bound
 * values (password hashes, ciphertexts, tokens…) in its message, so only the statement text and the
 * driver error are kept.
 */
export function safeErrSerializer(err: unknown): unknown {
  if (err instanceof Error && "query" in err && "params" in err) {
    const cause = (err as { cause?: unknown }).cause;
    return {
      type: "DrizzleQueryError",
      message: "database query failed",
      query: String((err as { query: unknown }).query).slice(0, 2000),
      ...(cause instanceof Error ? { cause: stdSerializers.err(cause) } : {}),
      // The stack starts with the (multi-line, parameter-bearing) message; keep only the frames.
      stack: err.stack
        ?.split("\n")
        .filter((l) => /^\s+at /.test(l))
        .join("\n"),
    };
  }
  return err instanceof Error ? stdSerializers.err(err) : err;
}

export function createLogger(level: string, options: Partial<LoggerOptions> = {}, destination?: DestinationStream): Logger {
  const opts: LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: { service: "control-plane" },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: safeErrSerializer, error: safeErrSerializer },
    ...options,
  };
  return destination ? pino(opts, destination) : pino(opts);
}
