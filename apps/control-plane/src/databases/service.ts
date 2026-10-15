import { randomUUID } from "node:crypto";
import type { CreateServerDatabaseRequest, ServerDatabase, ServerDatabaseStatus } from "@blockforge/contracts";
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { actorUserId, type AuditActor, type AuditService } from "../audit/service.js";
import type { Db, Tx } from "../db/client.js";
import { databaseHosts, serverDatabases, servers } from "../db/schema/index.js";
import { pgErrorCode } from "../http/errors.js";
import { JobError } from "../jobs/types.js";
import type { Clock } from "../lib/clock.js";
import { AppError, conflict, forbidden, invalidState, notFound, unprocessable } from "../lib/errors.js";
import type { SecretBox } from "../secrets/secret-box.js";
import type { ServerAccess } from "../servers/access.js";
import { shortId } from "../servers/dto.js";
import { hostError, type DatabaseHostsService, type HostRow } from "./hosts.js";
import { DatabaseHostError, type HostSession, type MysqlConnector, type Run } from "./mysql.js";
import {
  alterUserPasswordSql,
  createDatabaseSql,
  createUserSql,
  databaseNameFor,
  dropDatabaseSql,
  dropUserSql,
  generatePassword,
  generateUsername,
  grantSql,
  PARTIAL_REVOKES_SQL,
  remoteFor,
} from "./sql.js";

type Row = typeof serverDatabases.$inferSelect;
type State = "reserved" | "provisioning" | "ready" | "password_unknown" | "cleanup_pending";
type Operation = "creating" | "rotating" | "deleting";

const dbAad = (id: string) => `server-database:${id}`;

export interface ServerDatabasesDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  box: SecretBox;
  audit: AuditService;
  connector: MysqlConnector;
  hosts: DatabaseHostsService;
  /** Test seam: username generator (default `u<shortId>_<10 random>`). */
  generateUsername?: (serverShortId: string) => string;
  /**
   * After this long an operation claim counts as abandoned (process crash) and may be taken over. Must exceed
   * the longest host operation (checked at startup); default max(5 min, that + 1 min).
   */
  operationStaleMs?: number;
  /** Overall limit of the server-deletion step (default 5 minutes); rows not reached are recorded as failed. */
  deleteDeadlineMs?: number;
  /** How long a `cleanup_pending` row waits before the sweep drops by name (default: host statement limit + 60 s). */
  cleanupDelayMs?: number;
}

/** Job-log callback of the server delete job. */
type JobLog = (level: "info" | "warn" | "error", message: string) => Promise<void>;

const SYSTEM_JOB: AuditActor = { actorType: "system", actorId: null, actorName: "job" };
const SYSTEM_SWEEP: AuditActor = { actorType: "system", actorId: null, actorName: "database-sweep" };

const busy = () => conflict("Another operation on this database is still in progress; try again in a moment", { reason: "busy" });
const notReady = () => conflict("The database is being created or awaits cleanup", { reason: "not_ready" });
const fresh = (state: State) => ({ state, stateChangedAt: sql`now()` });
const released = { operation: null, operationToken: null, operationStartedAt: null };

/** What a failed host statement may have done. */
type Effect = "none" | "applied" | "unknown";
const effectOf = (err: unknown): Effect =>
  err instanceof DatabaseHostError ? (err.kind === "interrupted" ? "unknown" : "none") : "unknown";

/**
 * Per-server MySQL databases (api.md "Databases"): limits, host selection, creation of the database and
 * its single-database account, password reveal/rotation and deletion. Every statement comes from
 * `sql.ts` (validated + quoted); passwords are generated here and stored encrypted.
 *
 * No transaction (and so no pooled Postgres connection or row lock) is ever held while a host is contacted:
 * every host operation claims the row in a short transaction (`operation` + `operation_token`), talks to
 * the host, then persists the outcome in a second short transaction conditional on still holding the claim.
 * A second create/rotate/delete of the same database meanwhile gets 409 `busy`.
 *
 * A statement the host does not answer is stopped on the host (`MysqlConnector`); its outcome is then decided
 * by looking at the host. If that is impossible the row says so: `password_unknown` (rotate again) or
 * `cleanup_pending` (the sweep drops by name and removes the row).
 */
export class ServerDatabasesService {
  readonly staleMs: number;
  readonly cleanupDelayMs: number;
  private readonly deleteDeadlineMs: number;
  private readonly newUsername: (serverShortId: string) => string;

  constructor(private readonly d: ServerDatabasesDeps) {
    const c = d.connector;
    // create: one session of 6 statements, then a cleanup session of 2; rotate/delete: one operation session plus
    // one inspection session. Claims older than the longest of these (with margin) are abandoned.
    const longest = Math.max(c.maxSessionMs(6) + c.maxSessionMs(2), 2 * c.maxSessionMs(4)) + 10_000;
    if (d.operationStaleMs !== undefined && d.operationStaleMs <= longest) {
      throw new Error(`operationStaleMs (${d.operationStaleMs} ms) must exceed the longest database host operation (${longest} ms)`);
    }
    this.staleMs = d.operationStaleMs ?? Math.max(5 * 60_000, longest + 60_000);
    this.cleanupDelayMs = d.cleanupDelayMs ?? (c.sessionLimitS ?? Math.ceil(c.queryTimeoutMs / 1000)) * 1000 + 60_000;
    this.deleteDeadlineMs = d.deleteDeadlineMs ?? 5 * 60_000;
    this.newUsername = d.generateUsername ?? generateUsername;
  }

  private statusOf(r: Row): ServerDatabaseStatus {
    if (r.operation === "creating" || r.state === "reserved" || r.state === "provisioning") return "creating";
    if (r.operation === "rotating") return "rotating";
    if (r.operation === "deleting") return "deleting";
    return r.state as ServerDatabaseStatus;
  }

  private toDto(r: Row, host: Pick<HostRow, "id" | "name" | "host" | "port" | "publicHost">): ServerDatabase {
    return {
      id: r.id,
      serverId: r.serverId,
      hostId: r.hostId,
      hostName: host.name,
      host: host.publicHost ?? host.host,
      port: host.port,
      database: r.databaseName,
      username: r.username,
      remote: r.remote,
      status: this.statusOf(r),
      createdAt: r.createdAt.getTime(),
      passwordRotatedAt: r.passwordRotatedAt?.getTime() ?? null,
    };
  }

  async list(access: ServerAccess): Promise<ServerDatabase[]> {
    const rows = await this.d.db
      .select({ r: serverDatabases, h: databaseHosts })
      .from(serverDatabases)
      .innerJoin(databaseHosts, eq(databaseHosts.id, serverDatabases.hostId))
      .where(eq(serverDatabases.serverId, access.server.id))
      .orderBy(asc(serverDatabases.createdAt), asc(serverDatabases.id));
    return rows.map(({ r, h }) => this.toDto(r, h));
  }

  private async rowOf(serverId: string, databaseId: string, tx: Db | Tx = this.d.db): Promise<{ r: Row; h: HostRow }> {
    const [row] = await tx
      .select({ r: serverDatabases, h: databaseHosts })
      .from(serverDatabases)
      .innerJoin(databaseHosts, eq(databaseHosts.id, serverDatabases.hostId))
      .where(and(eq(serverDatabases.id, databaseId), eq(serverDatabases.serverId, serverId)))
      .limit(1);
    if (!row) throw notFound("Database");
    return row;
  }

  /** Database clock: claim ages are compared in SQL, never against this process's clock. */
  private staleCutoff() {
    return sql`now() - make_interval(secs => ${this.staleMs / 1000})`;
  }

  /** Milliseconds until a `cleanup_pending` row's safety window ends (0 = passed), on the database clock. */
  private cleanupWaitMs() {
    return sql<number>`greatest(0, ceil(extract(epoch from (${serverDatabases.stateChangedAt} + make_interval(secs => ${this.cleanupDelayMs / 1000}) - now())) * 1000))::int`;
  }

  /** State left by an abandoned operation: what may exist on the host decides. */
  private static afterAbandoned(previous: Operation, state: State): State {
    // Names never verified free on the host: nothing of ours is there, whatever the operation was.
    if (state === "reserved") return "reserved";
    if (previous === "rotating") return state === "ready" ? "password_unknown" : state;
    return "cleanup_pending";
  }

  /**
   * Short transaction: lock the row, refuse a live claim of another operation, take over an abandoned one
   * (audited; a taken-over rotation leaves `password_unknown`, a taken-over delete or create `cleanup_pending`,
   * a `reserved` row stays `reserved`), record ours. Rotation needs a database that exists on the host
   * (`not_ready` otherwise); deleting a `cleanup_pending` row waits for its safety window (`not_ready` with
   * `retryAfterMs`) so a statement that may still be running cannot land after the drop.
   */
  private async claim(serverId: string, databaseId: string, op: "rotating" | "deleting", actor: AuditActor): Promise<{ r: Row; h: HostRow; token: string }> {
    const token = randomUUID();
    return this.d.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ r: serverDatabases, h: databaseHosts, stale: sql<boolean>`${serverDatabases.operationStartedAt} < ${this.staleCutoff()}`, waitMs: this.cleanupWaitMs() })
        .from(serverDatabases)
        .innerJoin(databaseHosts, eq(databaseHosts.id, serverDatabases.hostId))
        .where(and(eq(serverDatabases.id, databaseId), eq(serverDatabases.serverId, serverId)))
        .for("update", { of: serverDatabases })
        .limit(1);
      if (!row) throw notFound("Database");
      let state = row.r.state as State;
      if (row.r.operation === null && op === "deleting" && state === "cleanup_pending" && Number(row.waitMs) > 0) {
        const retryAfterMs = Number(row.waitMs);
        throw conflict(`The database awaits cleanup; BlockForge removes it automatically, or delete it again in ${Math.ceil(retryAfterMs / 1000)} s`, { reason: "not_ready", retryAfterMs });
      }
      if (row.r.operation !== null) {
        if (!row.stale) throw busy();
        const previous = row.r.operation as Operation;
        state = ServerDatabasesService.afterAbandoned(previous, state);
        await this.d.audit.record(
          { ...actor, action: "server.database.claim_takeover", targetType: "server", targetId: serverId, outcome: "success", details: { databaseId, previousOperation: previous, takenOverBy: op, state } },
          tx,
        );
      }
      if (op === "rotating" && (state === "reserved" || state === "provisioning" || state === "cleanup_pending")) throw notReady();
      const [r] = await tx
        .update(serverDatabases)
        .set({ operation: op, operationToken: token, operationStartedAt: sql`now()`, ...(state !== row.r.state ? fresh(state) : {}) })
        .where(eq(serverDatabases.id, row.r.id))
        .returning();
      return { r: r!, h: row.h, token };
    });
  }

  /** Releases a claim (optionally setting a state); no-op when it was taken over or the row is gone. Never throws. */
  private async release(databaseId: string, token: string, state?: State): Promise<void> {
    await this.d.db
      .update(serverDatabases)
      .set({ ...released, ...(state ? fresh(state) : {}) })
      .where(and(eq(serverDatabases.id, databaseId), eq(serverDatabases.operationToken, token)))
      .catch((err: unknown) => this.d.logger.warn({ databaseId, code: pgErrorCode(err) }, "could not release a database operation claim (it expires on its own)"));
  }

  /** After the claim was lost: 404 when the row is gone, 409 `busy` when another operation holds it. */
  private async lostClaim(databaseId: string): Promise<never> {
    const [exists] = await this.d.db.select({ id: serverDatabases.id }).from(serverDatabases).where(eq(serverDatabases.id, databaseId)).limit(1);
    throw exists ? busy() : notFound("Database");
  }

  /**
   * What exists on the host now (fresh session): the database, the account and its authentication string.
   * Null when the host cannot be asked.
   */
  private async inspect(h: HostRow, r: Pick<Row, "databaseName" | "username" | "remote">, signal?: AbortSignal): Promise<{ database: boolean; account: boolean; auth: string | null } | null> {
    try {
      return await this.d.connector.withConnection(
        this.d.hosts.connectionOf(h),
        async (run) => {
          const db = (await run("SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [r.databaseName])) as { n: unknown }[];
          const acct = (await run("SELECT authentication_string AS a FROM mysql.user WHERE User = ? AND Host = ?", [r.username, r.remote])) as { a: unknown }[];
          return { database: Number(db[0]?.n ?? 0) > 0, account: acct.length > 0, auth: acct[0] ? String(acct[0].a ?? "") : null };
        },
        [],
        signal,
      );
    } catch (err) {
      const e = err instanceof DatabaseHostError ? err : null;
      this.d.logger.warn({ hostId: h.id, database: r.databaseName, code: e?.code ?? null }, "could not inspect the database host");
      return null;
    }
  }

  /**
   * Host choice: an explicitly requested host (administrators), else the first host with capacity among
   * hosts linked to the server's node, then unlinked hosts, then hosts linked to other nodes (oldest
   * first within each group). Capacity is checked with the host rows locked in `tx`: one row for an
   * explicit choice, otherwise all of them in id order (a short, deadlock-free critical section — the
   * reservation transaction does no I/O to the hosts).
   */
  private async pickHost(tx: Tx, nodeId: string, requested: string | undefined): Promise<HostRow> {
    const usage = async (hostIds: string[]) => {
      const out = new Map<string, number>();
      if (!hostIds.length) return out;
      const rows = await tx.select({ hostId: serverDatabases.hostId, n: count() }).from(serverDatabases).where(inArray(serverDatabases.hostId, hostIds)).groupBy(serverDatabases.hostId);
      for (const r of rows) out.set(r.hostId, Number(r.n));
      return out;
    };
    if (requested) {
      const [h] = await tx.select().from(databaseHosts).where(eq(databaseHosts.id, requested)).for("update").limit(1);
      if (!h) throw notFound("Database host");
      if (h.maxDatabases !== null && ((await usage([h.id])).get(h.id) ?? 0) >= h.maxDatabases) {
        throw conflict("The database host has reached its database limit", { reason: "host_full", limit: h.maxDatabases });
      }
      return h;
    }
    const hosts = await tx.select().from(databaseHosts).orderBy(asc(databaseHosts.id)).for("update");
    const used = await usage(hosts.map((h) => h.id));
    const rank = (h: HostRow) => (h.nodeId === nodeId ? 0 : h.nodeId === null ? 1 : 2);
    const ordered = [...hosts].sort((a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const chosen = ordered.find((h) => h.maxDatabases === null || (used.get(h.id) ?? 0) < h.maxDatabases);
    if (chosen) return chosen;
    throw unprocessable(hosts.length ? "Every database host is full" : "No database host is configured", { reason: "no_host" });
  }

  async create(access: ServerAccess, req: CreateServerDatabaseRequest, actor: AuditActor, canPickHost: boolean): Promise<ServerDatabase> {
    const server = access.server;
    const admin = access.permissions.has("servers.admin");
    if (req.hostId !== undefined && !canPickHost) throw forbidden("Choosing a database host requires database_hosts.manage");
    if (!admin && server.databaseLimit === 0) throw new AppError(403, "FORBIDDEN", "Databases are disabled for this server", { reason: "disabled" });
    const database = databaseNameFor(shortId(server.id), req.name);
    const remote = remoteFor(req.remote ?? "%");
    const password = generatePassword();
    const id = randomUUID();
    const token = randomUUID();

    // 1. Reserve: limits, host capacity and names are checked and the row inserted (state `reserved`, claimed
    //    `creating`) in one short transaction; the host is contacted only after it committed.
    let host: HostRow;
    let username: string;
    try {
      ({ host, username } = await this.d.db.transaction(async (tx) => {
        const [srv] = await tx.select({ state: servers.state, op: servers.activeOperation }).from(servers).where(eq(servers.id, server.id)).for("share").limit(1);
        if (!srv) throw notFound("Server");
        if (srv.state === "deleting" || srv.op === "delete") throw invalidState("The server is being deleted");
        // Serialises creations per server so the limit cannot be overshot.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`server-databases:${server.id}`}, 0))`);
        const [n] = await tx.select({ n: count() }).from(serverDatabases).where(eq(serverDatabases.serverId, server.id));
        const used = Number(n?.n ?? 0);
        if (!admin && used >= server.databaseLimit) {
          throw conflict(`The server has reached its database limit (${server.databaseLimit})`, { reason: "limit_reached", limit: server.databaseLimit });
        }
        const [same] = await tx
          .select({ id: serverDatabases.id })
          .from(serverDatabases)
          .where(and(eq(serverDatabases.serverId, server.id), eq(serverDatabases.databaseName, database)))
          .limit(1);
        if (same) throw conflict("The server already has a database with this name", { reason: "name_taken" });
        const h = await this.pickHost(tx, server.nodeId, req.hostId);
        const [taken] = await tx
          .select({ id: serverDatabases.id })
          .from(serverDatabases)
          .where(and(eq(serverDatabases.hostId, h.id), eq(serverDatabases.databaseName, database)))
          .limit(1);
        if (taken) throw conflict("A database with this name already exists on the host", { reason: "name_taken" });
        let user = this.newUsername(shortId(server.id));
        for (let i = 0; i < 5; i++) {
          const [u] = await tx.select({ id: serverDatabases.id }).from(serverDatabases).where(and(eq(serverDatabases.hostId, h.id), eq(serverDatabases.username, user))).limit(1);
          if (!u) break;
          user = this.newUsername(shortId(server.id));
        }
        await tx.insert(serverDatabases).values({
          id,
          serverId: server.id,
          hostId: h.id,
          databaseName: database,
          username: user,
          remote,
          passwordEnc: this.d.box.encryptToString(password, dbAad(id)),
          createdBy: actorUserId(actor),
          createdAt: new Date(this.d.clock.now()),
          operation: "creating",
          operationToken: token,
          operationStartedAt: sql`now()`,
          state: "reserved",
          stateChangedAt: sql`now()`,
        });
        return { host: h, username: user };
      }));
    } catch (err) {
      if (pgErrorCode(err) === "23505") throw conflict("A database with this name already exists on the host", { reason: "name_taken" });
      throw err;
    }

    // 2. On the host: verify both names are free (from then on whatever exists under them is ours —
    //    `provisioning`), then create the database, the account and the grant.
    const attempted = { database: "none" as Effect, user: "none" as Effect };
    let failure: unknown = null;
    let nameTaken = false;
    let userExists = false;
    let rowGone = false;
    let session: HostSession | null = null;
    try {
      session = await this.d.connector.session(this.d.hosts.connectionOf(host), [password]);
      const run = session.run;
      const [dbs] = (await run("SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [database])) as { n: unknown }[];
      const [users] = (await run("SELECT COUNT(*) AS n FROM mysql.user WHERE User = ?", [username])) as { n: unknown }[];
      nameTaken = Number(dbs?.n ?? 0) > 0;
      userExists = Number(users?.n ?? 0) > 0;
      if (!nameTaken && !userExists) {
        const [marked] = await this.d.db
          .update(serverDatabases)
          .set(fresh("provisioning"))
          .where(and(eq(serverDatabases.id, id), eq(serverDatabases.operationToken, token)))
          .returning({ id: serverDatabases.id });
        if (!marked) rowGone = true;
        else {
          attempted.database = "unknown";
          await run(createDatabaseSql(database));
          attempted.database = "applied";
          attempted.user = "unknown";
          await run(createUserSql(username, remote, password));
          attempted.user = "applied";
          const [partialRevokes] = (await run(PARTIAL_REVOKES_SQL)) as { Value?: unknown }[];
          const literalGrantNames = String(partialRevokes?.Value ?? "").toUpperCase() === "ON";
          await run(grantSql(database, username, remote, !literalGrantNames));
        }
      }
    } catch (err) {
      failure = err;
      // A statement the host refused did not take effect; an unanswered one is decided below.
      if (attempted.database === "unknown") attempted.database = effectOf(err);
      else if (attempted.user === "unknown") attempted.user = effectOf(err);
    } finally {
      await session?.close();
    }

    const fail = async (details: Record<string, unknown>) =>
      this.d.audit.record({
        ...actor,
        action: "server.database.create",
        targetType: "server",
        targetId: server.id,
        outcome: "failed",
        details: { databaseId: id, database, username, hostId: host.id, hostName: host.name, remote, ...details },
      });

    if (!failure && (nameTaken || userExists)) {
      await this.d.db.delete(serverDatabases).where(and(eq(serverDatabases.id, id), eq(serverDatabases.operationToken, token)));
      await fail({ error: nameTaken ? "the database name exists on the host" : "the account exists on the host", code: nameTaken ? "ER_DB_CREATE_EXISTS" : "ER_CANNOT_USER" });
      if (nameTaken) throw conflict("A database with this name already exists on the host", { reason: "name_taken" });
      throw hostError("an account with the generated name already exists on the host", "ER_CANNOT_USER");
    }

    if (!failure && !rowGone) {
      // 3. Persist: ready, claim released. The row may have been removed meanwhile (server deleted).
      const [stored] = await this.d.db
        .update(serverDatabases)
        .set({ ...released, ...fresh("ready") })
        .where(and(eq(serverDatabases.id, id), eq(serverDatabases.operationToken, token)))
        .returning();
      if (stored) {
        await this.d.audit.record({
          ...actor,
          action: "server.database.create",
          targetType: "server",
          targetId: server.id,
          outcome: "success",
          details: { databaseId: id, database, username, hostId: host.id, hostName: host.name, remote },
        });
        return this.toDto(stored, host);
      }
      rowGone = true;
      attempted.database = "applied";
      attempted.user = "applied";
    }

    // 4. Failure (or the row vanished): remove by name whatever may exist — the names were verified free before
    //    anything was created, so nothing that existed before is touched. An unanswered statement that could not
    //    be confirmed stopped may still land later: the row then stays `cleanup_pending` for the sweep.
    const e = failure instanceof DatabaseHostError ? failure : null;
    const toDrop = { database: attempted.database !== "none", user: attempted.user !== "none" };
    // Only matters once something was sent to the host after the names were verified.
    const uncertain = (toDrop.database || toDrop.user) && e?.kind === "interrupted" && !e.stopped;
    let cleaned = true;
    if (toDrop.database || toDrop.user) cleaned = await this.dropByName(host, { databaseName: database, username, remote }, toDrop);
    if (rowGone) {
      if (!cleaned) await fail({ error: "the database was deleted while it was being created; its leftovers could not be dropped", cleanupFailed: true });
      throw invalidState("The database was deleted while it was being created");
    }
    if (cleaned && !uncertain) {
      await this.d.db.delete(serverDatabases).where(and(eq(serverDatabases.id, id), eq(serverDatabases.operationToken, token)));
    } else {
      await this.release(id, token, "cleanup_pending");
    }
    await fail({ error: e?.message ?? "failed", code: e?.code ?? null, cleanupPending: !cleaned || uncertain });
    if (e?.code === "ER_DB_CREATE_EXISTS") throw conflict("A database with this name already exists on the host", { reason: "name_taken" });
    if (e) throw hostError(e.message, e.code, uncertain || !cleaned);
    throw failure;
  }

  /** `DROP … IF EXISTS` of the database and/or account (fresh session). True when both statements succeeded. */
  private async dropByName(h: HostRow, r: Pick<Row, "databaseName" | "username" | "remote">, what: { database: boolean; user: boolean }, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.d.connector.withConnection(
        this.d.hosts.connectionOf(h),
        async (run) => {
          if (what.user) await run(dropUserSql(r.username, r.remote));
          if (what.database) await run(dropDatabaseSql(r.databaseName));
        },
        [],
        signal,
      );
      return true;
    } catch (err) {
      const e = err instanceof DatabaseHostError ? err : null;
      this.d.logger.warn({ hostId: h.id, database: r.databaseName, code: e?.code ?? null, reason: e?.message ?? "failed" }, "could not drop a database by name");
      return false;
    }
  }

  /** Plaintext password (audited; the route answers with `Cache-Control: no-store`). */
  async password(access: ServerAccess, databaseId: string, actor: AuditActor): Promise<{ password: string }> {
    const { r } = await this.rowOf(access.server.id, databaseId);
    const status = this.statusOf(r);
    if (status === "creating" || status === "cleanup_pending") throw notReady();
    if (status === "password_unknown") {
      throw conflict("The last password rotation could not be confirmed; rotate the password again", { reason: "password_unknown" });
    }
    const password = this.d.box.decryptString(r.passwordEnc, dbAad(r.id));
    await this.d.audit.record({
      ...actor,
      action: "server.database.password.view",
      targetType: "server",
      targetId: access.server.id,
      outcome: "success",
      details: { databaseId: r.id, database: r.databaseName },
    });
    return { password };
  }

  /**
   * New password: claim → `ALTER USER` (no transaction open) → store it and release. A failure before
   * `ALTER USER` was sent changes nothing (the state stays as it was). If the host refuses `ALTER USER` (atomic),
   * the old password stays valid everywhere (502). If it does not answer, the statement is stopped on the host
   * and the account's authentication string (read before) is compared afterwards: changed → the new password is
   * stored (success); unchanged → nothing happened (502). If that cannot be determined, the database becomes
   * `password_unknown` (502 `unknownOutcome`) — rotating again always fixes it.
   */
  async rotate(access: ServerAccess, databaseId: string, actor: AuditActor): Promise<ServerDatabase> {
    const password = generatePassword();
    const { r, h, token } = await this.claim(access.server.id, databaseId, "rotating", actor);
    let before: string | null | undefined;
    let alterSent = false;
    let failure: unknown = null;
    try {
      await this.d.connector.withConnection(
        this.d.hosts.connectionOf(h),
        async (run) => {
          try {
            const rows = (await run("SELECT authentication_string AS a FROM mysql.user WHERE User = ? AND Host = ?", [r.username, r.remote])) as { a: unknown }[];
            before = rows[0] ? String(rows[0].a ?? "") : null;
          } catch (err) {
            // Without SELECT on mysql.user the outcome of an unanswered ALTER cannot be decided (→ unknown).
            if (!(err instanceof DatabaseHostError && err.kind === "rejected")) throw err;
          }
          alterSent = true;
          await run(alterUserPasswordSql(r.username, r.remote, password));
        },
        [password],
      );
    } catch (err) {
      failure = err;
    }
    if (failure !== null) {
      const e = failure instanceof DatabaseHostError ? failure : null;
      let decided: Effect = alterSent ? effectOf(failure) : "none";
      if (decided === "unknown" && e?.stopped && typeof before === "string") {
        const now = await this.inspect(h, r);
        if (now?.auth != null) decided = now.auth !== before ? "applied" : "none";
      }
      if (decided === "applied") {
        this.d.logger.warn({ databaseId: r.id }, "the host applied the new password although its answer was lost");
      } else {
        // Unchanged: the state the row had (`ready` or `password_unknown`) stays.
        await this.release(r.id, token, decided === "unknown" ? "password_unknown" : undefined);
        await this.d.audit.record({
          ...actor,
          action: "server.database.rotate_password",
          targetType: "server",
          targetId: access.server.id,
          outcome: "failed",
          details: { databaseId: r.id, error: e?.message ?? "failed", code: e?.code ?? null, alterSent, passwordUnknown: decided === "unknown" },
        });
        if (e) throw hostError(decided === "unknown" ? `${e.message}; the new password may or may not have been applied` : `${e.message}; the password was not changed`, e.code, decided === "unknown");
        throw failure;
      }
    }
    let stored: Row | undefined;
    try {
      stored = await this.d.db.transaction(async (tx) => {
        const [row] = await tx
          .update(serverDatabases)
          .set({ passwordEnc: this.d.box.encryptToString(password, dbAad(r.id)), passwordRotatedAt: new Date(this.d.clock.now()), ...released, ...fresh("ready") })
          .where(and(eq(serverDatabases.id, r.id), eq(serverDatabases.operationToken, token)))
          .returning();
        if (row) {
          await this.d.audit.record(
            { ...actor, action: "server.database.rotate_password", targetType: "server", targetId: access.server.id, outcome: "success", details: { databaseId: r.id, database: r.databaseName, username: r.username } },
            tx,
          );
        }
        return row;
      });
    } catch (err) {
      this.d.logger.error({ databaseId: r.id, code: pgErrorCode(err) }, "the host has the new password but it could not be stored; rotate again");
      await this.release(r.id, token, "password_unknown");
      throw err;
    }
    if (!stored) {
      await this.d.audit.record({
        ...actor,
        action: "server.database.rotate_password",
        targetType: "server",
        targetId: access.server.id,
        outcome: "failed",
        details: { databaseId: r.id, error: "the database changed while its password was being rotated" },
      });
      return this.lostClaim(r.id);
    }
    return this.toDto(stored, h);
  }

  /**
   * What a failed `DROP DATABASE` + `DROP USER` sequence left on the host, decided per statement:
   * - failure before `DROP DATABASE` was sent → `unchanged`;
   * - `DROP DATABASE` refused by the host → `unchanged` (atomic on MySQL 8; MariaDB aborts only while still waiting
   *   for its locks — once dropping it is not interruptible);
   * - no answer and not confirmed stopped → `unknown` (it may still land);
   * - otherwise (no answer but stopped, or `DROP USER` failed after the database was dropped) the host is inspected:
   *   both gone → `gone`, both present → `unchanged`, anything else (or not inspectable) → `partial`.
   */
  private async dropOutcome(
    h: HostRow,
    r: Pick<Row, "databaseName" | "username" | "remote">,
    progress: { sent: boolean; databaseDropped: boolean },
    e: DatabaseHostError | null,
    signal?: AbortSignal,
  ): Promise<"gone" | "unchanged" | "partial" | "unknown"> {
    if (!progress.sent) return "unchanged";
    if (!e) return "unknown";
    if (e.kind === "interrupted" && !e.stopped) return "unknown";
    if (!progress.databaseDropped && e.kind === "rejected") return "unchanged";
    const now = await this.inspect(h, r, signal);
    if (!now) return progress.databaseDropped ? "partial" : "unknown";
    if (!now.database && !now.account) return "gone";
    if (now.database && now.account) return "unchanged";
    return "partial";
  }

  /** Runs the two drops on `run`, recording how far they got. */
  private async dropTracked(run: Run, r: Pick<Row, "databaseName" | "username" | "remote">, progress: { sent: boolean; databaseDropped: boolean }): Promise<void> {
    progress.sent = true;
    await run(dropDatabaseSql(r.databaseName));
    progress.databaseDropped = true;
    await run(dropUserSql(r.username, r.remote));
  }

  /**
   * Claim → drop the database and its account on the host (no transaction open) → delete the row. A `reserved`
   * row (names never verified on the host) is just removed. On failure the outcome is decided per statement
   * ({@link dropOutcome}): `unchanged` keeps the row as it was (502; retry), `gone` deletes it, `partial` and
   * `unknown` leave it `cleanup_pending` so the sweep finishes the requested deletion once a statement that may
   * still be running can no longer land (502, `unknownOutcome` for `unknown`).
   */
  async remove(access: ServerAccess, databaseId: string, actor: AuditActor): Promise<void> {
    const { r, h, token } = await this.claim(access.server.id, databaseId, "deleting", actor);
    const progress = { sent: false, databaseDropped: false };
    let failure: unknown = null;
    if (r.state !== "reserved") {
      try {
        await this.d.connector.withConnection(this.d.hosts.connectionOf(h), (run) => this.dropTracked(run, r, progress));
      } catch (err) {
        failure = err;
      }
    }
    if (failure !== null) {
      const e = failure instanceof DatabaseHostError ? failure : null;
      const outcome = await this.dropOutcome(h, r, progress, e);
      if (outcome !== "gone") {
        await this.release(r.id, token, outcome === "unchanged" ? undefined : "cleanup_pending");
        const what =
          outcome === "unchanged"
            ? "the database was not deleted"
            : outcome === "partial"
              ? "the database was partly deleted; BlockForge finishes the deletion automatically"
              : "the deletion may or may not have taken effect; BlockForge finishes it automatically";
        await this.d.audit.record({
          ...actor,
          action: "server.database.delete",
          targetType: "server",
          targetId: access.server.id,
          outcome: "failed",
          details: { databaseId: r.id, error: e?.message ?? "failed", code: e?.code ?? null, result: outcome, cleanupPending: outcome !== "unchanged" },
        });
        if (e) throw hostError(`${e.message}; ${what}`, e.code, outcome === "unknown");
        throw failure;
      }
    }
    let deleted: boolean;
    try {
      deleted = await this.d.db.transaction(async (tx) => {
        const rows = await tx.delete(serverDatabases).where(and(eq(serverDatabases.id, r.id), eq(serverDatabases.operationToken, token))).returning({ id: serverDatabases.id });
        if (!rows.length) return false;
        await this.d.audit.record(
          { ...actor, action: "server.database.delete", targetType: "server", targetId: access.server.id, outcome: "success", details: { databaseId: r.id, database: r.databaseName, username: r.username, hostId: h.id, hostName: h.name } },
          tx,
        );
        return true;
      });
    } catch (err) {
      await this.release(r.id, token);
      throw err;
    }
    if (!deleted) await this.lostClaim(r.id);
  }

  /**
   * Forget (`DELETE …?forget=true`, administrators): removes BlockForge's record without contacting the host —
   * the database and its account stay there. For hosts that are permanently gone. Refused (409 `busy`) while an
   * operation that is not abandoned runs on the database.
   */
  async forget(access: ServerAccess, databaseId: string, actor: AuditActor): Promise<void> {
    await this.d.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ r: serverDatabases, h: databaseHosts, stale: sql<boolean>`${serverDatabases.operationStartedAt} < ${this.staleCutoff()}` })
        .from(serverDatabases)
        .innerJoin(databaseHosts, eq(databaseHosts.id, serverDatabases.hostId))
        .where(and(eq(serverDatabases.id, databaseId), eq(serverDatabases.serverId, access.server.id)))
        .for("update", { of: serverDatabases })
        .limit(1);
      if (!row) throw notFound("Database");
      if (row.r.operation !== null && !row.stale) throw busy();
      await tx.delete(serverDatabases).where(eq(serverDatabases.id, row.r.id));
      await this.d.audit.record(
        {
          ...actor,
          action: "server.database.forget",
          targetType: "server",
          targetId: access.server.id,
          outcome: "success",
          details: { databaseId: row.r.id, database: row.r.databaseName, username: row.r.username, remote: row.r.remote, hostId: row.h.id, hostName: row.h.name, host: `${row.h.host}:${row.h.port}`, state: row.r.state, leftOnHost: true },
        },
        tx,
      );
    });
  }

  /**
   * Maintenance sweep (every minute and at start), cancelled by `signal` (app shutdown). First it resolves
   * abandoned claims (a crashed process) on the database alone: `reserved` rows (names never verified on the
   * host) are removed, `rotating` → `password_unknown`, `creating`/`deleting` → `cleanup_pending`. Then it finishes
   * `cleanup_pending` rows whose safety window has passed — drop by name (`IF EXISTS`), remove the row — oldest
   * first, at most {@link SWEEP_ROWS_PER_HOST} per host and run (fair share), {@link SWEEP_HOST_CONCURRENCY} hosts
   * at a time, one session per host; after any failure the host is skipped for the rest of the run. Never throws.
   */
  async sweep(signal?: AbortSignal): Promise<{ resolved: number; cleaned: number }> {
    const cancel = signal ?? new AbortController().signal;
    let resolved = 0;
    let cleaned = 0;
    try {
      const stale = await this.d.db
        .select()
        .from(serverDatabases)
        .where(and(isNotNull(serverDatabases.operation), lt(serverDatabases.operationStartedAt, this.staleCutoff())))
        .orderBy(asc(serverDatabases.operationStartedAt))
        .limit(500);
      for (const r of stale) {
        if (cancel.aborted) return { resolved, cleaned };
        const previous = r.operation as Operation;
        const done = await this.d.db.transaction(async (tx) => {
          const cond = and(eq(serverDatabases.id, r.id), eq(serverDatabases.operationToken, r.operationToken!));
          const state = ServerDatabasesService.afterAbandoned(previous, r.state as State);
          let outcome: string;
          if (state === "reserved") {
            const rows = await tx.delete(serverDatabases).where(cond).returning({ id: serverDatabases.id });
            if (!rows.length) return false;
            outcome = "removed (nothing of it was on the host)";
          } else {
            const rows = await tx.update(serverDatabases).set({ ...released, ...fresh(state) }).where(cond).returning({ id: serverDatabases.id });
            if (!rows.length) return false;
            outcome = state;
          }
          await this.d.audit.record(
            { ...SYSTEM_SWEEP, action: "server.database.claim_takeover", targetType: "server", targetId: r.serverId, outcome: "success", details: { databaseId: r.id, database: r.databaseName, previousOperation: previous, result: outcome } },
            tx,
          );
          return true;
        });
        if (done) resolved++;
      }

      const pending = await this.d.db
        .select({ r: serverDatabases, h: databaseHosts })
        .from(serverDatabases)
        .innerJoin(databaseHosts, eq(databaseHosts.id, serverDatabases.hostId))
        .where(and(eq(serverDatabases.state, "cleanup_pending"), isNull(serverDatabases.operation), sql`${this.cleanupWaitMs()} = 0`))
        .orderBy(asc(serverDatabases.stateChangedAt), asc(serverDatabases.id))
        .limit(SWEEP_ROWS_PER_HOST * 50);
      const byHost = new Map<string, { h: HostRow; rows: Row[] }>();
      for (const { r, h } of pending) {
        const g = byHost.get(h.id) ?? { h, rows: [] };
        if (g.rows.length < SWEEP_ROWS_PER_HOST) g.rows.push(r);
        byHost.set(h.id, g);
      }
      const queue = [...byHost.values()];
      const worker = async () => {
        for (let next = queue.shift(); next && !cancel.aborted; next = queue.shift()) cleaned += await this.sweepHost(next.h, next.rows, cancel);
      };
      await Promise.all(Array.from({ length: Math.min(SWEEP_HOST_CONCURRENCY, queue.length) }, worker));
    } catch (err) {
      this.d.logger.warn({ code: pgErrorCode(err) }, "database sweep failed");
    }
    return { resolved, cleaned };
  }

  /** Cleanup of one host's `cleanup_pending` rows (one session); stops at the first failure. Returns rows removed. */
  private async sweepHost(h: HostRow, rows: Row[], signal: AbortSignal): Promise<number> {
    let cleaned = 0;
    let session: HostSession | null = null;
    try {
      for (const r of rows) {
        if (signal.aborted) break;
        const token = randomUUID();
        const [claimed] = await this.d.db
          .update(serverDatabases)
          .set({ operation: "deleting", operationToken: token, operationStartedAt: sql`now()` })
          .where(and(eq(serverDatabases.id, r.id), isNull(serverDatabases.operation), eq(serverDatabases.state, "cleanup_pending")))
          .returning({ id: serverDatabases.id });
        if (!claimed) continue;
        try {
          session ??= await this.d.connector.session(this.d.hosts.connectionOf(h), [], signal);
          await this.drop(session.run, r);
        } catch (err) {
          const e = err instanceof DatabaseHostError ? err : null;
          // Not confirmed stopped: restart the safety window. Otherwise the row simply stays `cleanup_pending`.
          await this.release(r.id, token, e?.kind === "interrupted" && !e.stopped ? "cleanup_pending" : undefined);
          if (!signal.aborted) this.d.logger.warn({ databaseId: r.id, hostId: h.id, code: e?.code ?? null, reason: e?.message ?? "failed" }, "database cleanup failed; skipping this host until the next run");
          break;
        }
        const removed = await this.d.db.transaction(async (tx) => {
          const deleted = await tx.delete(serverDatabases).where(and(eq(serverDatabases.id, r.id), eq(serverDatabases.operationToken, token))).returning({ id: serverDatabases.id });
          if (!deleted.length) return false;
          await this.d.audit.record(
            { ...SYSTEM_SWEEP, action: "server.database.delete", targetType: "server", targetId: r.serverId, outcome: "success", details: { databaseId: r.id, database: r.databaseName, username: r.username, hostId: h.id, hostName: h.name, reason: "cleanup" } },
            tx,
          );
          return true;
        });
        if (removed) cleaned++;
      }
    } finally {
      await session?.close();
    }
    return cleaned;
  }

  private async drop(run: Run, r: Pick<Row, "databaseName" | "username" | "remote">): Promise<void> {
    await run(dropDatabaseSql(r.databaseName));
    await run(dropUserSql(r.username, r.remote));
  }

  /**
   * Server deletion (best effort, recorded): drops every database of the server on its host, deleting each row
   * as soon as its database is gone. One session per host; after an unanswered statement the next database gets
   * a fresh session (a host that cannot be connected to marks its remaining databases failed). Bounded by
   * `deleteDeadlineMs` (rows not reached are recorded as failed) and by the job's cancellation `signal` (the step
   * stops and rethrows); at control-plane shutdown the job is retried after the restart. Outcomes are decided per
   * statement ({@link dropOutcome}); failures and unknown outcomes go to the job log and the audit log (with host,
   * database and username, to check and drop by hand); the remaining rows go with the server.
   */
  async dropAllForServer(serverId: string, ctx: { jobId: string; log: JobLog; signal?: AbortSignal }): Promise<{ dropped: number; failed: number }> {
    const cancel = ctx.signal ?? new AbortController().signal;
    const deadline = AbortSignal.timeout(this.deleteDeadlineMs);
    const signal = AbortSignal.any([cancel, deadline]);
    const rows = await this.d.db
      .select({ r: serverDatabases, h: databaseHosts })
      .from(serverDatabases)
      .innerJoin(databaseHosts, eq(databaseHosts.id, serverDatabases.hostId))
      .where(eq(serverDatabases.serverId, serverId))
      .orderBy(asc(serverDatabases.createdAt));
    const byHost = new Map<string, { h: HostRow; rows: Row[] }>();
    for (const { r, h } of rows) {
      const g = byHost.get(h.id) ?? { h, rows: [] };
      g.rows.push(r);
      byHost.set(h.id, g);
    }
    let dropped = 0;
    let failed = 0;
    type Problem = { message: string; code: string | null; result?: "unchanged" | "partial" | "unknown" | "not_attempted" };
    const audit = async (r: Row, h: HostRow, problem: Problem | null) => {
      await this.d.audit.record({
        ...SYSTEM_JOB,
        action: "server.database.delete",
        targetType: "server",
        targetId: serverId,
        // The audit outcome has no "unknown": an unconfirmed drop is `failed` with `result: "unknown"`.
        outcome: problem ? "failed" : "success",
        details: {
          databaseId: r.id,
          database: r.databaseName,
          username: r.username,
          hostId: h.id,
          hostName: h.name,
          host: `${h.host}:${h.port}`,
          reason: "server_deleted",
          jobId: ctx.jobId,
          ...(problem ? { error: problem.message, code: problem.code, result: problem.result ?? "unchanged", unknownOutcome: problem.result === "unknown" } : {}),
        },
      });
    };
    const succeed = async (r: Row, h: HostRow) => {
      await this.d.db.delete(serverDatabases).where(eq(serverDatabases.id, r.id));
      await audit(r, h, null);
      dropped++;
    };
    const fail = async (r: Row, h: HostRow, problem: Problem) => {
      await audit(r, h, problem);
      const where = `${r.databaseName} on ${h.name} (${h.host}:${h.port})`;
      const line =
        problem.result === "unknown"
          ? `Database ${where}: outcome unknown (${problem.message}) — the drop may still complete on the host. Check whether it and user ${r.username} remain, and drop them by hand if so.`
          : problem.result === "partial"
            ? `Database ${where} was partly dropped (${problem.message}). Drop what remains of it and user ${r.username} by hand.`
            : `Database ${where} could not be dropped: ${problem.message}. Drop it and user ${r.username} by hand.`;
      await ctx.log("warn", line);
      failed++;
    };
    const stopIfCancelled = () => {
      if (cancel.aborted) throw cancel.reason instanceof Error ? cancel.reason : new Error("cancelled");
    };
    const stopIfShutdown = (e: DatabaseHostError | null) => {
      if (e?.code === "SHUTDOWN") throw new JobError("SHUTDOWN", "control plane shutting down", true);
    };
    const deadlineProblem: Problem = { message: "not attempted: the deletion step ran out of time", code: "DEADLINE", result: "not_attempted" };

    for (const { h, rows: list } of byHost.values()) {
      let session: HostSession | null = null;
      try {
        for (let i = 0; i < list.length; i++) {
          const r = list[i]!;
          stopIfCancelled();
          if (deadline.aborted) {
            for (const rest of list.slice(i)) await fail(rest, h, deadlineProblem);
            break;
          }
          // Never verified on the host (a creation that had not reached it): nothing of ours exists there.
          if (r.state === "reserved") {
            await succeed(r, h);
            continue;
          }
          if (!session) {
            try {
              session = await this.d.connector.session(this.d.hosts.connectionOf(h), [], signal);
            } catch (err) {
              stopIfCancelled();
              const e = err instanceof DatabaseHostError ? err : null;
              stopIfShutdown(e);
              const why: Problem = deadline.aborted ? deadlineProblem : { message: e?.message ?? "database host error", code: e?.code ?? null, result: "unchanged" };
              for (const rest of list.slice(i)) await fail(rest, h, why);
              break;
            }
          }
          const progress = { sent: false, databaseDropped: false };
          try {
            await this.dropTracked(session.run, r, progress);
            await succeed(r, h);
          } catch (err) {
            stopIfCancelled();
            const e = err instanceof DatabaseHostError ? err : null;
            stopIfShutdown(e);
            if (e?.kind === "interrupted") {
              // The session is unusable now; the next database gets a fresh one.
              await session.close();
              session = null;
            }
            const outcome = await this.dropOutcome(h, r, progress, e, signal);
            stopIfCancelled();
            if (outcome === "gone") await succeed(r, h);
            else await fail(r, h, { message: e?.message ?? "database host error", code: e?.code ?? null, result: outcome });
          }
        }
      } finally {
        await session?.close();
      }
    }
    if (dropped) await ctx.log("info", `Dropped ${dropped} database(s)`);
    return { dropped, failed };
  }
}

/** Sweep fairness: rows of one host handled per run, and hosts handled at a time. */
export const SWEEP_ROWS_PER_HOST = 20;
export const SWEEP_HOST_CONCURRENCY = 4;
