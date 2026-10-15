import type { DatabaseHostTestResult, DatabaseTlsMode } from "@blockforge/contracts";
import { randomBytes } from "node:crypto";
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
  // What an aborted statement left behind depends on the statement (an interrupted DROP DATABASE may have
  // dropped some tables): callers decide and say so; these messages only describe the error.
  ER_LOCK_WAIT_TIMEOUT: "the database host was busy (lock wait timed out)",
  ER_STATEMENT_TIMEOUT: "the database host was busy (statement time limit reached)",
  ER_QUERY_TIMEOUT: "the database host was busy (statement time limit reached)",
  ER_QUERY_INTERRUPTED: "the statement was interrupted on the database host",
  SHUTDOWN: "the control plane is shutting down",
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
  /** Timeout of each statement of the abort procedure (default 5 s; tests stretch it). */
  abortStatementTimeoutMs?: number;
}

/** Runs one SQL statement (optional `?` values for SELECTs) on an open admin connection. */
export type Run = (sql: string, values?: readonly unknown[]) => Promise<unknown[]>;

/**
 * Which server a session reached: `CONNECTION_ID()` plus the server's identity. Behind a proxy or load
 * balancer the greeting's connection id is not the server thread (or sessions reach different servers), so
 * `KILL` by id could hit an unrelated connection: it is only ever sent when this identity proves a direct
 * connection to the same server.
 */
export interface ServerIdentity {
  connectionId: number;
  serverId: string;
  hostname: string;
  port: string;
  version: string;
  /**
   * A unique id of the server instance: `@@server_uuid` on MySQL, `@@server_uid` on MariaDB 10.5.26 / 10.6.19 /
   * 10.11.9 / 11.4.3 and later; null on older MariaDB (identity then rests on the per-statement nonce).
   */
  uid: string | null;
}

/** An open admin connection. After an `interrupted` failure every further `run` fails at once. */
export interface HostSession {
  run: Run;
  close(): Promise<void>;
  /** Thread id announced in the server greeting. */
  readonly handshakeId: number | null;
  /** null when the server identity could not be read (e.g. a proxy refusing the query): never KILLed. */
  readonly identity: ServerIdentity | null;
}

const sameServer = (a: ServerIdentity, b: ServerIdentity): boolean =>
  a.serverId === b.serverId && a.hostname === b.hostname && a.port === b.port && a.version === b.version && a.uid === b.uid;

/** A direct connection: the greeting's thread id is the server's `CONNECTION_ID()`. */
const direct = (handshakeId: number | null, identity: ServerIdentity): boolean => handshakeId !== null && handshakeId === identity.connectionId;

/** Prefix of every session statement: a per-statement nonce visible in `PROCESSLIST.INFO`. */
export const nonceComment = (nonce: string): string => `/* bf:${nonce} */ `;

/** What the process list says about the origin's thread (seen from the fresh connection). */
export interface ProcessRow {
  user: string;
  info: string | null;
}

/**
 * The KILL decision for an unanswered statement (pure; unit-tested):
 * - `kill`: the thread `connectionId` on the server the fresh connection reached runs *our* statement — the row
 *   belongs to the admin user and its `INFO` carries the statement's nonce — and both connections are direct ones
 *   to the same server;
 * - `stopped`: our statement is provably not running any more — the server is the same one (equal unique ids)
 *   and the thread is gone or runs something else;
 * - `unknown`: anything else (identity unreadable, a proxy, another server, a foreign thread): never KILL.
 */
export function abortPlan(input: {
  origin: { handshakeId: number | null; identity: ServerIdentity | null };
  fresh: { handshakeId: number | null; identity: ServerIdentity | null };
  row: ProcessRow | null;
  adminUser: string;
  nonce: string | null;
}): "kill" | "stopped" | "unknown" {
  const { origin, fresh, row, adminUser, nonce } = input;
  if (!origin.identity || !fresh.identity) return "unknown";
  if (!direct(origin.handshakeId, origin.identity) || !direct(fresh.handshakeId, fresh.identity) || !sameServer(origin.identity, fresh.identity)) return "unknown";
  const ours = row !== null && row.user === adminUser;
  if (ours && nonce !== null && row.info !== null && row.info.includes(`bf:${nonce}`)) return "kill";
  const strong = origin.identity.uid !== null && origin.identity.uid === fresh.identity.uid;
  if (!strong) return "unknown";
  if (row === null) return "stopped";
  if (!ours) return "unknown";
  return "stopped";
}

/** The privileges `GRANT … ON db.*` hands out must be held (with GRANT OPTION) by the admin account. */
const REQUIRED_GLOBAL_PRIVILEGES = [
  "CREATE USER",
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "REFERENCES",
  "INDEX",
  "LOCK TABLES",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "EXECUTE",
  "CREATE TEMPORARY TABLES",
  "CREATE VIEW",
  "SHOW VIEW",
  "EVENT",
  "TRIGGER",
] as const;

/** A name of the form BlockForge gives databases (`s<8 hex>_<name>`), to test database-level grants against. */
export const PRIVILEGE_PROBE_DATABASE = "s00000000_probe";

/** How long the process list is polled for the killed statement to disappear. */
const ABORT_CONFIRM_WINDOW_MS = 5000;

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
 * `KILL QUERY` for the connection's thread from a fresh connection — only when the process list there shows the
 * thread running *this* statement (admin user, the statement's nonce) and both connections are proven direct
 * connections to the same server ({@link abortPlan}) — confirms in the process list that the statement is gone,
 * kills the thread and destroys the socket; the session is unusable afterwards. Without that proof (a proxy in
 * front, an unreadable identity) nothing is killed and the outcome is unknown.
 */
export class MysqlConnector {
  private readonly open = new Set<Connection>();
  /** Fresh connections of abort procedures in progress (destroyed at once by {@link shutdown}). */
  private readonly aborting = new Set<Connection>();
  private closed = false;
  private readonly shutdownCtrl = new AbortController();
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly abortStatementTimeoutMs: number;
  /** Server-side statement/lock-wait limit, whole seconds, below the client timeout. */
  readonly sessionLimitS: number | null;
  /**
   * Upper bound of the abort procedure after an unanswered statement: connect, identity (≤ 2 statements), the
   * process-list check, `KILL QUERY`, the confirmation window plus one last poll, the final `KILL`.
   */
  readonly abortBudgetMs: number;

  constructor(private readonly opts: ConnectorOptions) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.queryTimeoutMs = opts.queryTimeoutMs ?? 15_000;
    this.abortStatementTimeoutMs = opts.abortStatementTimeoutMs ?? 5000;
    this.sessionLimitS = opts.sessionLimits === false ? null : Math.max(1, Math.floor((this.queryTimeoutMs - 3000) / 1000));
    const t = this.abortStatementTimeoutMs;
    this.abortBudgetMs = this.connectTimeoutMs + 2 * t + t + t + (ABORT_CONFIRM_WINDOW_MS + t) + t;
  }

  /** Statements every session runs before the caller's (identity ≤ 2, session limits ≤ 2). */
  static readonly SESSION_SETUP_STATEMENTS = 4;

  /** Longest a session with `statements` statements can take (connect, setup, statements, one abort, close). */
  maxSessionMs(statements: number): number {
    return this.connectTimeoutMs + (statements + MysqlConnector.SESSION_SETUP_STATEMENTS) * this.queryTimeoutMs + this.abortBudgetMs + 2000;
  }

  /** True once {@link shutdown} was called. */
  get shuttingDown(): boolean {
    return this.closed;
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

  private shutdownError(kind: HostFailureKind): DatabaseHostError {
    return new DatabaseHostError("SHUTDOWN", KNOWN.SHUTDOWN!, kind, false);
  }

  private async connect(cfg: HostConnection, signal?: AbortSignal): Promise<Connection> {
    if (this.closed) throw this.shutdownError("connect");
    const secrets = [cfg.password];
    const cancel = signal ? AbortSignal.any([signal, this.shutdownCtrl.signal]) : this.shutdownCtrl.signal;
    const attempt = async (tls: boolean): Promise<Connection> => {
      const pending = mysql.createConnection(this.options(cfg, tls));
      try {
        const conn = await raceAbort(pending, cancel);
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
      if (this.closed) throw this.shutdownError("connect");
      const mapped = describeMysqlError(err, secrets, "connect");
      if (cfg.tlsMode !== "preferred" || mapped.code !== "HANDSHAKE_NO_SSL_SUPPORT") throw mapped;
      try {
        conn = await attempt(false);
      } catch (err2) {
        if (this.closed) throw this.shutdownError("connect");
        throw describeMysqlError(err2, secrets, "connect");
      }
    }
    if (this.closed) {
      hardClose(conn);
      throw this.shutdownError("connect");
    }
    this.open.add(conn);
    return conn;
  }

  /**
   * Reads {@link ServerIdentity} with `query`: one statement plus one for the server's unique id
   * (`@@server_uuid` on MySQL, `@@server_uid` on MariaDB — refused on older MariaDB, then null).
   */
  private static async readIdentity(query: (sql: string) => Promise<unknown[]>): Promise<ServerIdentity> {
    const [row] = (await query("SELECT CONNECTION_ID() AS id, @@server_id AS sid, @@hostname AS hn, @@port AS port, VERSION() AS v")) as Record<string, unknown>[];
    const version = String(row?.v ?? "");
    let uid: string | null = null;
    try {
      const [u] = (await query(/mariadb/i.test(version) ? "SELECT @@server_uid AS u" : "SELECT @@server_uuid AS u")) as Record<string, unknown>[];
      uid = u?.u == null || u.u === "" ? null : String(u.u);
    } catch (err) {
      if (!(err instanceof DatabaseHostError ? err.kind === "rejected" : typeof (err as { sqlState?: unknown }).sqlState === "string")) throw err;
    }
    return { connectionId: Number(row?.id), serverId: String(row?.sid ?? ""), hostname: String(row?.hn ?? ""), port: String(row?.port ?? ""), version, uid };
  }

  /**
   * After an unanswered statement of `origin` (carrying `nonce`): from a fresh connection, decide with
   * {@link abortPlan}; on `kill`, `KILL QUERY` the origin's thread, confirm in the process list that the statement
   * is gone, then kill the thread. True = confirmed stopped (it can no longer take effect); false = not sent or not
   * confirmed (it may still take effect). Shutdown abandons it at once.
   */
  private async stopStatement(cfg: HostConnection, origin: { handshakeId: number | null; identity: ServerIdentity | null; nonce: string | null }): Promise<boolean> {
    const id = origin.identity?.connectionId;
    if (!origin.identity || id === undefined || !Number.isSafeInteger(id) || id <= 0) return false;
    if (!direct(origin.handshakeId, origin.identity)) {
      this.opts.logger.warn({ host: cfg.host, port: cfg.port }, "not stopping an unanswered statement: a proxy seems to sit in front of the database host");
      return false;
    }
    let c2: Connection | null = null;
    try {
      c2 = await this.connect(cfg);
      this.aborting.add(c2);
      const conn = c2;
      const q = async (sql: string, values?: unknown[]) => {
        const [rows] = await raceAbort(conn.query({ sql, ...(values ? { values } : {}), timeout: this.abortStatementTimeoutMs }), this.shutdownCtrl.signal);
        return Array.isArray(rows) ? (rows as unknown[]) : [];
      };
      const processRow = async (): Promise<ProcessRow | null> => {
        const [r] = (await q("SELECT USER AS u, INFO AS info FROM information_schema.PROCESSLIST WHERE ID = ?", [id])) as { u?: unknown; info?: unknown }[];
        return r ? { user: String(r.u ?? ""), info: r.info == null ? null : String(r.info) } : null;
      };
      let fresh: ServerIdentity | null = null;
      try {
        fresh = await MysqlConnector.readIdentity(q);
      } catch (err) {
        if (typeof (err as { sqlState?: unknown }).sqlState !== "string") throw err;
      }
      const handshake = typeof conn.threadId === "number" ? conn.threadId : null;
      const plan = abortPlan({ origin, fresh: { handshakeId: handshake, identity: fresh }, row: await processRow(), adminUser: cfg.user, nonce: origin.nonce });
      if (plan !== "kill") {
        if (plan === "unknown") this.opts.logger.warn({ host: cfg.host, port: cfg.port }, "not stopping an unanswered statement: its thread could not be proven to be ours on the same server");
        return plan === "stopped";
      }
      try {
        await q(`KILL QUERY ${id}`);
      } catch (err) {
        // The row was ours a moment ago on this server: the thread has ended meanwhile.
        if ((err as { code?: string }).code !== "ER_NO_SUCH_THREAD") throw err;
        return true;
      }
      let stopped = false;
      for (const until = Date.now() + ABORT_CONFIRM_WINDOW_MS; Date.now() < until && !this.closed; await sleep(150)) {
        const row = await processRow();
        if (!row || row.info === null || !row.info.includes(`bf:${origin.nonce}`)) {
          stopped = true;
          break;
        }
      }
      await q(`KILL ${id}`).catch(() => undefined);
      return stopped;
    } catch (err) {
      if (!this.closed) {
        const e = describeMysqlError(err, [cfg.password], "connect");
        this.opts.logger.warn({ code: e.code, reason: e.message, host: cfg.host, port: cfg.port }, "could not stop an unanswered statement on the database host");
      }
      return false;
    } finally {
      if (c2) {
        this.aborting.delete(c2);
        this.open.delete(c2);
        hardClose(c2);
      }
    }
  }

  /**
   * Opens an admin session. `signal` cancels the connect and any running statement (handled like a
   * timeout: the statement is stopped and the session becomes unusable). Errors are {@link DatabaseHostError}s
   * whose messages have `secrets` (and the admin password) scrubbed. After {@link shutdown} a running statement
   * is abandoned at once (code `SHUTDOWN`, not stopped: its outcome is unknown).
   */
  async session(cfg: HostConnection, secrets: readonly string[] = [], signal?: AbortSignal): Promise<HostSession> {
    const all = [cfg.password, ...secrets];
    const conn = await this.connect(cfg, signal);
    const cancel = signal ? AbortSignal.any([signal, this.shutdownCtrl.signal]) : this.shutdownCtrl.signal;
    const handshakeId = typeof conn.threadId === "number" ? conn.threadId : null;
    let identity: ServerIdentity | null = null;
    let poisoned = false;
    let closed = false;
    const run: Run = async (sql, values) => {
      if (poisoned) throw new DatabaseHostError("CONNECTION_UNUSABLE", KNOWN.CONNECTION_UNUSABLE!, "interrupted", true);
      // A per-statement nonce lets the abort procedure recognise this statement in the process list.
      const nonce = randomBytes(8).toString("hex");
      const pending = conn.query({ sql: nonceComment(nonce) + sql, ...(values ? { values: [...values] } : {}), timeout: this.queryTimeoutMs });
      try {
        const [rows] = await raceAbort(pending, cancel);
        return Array.isArray(rows) ? (rows as unknown[]) : [];
      } catch (err) {
        const answered = typeof (err as { sqlState?: unknown }).sqlState === "string";
        if (answered) throw describeMysqlError(err, all, "rejected");
        // No answer: stop the statement on the host, then abandon this connection for good.
        pending.catch(() => undefined);
        poisoned = true;
        const stopped = this.closed ? false : await this.stopStatement(cfg, { handshakeId, identity, nonce });
        this.open.delete(conn);
        hardClose(conn);
        if (this.closed) throw this.shutdownError("interrupted");
        throw describeMysqlError(err, all, "interrupted", stopped);
      }
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      this.open.delete(conn);
      // After shutdown started nobody waits for a polite COM_QUIT.
      if (poisoned || this.closed) hardClose(conn);
      else await closeQuietly(conn);
    };
    try {
      try {
        identity = await MysqlConnector.readIdentity(run);
      } catch (err) {
        // A refused identity query (e.g. a proxy): the session works, but its statements are never KILLed.
        if (!(err instanceof DatabaseHostError && err.kind === "rejected")) throw err;
        this.opts.logger.warn({ host: cfg.host, port: cfg.port, code: err.code }, "the database host refused the identity query; unanswered statements will not be stopped");
      }
      if (this.sessionLimitS !== null) {
        await run(`SET SESSION lock_wait_timeout = ${this.sessionLimitS}`);
        try {
          await run(`SET SESSION max_statement_time = ${this.sessionLimitS}`);
        } catch (err) {
          // MySQL has no max_statement_time (its max_execution_time covers SELECTs only): lock_wait_timeout and
          // the client-side KILL QUERY cover it.
          if (!(err instanceof DatabaseHostError && err.kind === "rejected")) throw err;
        }
      }
    } catch (err) {
      await close();
      throw err;
    }
    return { run, close, handshakeId, identity };
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

  /**
   * Privileges the account seems to lack: global ones (`USER_PRIVILEGES` of `CURRENT_USER()`) together with
   * database-level grants (`SCHEMA_PRIVILEGES`) whose pattern covers BlockForge's database names — tested with
   * the probe name {@link PRIVILEGE_PROBE_DATABASE} as a `LIKE` pattern match (the grant wildcard semantics), or
   * literally on MySQL with `partial_revokes = ON` — plus `SELECT on mysql.user`. `CREATE USER` must be global.
   */
  private static async missingPrivileges(run: Run): Promise<string[]> {
    const [cu] = (await run("SELECT CURRENT_USER() AS u")) as { u?: unknown }[];
    const current = String(cu?.u ?? "");
    const at = current.lastIndexOf("@");
    const grantee = `'${current.slice(0, at)}'@'${current.slice(at + 1)}'`;
    const global = (await run("SELECT PRIVILEGE_TYPE AS p, IS_GRANTABLE AS g FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?", [grantee])) as { p?: unknown; g?: unknown }[];
    const [partial] = (await run("SHOW GLOBAL VARIABLES LIKE 'partial_revokes'")) as { Value?: unknown }[];
    const literal = String(partial?.Value ?? "").toUpperCase() === "ON";
    const schema = (await run(
      `SELECT PRIVILEGE_TYPE AS p, IS_GRANTABLE AS g FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ? AND ${literal ? "TABLE_SCHEMA = ?" : "? LIKE TABLE_SCHEMA"}`,
      [grantee, PRIVILEGE_PROBE_DATABASE],
    )) as { p?: unknown; g?: unknown }[];
    const held = new Set(global.map((r) => String(r.p ?? "").toUpperCase()));
    const onDatabases = new Set(schema.map((r) => String(r.p ?? "").toUpperCase()));
    const missing: string[] = REQUIRED_GLOBAL_PRIVILEGES.filter((p) => !held.has(p) && (p === "CREATE USER" || !onDatabases.has(p)));
    if (![...global, ...schema].some((r) => String(r.g ?? "").toUpperCase() === "YES")) missing.push("GRANT OPTION");
    try {
      await run("SELECT 1 FROM mysql.user LIMIT 0");
    } catch (err) {
      if (!(err instanceof DatabaseHostError && err.kind === "rejected")) throw err;
      missing.push("SELECT on mysql.user");
    }
    return missing;
  }

  /**
   * "Test connection": connect, read the version, whether the session is encrypted and which needed
   * privileges seem missing; a second session tells whether a proxy sits in front of the server.
   */
  async test(cfg: HostConnection): Promise<DatabaseHostTestResult> {
    const started = Date.now();
    try {
      const first = await this.session(cfg);
      let result: Omit<DatabaseHostTestResult, "proxyDetected">;
      try {
        const [version] = (await first.run("SELECT VERSION() AS version")) as { version?: unknown }[];
        const [cipher] = (await first.run("SHOW SESSION STATUS LIKE 'Ssl_cipher'")) as { Value?: unknown }[];
        const latencyMs = Date.now() - started;
        result = {
          ok: true,
          error: null,
          serverVersion: typeof version?.version === "string" ? version.version.slice(0, 120) : null,
          tls: typeof cipher?.Value === "string" ? cipher.Value.length > 0 : null,
          latencyMs,
          missingPrivileges: await MysqlConnector.missingPrivileges(first.run),
        };
      } finally {
        await first.close();
      }
      // An unreadable identity counts as a proxy: in both cases unanswered statements are never KILLed.
      let proxyDetected = !first.identity || !direct(first.handshakeId, first.identity);
      if (!proxyDetected && first.identity) {
        const second = await this.session(cfg);
        await second.close();
        proxyDetected = !second.identity || !direct(second.handshakeId, second.identity) || !sameServer(first.identity, second.identity);
      }
      return { ...result, proxyDetected };
    } catch (err) {
      const e = describeMysqlError(err, [cfg.password], "connect");
      this.opts.logger.debug({ code: e.code, reason: e.message, host: cfg.host, port: cfg.port }, "database host test failed");
      return { ok: false, error: e.message, serverVersion: null, tls: null, latencyMs: null, proxyDetected: null, missingPrivileges: [] };
    }
  }

  /**
   * Shutdown, first step: refuses new connections and abandons every running statement at once (no `KILL`
   * round trips against a host that may not answer). Callers record those outcomes as unknown; jobs see code
   * `SHUTDOWN` and are retried after the restart.
   */
  shutdown(): void {
    this.closed = true;
    this.shutdownCtrl.abort();
    // An abort procedure in progress (KILL / confirmation) is dropped too: its outcome stays unknown.
    for (const c of this.aborting) hardClose(c);
    this.aborting.clear();
  }

  /** Destroys every open connection (sockets included) and refuses new ones (app shutdown). */
  closeAll(): void {
    this.shutdown();
    for (const c of this.open) hardClose(c);
    this.open.clear();
  }
}
