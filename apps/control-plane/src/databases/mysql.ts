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
 * How a host operation failed:
 * - `connect`: no session was established — nothing was executed.
 * - `rejected`: the host answered the statement with an error — it did not take effect.
 * - `interrupted`: no answer (client timeout, connection lost, cancelled). The statement may or may not have
 *   taken effect; `stopped` says whether it was confirmed no longer running (`KILL QUERY` + process list), i.e.
 *   whether it can still take effect later. Callers decide the outcome by inspecting the host.
 */
export type HostFailureKind = "connect" | "rejected" | "interrupted";

/**
 * A failure talking to a database host, with a short message that never contains SQL text, statement
 * fragments, passwords or other credentials (mysql2 errors carry the full statement in `err.sql`, and
 * MySQL's own messages may quote parts of it — neither is ever copied here).
 */
export class DatabaseHostError extends Error {
  readonly kind: HostFailureKind;
  readonly stopped: boolean;
  constructor(
    /** Driver / MySQL error code (`ER_ACCESS_DENIED_ERROR`, `ECONNREFUSED`, …) or null. */
    readonly code: string | null,
    message: string,
    kind: HostFailureKind | boolean,
    stopped = true,
  ) {
    super(message);
    this.name = "DatabaseHostError";
    this.kind = typeof kind === "boolean" ? (kind ? "connect" : "rejected") : kind;
    this.stopped = this.kind === "interrupted" ? stopped : true;
  }

  /** True when nothing was executed (the session could not be established). */
  get connectFailed(): boolean {
    return this.kind === "connect";
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
  ABORTED: "the operation was cancelled or ran out of time",
  CONNECTION_UNUSABLE: "the connection was abandoned after an earlier statement did not answer",
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
  ER_LOCK_WAIT_TIMEOUT: "the database host was busy (lock wait timed out); nothing was changed",
  ER_STATEMENT_TIMEOUT: "the database host was busy (statement time limit reached); nothing was changed",
  ER_QUERY_TIMEOUT: "the database host was busy (statement time limit reached); nothing was changed",
  ER_QUERY_INTERRUPTED: "the statement was interrupted on the database host; nothing was changed",
};

/** MariaDB codes mysql2 has no name for. */
const ERRNO_NAMES: Record<number, string> = { 1969: "ER_STATEMENT_TIMEOUT" };

/**
 * Replaces every occurrence of the given secrets (defence in depth for free-text messages). Every non-empty
 * secret is scrubbed, however short: a 1–3 character admin password may garble an error message, which is
 * preferable to leaking it (the admin password is the host's own and its length is not ours to dictate).
 * All matches of all secrets are located in the original text first and overlapping ranges merged, so
 * overlapping or nested secrets never leave a remainder.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  const ranges: [number, number][] = [];
  for (const s of secrets) {
    if (!s) continue;
    for (let i = text.indexOf(s); i !== -1; i = text.indexOf(s, i + 1)) ranges.push([i, i + s.length]);
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  let cur = ranges[0]!;
  for (const r of ranges.slice(1)) {
    if (r[0] <= cur[1]) cur = [cur[0], Math.max(cur[1], r[1])];
    else {
      out += text.slice(pos, cur[0]) + REDACTED;
      pos = cur[1];
      cur = r;
    }
  }
  return out + text.slice(pos, cur[0]) + REDACTED + text.slice(cur[1]);
}

/** Maps any error from mysql2 / the socket / TLS to a {@link DatabaseHostError} (never the raw message for SQL errors). */
export function describeMysqlError(err: unknown, secrets: readonly string[], kind: HostFailureKind | boolean, stopped = true): DatabaseHostError {
  if (err instanceof DatabaseHostError) return err;
  const e = (err ?? {}) as { code?: unknown; errno?: unknown; sqlState?: unknown; message?: unknown };
  const code =
    typeof e.code === "string" ? e.code.slice(0, 64) : typeof e.errno === "number" ? (ERRNO_NAMES[e.errno] ?? `ERRNO_${e.errno}`) : null;
  if (code && KNOWN[code]) return new DatabaseHostError(code, KNOWN[code], kind, stopped);
  if (code === "HANDSHAKE_SSL_ERROR" || (typeof e.message === "string" && /certificate|SSL|TLS/i.test(e.message) && typeof e.sqlState !== "string")) {
    // Node's TLS errors ("self-signed certificate in certificate chain") contain no secrets.
    const detail = typeof e.message === "string" ? scrub(e.message, secrets).slice(0, 200) : "handshake failed";
    return new DatabaseHostError(code ?? "HANDSHAKE_SSL_ERROR", `TLS error: ${detail}`, kind, stopped);
  }
  if (typeof e.sqlState === "string") {
    // MySQL error text may quote the statement (incl. IDENTIFIED BY '…'): only the code is reported.
    return new DatabaseHostError(code, `MySQL error ${code ?? "unknown"} (SQLSTATE ${e.sqlState.slice(0, 5)})`, kind, stopped);
  }
  return new DatabaseHostError(code, code ? `database host error (${code})` : "database host error", kind, stopped);
}

/** Destroys the socket too (mysql2's `destroy()` only half-closes it with `end()`). */
export function hardClose(conn: Connection): void {
  try {
    conn.destroy();
  } catch {
    /* already closed */
  }
  const stream = (conn as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream;
  try {
    stream?.destroy?.();
  } catch {
    /* already closed */
  }
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
  if (!ended) hardClose(conn);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** Rejects with an `ABORTED` error as soon as `signal` aborts (the promise itself keeps running). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface ConnectorOptions {
  logger: Logger;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
  /**
   * Ask the host to abort statements itself before the client gives up (`lock_wait_timeout`, plus
   * `max_statement_time` on MariaDB): a statement stuck on a lock or a backup lock then fails cleanly and can
   * never take effect later. Default true; tests turn it off to exercise the client-side path.
   */
  sessionLimits?: boolean;
}

/** Runs one SQL statement (optional `?` values for SELECTs) on an open admin connection. */
export type Run = (sql: string, values?: readonly unknown[]) => Promise<unknown[]>;

/** An open admin connection. After an `interrupted` failure every further `run` fails at once. */
export interface HostSession {
  run: Run;
  close(): Promise<void>;
}

/**
 * Short-lived admin connections to database hosts (one per operation, closed afterwards; nothing is
 * pooled, so a host update/delete needs no pool invalidation). Open connections are tracked so the app
 * can destroy them on shutdown. The driver never reads local files (no LOCAL INFILE), never sends a
 * cleartext password, and runs single statements only.
 *
 * Statement timeouts: mysql2's query timeout only reports an error — the statement keeps running on the host
 * and stays the connection's active command, so a later statement on that connection would queue behind it
 * forever. Every session therefore (1) asks the host to abort statements itself shortly before the client
 * timeout, and (2) on any failure without an answer (timeout, connection lost, cancellation) sends
 * `KILL QUERY` for the connection's thread from a fresh connection, confirms in the process list that the
 * statement is gone, kills the thread and destroys the socket; the session is unusable afterwards.
 */
export class MysqlConnector {
  private readonly open = new Set<Connection>();
  private closed = false;
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  /** Server-side statement/lock-wait limit, whole seconds, below the client timeout. */
  readonly sessionLimitS: number | null;
  /** Upper bound of the abort procedure (`KILL QUERY` + confirmation) after an unanswered statement. */
  readonly abortBudgetMs: number;

  constructor(private readonly opts: ConnectorOptions) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.queryTimeoutMs = opts.queryTimeoutMs ?? 15_000;
    this.sessionLimitS = opts.sessionLimits === false ? null : Math.max(1, Math.floor((this.queryTimeoutMs - 3000) / 1000));
    this.abortBudgetMs = this.connectTimeoutMs + 12_000;
  }

  /** Longest a session with `statements` statements can take (connect, statements, one abort, close). */
  maxSessionMs(statements: number): number {
    return this.connectTimeoutMs + (statements + 2) * this.queryTimeoutMs + this.abortBudgetMs + 2000;
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
    if (cfg.tlsMode === "verify_ca") {
      // The chain must verify against the pinned CA (MySQL VERIFY_CA; mysql2 skips the host name check unless
      // `verifyIdentity`). The contracts and a CHECK constraint guarantee the CA is present in this mode.
      if (!cfg.tlsCaCertificate) throw new DatabaseHostError(null, "verify_ca needs a CA certificate", "connect");
      return { ...base, ssl: { ca: cfg.tlsCaCertificate, rejectUnauthorized: true } };
    }
    // `preferred` / `required`: encrypted, deliberately NOT authenticated (documented in the contracts, the
    // API docs and the UI labels as "host not verified").
    return { ...base, ssl: { rejectUnauthorized: false } };
  }

  private async connect(cfg: HostConnection, signal?: AbortSignal): Promise<Connection> {
    if (this.closed) throw new DatabaseHostError(null, "the control plane is shutting down", "connect");
    const secrets = [cfg.password];
    const attempt = async (tls: boolean): Promise<Connection> => {
      const pending = mysql.createConnection(this.options(cfg, tls));
      try {
        const conn = await raceAbort(pending, signal);
        // A connection-level error (e.g. the host closing the socket) must not become an unhandled event.
        conn.on("error", () => undefined);
        return conn;
      } catch (err) {
        // Cancelled while connecting: close the connection whenever it completes.
        pending.then(hardClose, () => undefined);
        throw err;
      }
    };
    let conn: Connection;
    try {
      conn = await attempt(cfg.tlsMode !== "disabled");
    } catch (err) {
      const mapped = describeMysqlError(err, secrets, "connect");
      if (cfg.tlsMode !== "preferred" || mapped.code !== "HANDSHAKE_NO_SSL_SUPPORT") throw mapped;
      try {
        conn = await attempt(false);
      } catch (err2) {
        throw describeMysqlError(err2, secrets, "connect");
      }
    }
    if (this.closed) {
      hardClose(conn);
      throw new DatabaseHostError(null, "the control plane is shutting down", "connect");
    }
    this.open.add(conn);
    return conn;
  }

  /**
   * After an unanswered statement on `threadId`: `KILL QUERY` it from a fresh connection, confirm in the
   * process list that no statement runs on that thread any more, then kill the thread. True = confirmed
   * stopped (it can no longer take effect); false = could not be confirmed (it may still take effect).
   */
  private async stopStatement(cfg: HostConnection, threadId: number | null): Promise<boolean> {
    if (threadId === null || !Number.isSafeInteger(threadId) || threadId <= 0) return false;
    let c2: Connection | null = null;
    try {
      c2 = await this.connect(cfg);
      const q = (sql: string, values?: unknown[]) => c2!.query({ sql, ...(values ? { values } : {}), timeout: 5000 });
      try {
        await q(`KILL QUERY ${threadId}`);
      } catch (err) {
        // The thread is already gone: nothing can run on it.
        if ((err as { code?: string }).code !== "ER_NO_SUCH_THREAD") throw err;
        return true;
      }
      let stopped = false;
      for (const until = Date.now() + 5000; Date.now() < until; await sleep(150)) {
        const [rows] = await q("SELECT INFO AS info FROM information_schema.PROCESSLIST WHERE ID = ?", [threadId]);
        const row = (rows as { info?: unknown }[])[0];
        if (!row || row.info === null || row.info === undefined) {
          stopped = true;
          break;
        }
      }
      await q(`KILL ${threadId}`).catch(() => undefined);
      return stopped;
    } catch (err) {
      const e = describeMysqlError(err, [cfg.password], "connect");
      this.opts.logger.warn({ code: e.code, reason: e.message, host: cfg.host, port: cfg.port }, "could not stop an unanswered statement on the database host");
      return false;
    } finally {
      if (c2) {
        this.open.delete(c2);
        hardClose(c2);
      }
    }
  }

  /**
   * Opens an admin session. `signal` cancels the connect and any running statement (handled like a
   * timeout: the statement is stopped and the session becomes unusable). Errors are {@link DatabaseHostError}s
   * whose messages have `secrets` (and the admin password) scrubbed.
   */
  async session(cfg: HostConnection, secrets: readonly string[] = [], signal?: AbortSignal): Promise<HostSession> {
    const all = [cfg.password, ...secrets];
    const conn = await this.connect(cfg, signal);
    const threadId = typeof conn.threadId === "number" ? conn.threadId : null;
    let poisoned: DatabaseHostError | null = null;
    let closed = false;
    const run: Run = async (sql, values) => {
      if (poisoned) throw new DatabaseHostError("CONNECTION_UNUSABLE", KNOWN.CONNECTION_UNUSABLE!, "interrupted", true);
      const pending = conn.query({ sql, ...(values ? { values: [...values] } : {}), timeout: this.queryTimeoutMs });
      try {
        const [rows] = await raceAbort(pending, signal);
        return Array.isArray(rows) ? (rows as unknown[]) : [];
      } catch (err) {
        const answered = typeof (err as { sqlState?: unknown }).sqlState === "string";
        if (answered) throw describeMysqlError(err, all, "rejected");
        // No answer: stop the statement on the host, then abandon this connection for good.
        pending.catch(() => undefined);
        poisoned = new DatabaseHostError(null, "", "interrupted");
        const stopped = await this.stopStatement(cfg, threadId);
        this.open.delete(conn);
        hardClose(conn);
        throw describeMysqlError(err, all, "interrupted", stopped);
      }
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      this.open.delete(conn);
      if (poisoned) hardClose(conn);
      else await closeQuietly(conn);
    };
    if (this.sessionLimitS !== null) {
      try {
        await run(`SET SESSION lock_wait_timeout = ${this.sessionLimitS}`);
        try {
          await run(`SET SESSION max_statement_time = ${this.sessionLimitS}`);
        } catch (err) {
          // MySQL has no max_statement_time (its max_execution_time covers SELECTs only): lock_wait_timeout and
          // the client-side KILL QUERY cover it.
          if (!(err instanceof DatabaseHostError && err.kind === "rejected")) throw err;
        }
      } catch (err) {
        await close();
        throw err;
      }
    }
    return { run, close };
  }

  /** {@link session} around `fn`, closed afterwards. */
  async withConnection<T>(cfg: HostConnection, fn: (run: Run) => Promise<T>, secrets: readonly string[] = [], signal?: AbortSignal): Promise<T> {
    const s = await this.session(cfg, secrets, signal);
    try {
      // Only `run` touches the driver (its errors are already mapped); anything else `fn` throws is ours.
      return await fn(s.run);
    } finally {
      await s.close();
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
      const e = describeMysqlError(err, [cfg.password], "connect");
      this.opts.logger.debug({ code: e.code, reason: e.message, host: cfg.host, port: cfg.port }, "database host test failed");
      return { ok: false, error: e.message, serverVersion: null, tls: null, latencyMs: null };
    }
  }

  /** Destroys every open connection (sockets included) and refuses new ones (app shutdown). */
  closeAll(): void {
    this.closed = true;
    for (const c of this.open) hardClose(c);
    this.open.clear();
  }
}
