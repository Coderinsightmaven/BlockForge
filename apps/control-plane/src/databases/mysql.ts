import type { DatabaseHostTestResult, DatabaseTlsMode } from "@blockforge/contracts";
import mysql, { type Connection, type ConnectionOptions } from "mysql2/promise";
import type { Logger } from "pino";
import { REDACTED } from "@blockforge/contracts";

/** What the control plane needs to reach a database host as its admin user. */
export interface HostConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  tlsMode: DatabaseTlsMode;
  tlsCaCertificate: string | null;
}

/**
 * A failure talking to a database host, with a short message that never contains SQL text, statement
 * fragments, passwords or other credentials (mysql2 errors carry the full statement in `err.sql`, and
 * MySQL's own messages may quote parts of it — neither is ever copied here).
 */
export class DatabaseHostError extends Error {
  constructor(
    /** Driver / MySQL error code (`ER_ACCESS_DENIED_ERROR`, `ECONNREFUSED`, …) or null. */
    readonly code: string | null,
    message: string,
    /** True when the connection itself failed (nothing was executed). */
    readonly connectFailed: boolean,
  ) {
    super(message);
    this.name = "DatabaseHostError";
  }
}

/** Fixed, credential-free descriptions of the errors a host commonly answers with. */
const KNOWN: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  ETIMEDOUT: "connection timed out",
  ECONNRESET: "connection reset by the database host",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  ENOTFOUND: "host name not found",
  EAI_AGAIN: "host name lookup failed",
  PROTOCOL_CONNECTION_LOST: "connection lost",
  PROTOCOL_SEQUENCE_TIMEOUT: "the database host did not answer in time",
  HANDSHAKE_NO_SSL_SUPPORT: "the database host does not support TLS",
  MYSQL_CLEAR_PASSWORD_NOT_ENABLED: "the database host asked for cleartext password authentication, which BlockForge refuses",
  ER_ACCESS_DENIED_ERROR: "access denied for the admin user (check the username and password)",
  ER_HOST_NOT_PRIVILEGED: "the admin user may not connect from the control plane's address",
  ER_DBACCESS_DENIED_ERROR: "the admin user lacks a required privilege",
  ER_SPECIFIC_ACCESS_DENIED_ERROR: "the admin user lacks a required privilege (CREATE USER / GRANT OPTION)",
  ER_TABLEACCESS_DENIED_ERROR: "the admin user lacks a required privilege",
  ER_PASSWORD_NO_MATCH: "the admin user lacks a required privilege",
  ER_DB_CREATE_EXISTS: "a database with this name already exists on the host",
  ER_CANNOT_USER: "the database user could not be created or changed (it may already exist on the host)",
  ER_NOT_VALID_PASSWORD: "the generated password was rejected by the host's password policy",
  ER_NONEXISTING_GRANT: "the database user does not exist on the host",
  ER_CON_COUNT_ERROR: "the database host has too many connections",
  ER_TOO_MANY_USER_CONNECTIONS: "the admin user has too many connections",
  ER_HOST_IS_BLOCKED: "the control plane is blocked by the database host (too many connection errors)",
  ER_OPTION_PREVENTS_STATEMENT: "the database host is read-only",
  ER_PASSWORD_EXPIRE: "the admin user's password has expired",
  ER_MUST_CHANGE_PASSWORD_LOGIN: "the admin user's password has expired",
};

/** Replaces every occurrence of the given secrets (defence in depth for free-text messages). */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join(REDACTED);
  return out;
}

/** Maps any error from mysql2 / the socket / TLS to a {@link DatabaseHostError} (never the raw message for SQL errors). */
export function describeMysqlError(err: unknown, secrets: readonly string[], connectFailed: boolean): DatabaseHostError {
  if (err instanceof DatabaseHostError) return err;
  const e = (err ?? {}) as { code?: unknown; errno?: unknown; sqlState?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code.slice(0, 64) : null;
  if (code && KNOWN[code]) return new DatabaseHostError(code, KNOWN[code], connectFailed);
  if (code === "HANDSHAKE_SSL_ERROR" || (typeof e.message === "string" && /certificate|SSL|TLS/i.test(e.message) && typeof e.sqlState !== "string")) {
    // Node's TLS errors ("self-signed certificate in certificate chain") contain no secrets.
    const detail = typeof e.message === "string" ? scrub(e.message, secrets).slice(0, 200) : "handshake failed";
    return new DatabaseHostError(code ?? "HANDSHAKE_SSL_ERROR", `TLS error: ${detail}`, connectFailed);
  }
  if (typeof e.sqlState === "string") {
    // MySQL error text may quote the statement (incl. IDENTIFIED BY '…'): only the code is reported.
    return new DatabaseHostError(code, `MySQL error ${code ?? "unknown"} (SQLSTATE ${e.sqlState.slice(0, 5)})`, connectFailed);
  }
  return new DatabaseHostError(code, code ? `database host error (${code})` : "database host error", connectFailed);
}

/** `COM_QUIT` with a 2 s bound; a host that does not answer gets the socket destroyed. */
async function closeQuietly(conn: Connection): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const ended = await Promise.race([
    conn.end().then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 2000);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (!ended) conn.destroy();
}

export interface ConnectorOptions {
  logger: Logger;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
}

/** Runs one SQL statement on an open admin connection. */
export type Run = (sql: string) => Promise<unknown[]>;

/**
 * Short-lived admin connections to database hosts (one per operation, closed afterwards; nothing is
 * pooled, so a host update/delete needs no pool invalidation). Open connections are tracked so the app
 * can destroy them on shutdown. The driver never reads local files (no LOCAL INFILE), never sends a
 * cleartext password, and runs single statements only.
 */
export class MysqlConnector {
  private readonly open = new Set<Connection>();
  private closed = false;
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;

  constructor(private readonly opts: ConnectorOptions) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.queryTimeoutMs = opts.queryTimeoutMs ?? 15_000;
  }

  private options(cfg: HostConnection, tls: boolean): ConnectionOptions {
    const base: ConnectionOptions = {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      connectTimeout: this.connectTimeoutMs,
      multipleStatements: false,
      enableCleartextPlugin: false,
      flags: ["-LOCAL_FILES"],
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    };
    if (!tls) return base;
    // With a pinned CA the chain must verify against it (MySQL VERIFY_CA; mysql2 skips the host name check
    // unless `verifyIdentity`); without one the session is encrypted but the certificate is not verified.
    return {
      ...base,
      ssl: cfg.tlsCaCertificate ? { ca: cfg.tlsCaCertificate, rejectUnauthorized: true } : { rejectUnauthorized: false },
    };
  }

  private async connect(cfg: HostConnection): Promise<Connection> {
    if (this.closed) throw new DatabaseHostError(null, "the control plane is shutting down", true);
    const secrets = [cfg.password];
    const attempt = async (tls: boolean): Promise<Connection> => {
      const conn = await mysql.createConnection(this.options(cfg, tls));
      // A connection-level error (e.g. the host closing the socket) must not become an unhandled event.
      conn.on("error", () => undefined);
      return conn;
    };
    let conn: Connection;
    try {
      conn = await attempt(cfg.tlsMode !== "disabled");
    } catch (err) {
      const mapped = describeMysqlError(err, secrets, true);
      if (cfg.tlsMode !== "preferred" || mapped.code !== "HANDSHAKE_NO_SSL_SUPPORT") throw mapped;
      try {
        conn = await attempt(false);
      } catch (err2) {
        throw describeMysqlError(err2, secrets, true);
      }
    }
    if (this.closed) {
      conn.destroy();
      throw new DatabaseHostError(null, "the control plane is shutting down", true);
    }
    this.open.add(conn);
    return conn;
  }

  /**
   * Opens an admin connection, runs `fn` with a statement runner and closes the connection. Connection and
   * statement errors are {@link DatabaseHostError}s whose messages have `secrets` (and the admin password)
   * scrubbed.
   */
  async withConnection<T>(cfg: HostConnection, fn: (run: Run) => Promise<T>, secrets: readonly string[] = []): Promise<T> {
    const all = [cfg.password, ...secrets];
    const conn = await this.connect(cfg);
    const run: Run = async (sql) => {
      try {
        const [rows] = await conn.query({ sql, timeout: this.queryTimeoutMs });
        return Array.isArray(rows) ? (rows as unknown[]) : [];
      } catch (err) {
        throw describeMysqlError(err, all, false);
      }
    };
    try {
      // Only `run` touches the driver (its errors are already mapped); anything else `fn` throws is ours.
      return await fn(run);
    } finally {
      this.open.delete(conn);
      await closeQuietly(conn);
    }
  }

  /** "Test connection": connect, read the version and whether the session is encrypted. */
  async test(cfg: HostConnection): Promise<DatabaseHostTestResult> {
    const started = Date.now();
    try {
      return await this.withConnection(cfg, async (run) => {
        const [version] = (await run("SELECT VERSION() AS version")) as { version?: unknown }[];
        const [cipher] = (await run("SHOW SESSION STATUS LIKE 'Ssl_cipher'")) as { Value?: unknown }[];
        return {
          ok: true,
          error: null,
          serverVersion: typeof version?.version === "string" ? version.version.slice(0, 120) : null,
          tls: typeof cipher?.Value === "string" ? cipher.Value.length > 0 : null,
          latencyMs: Date.now() - started,
        };
      });
    } catch (err) {
      const e = describeMysqlError(err, [cfg.password], false);
      this.opts.logger.debug({ code: e.code, reason: e.message, host: cfg.host, port: cfg.port }, "database host test failed");
      return { ok: false, error: e.message, serverVersion: null, tls: null, latencyMs: null };
    }
  }

  /** Destroys every open connection and refuses new ones (app shutdown). */
  closeAll(): void {
    this.closed = true;
    for (const c of this.open) c.destroy();
    this.open.clear();
  }
}
