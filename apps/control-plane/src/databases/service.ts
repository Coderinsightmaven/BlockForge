import { randomUUID } from "node:crypto";
import type { CreateServerDatabaseRequest, ServerDatabase } from "@blockforge/contracts";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { actorUserId, type AuditActor, type AuditService } from "../audit/service.js";
import type { Db, Tx } from "../db/client.js";
import { databaseHosts, serverDatabases, servers } from "../db/schema/index.js";
import { pgErrorCode } from "../http/errors.js";
import type { Clock } from "../lib/clock.js";
import { AppError, conflict, forbidden, invalidState, notFound, unprocessable } from "../lib/errors.js";
import type { SecretBox } from "../secrets/secret-box.js";
import type { ServerAccess } from "../servers/access.js";
import { shortId } from "../servers/dto.js";
import { hostError, type DatabaseHostsService, type HostRow } from "./hosts.js";
import { DatabaseHostError, type MysqlConnector, type Run } from "./mysql.js";
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
  /** After this long an operation claim counts as abandoned (process crash) and may be taken over. */
  operationStaleMs?: number;
}

/**
 * Longest a create/rotate/delete can talk to a host: connect 10 s + up to 4 statements × 15 s + close 2 s
 * ≈ 72 s with the default timeouts. Claims older than 5 minutes are therefore abandoned.
 */
export const DEFAULT_OPERATION_STALE_MS = 5 * 60_000;

type Operation = "creating" | "rotating" | "deleting";
const busy = () => conflict("Another operation on this database is still in progress; try again in a moment", { reason: "busy" });

/** Job-log callback of the server delete job. */
type JobLog = (level: "info" | "warn" | "error", message: string) => Promise<void>;

const SYSTEM_JOB: AuditActor = { actorType: "system", actorId: null, actorName: "job" };

/**
 * Per-server MySQL databases (api.md "Databases"): limits, host selection, creation of the database and
 * its single-database account, password reveal/rotation and deletion. Every statement comes from
 * `sql.ts` (validated + quoted); passwords are generated here and stored encrypted.
 *
 * No transaction (and so no pooled Postgres connection or row lock) is ever held while a host is contacted:
 * every host operation claims the row in a short transaction (`operation` + `operation_token`), talks to
 * the host, then persists the outcome in a second short transaction conditional on still holding the claim.
 * A second create/rotate/delete of the same database meanwhile gets 409 `busy`.
 */
export class ServerDatabasesService {
  private readonly staleMs: number;
  private readonly newUsername: (serverShortId: string) => string;

  constructor(private readonly d: ServerDatabasesDeps) {
    this.staleMs = d.operationStaleMs ?? DEFAULT_OPERATION_STALE_MS;
    this.newUsername = d.generateUsername ?? generateUsername;
  }

  /** Short transaction: lock the row, refuse a live claim of another operation, record ours. */
  private async claim(serverId: string, databaseId: string, op: Operation): Promise<{ r: Row; h: HostRow; token: string }> {
    const token = randomUUID();
    const now = this.d.clock.now();
    return this.d.db.transaction(async (tx) => {
      const { r, h } = await this.rowOf(serverId, databaseId, tx, true);
      if (r.operation !== null && r.operationStartedAt !== null && now - r.operationStartedAt.getTime() < this.staleMs) throw busy();
      if (r.operation !== null) this.d.logger.warn({ databaseId, operation: r.operation }, "taking over an abandoned database operation claim");
      await tx.update(serverDatabases).set({ operation: op, operationToken: token, operationStartedAt: new Date(now) }).where(eq(serverDatabases.id, r.id));
      return { r, h, token };
    });
  }

  /** Releases a claim (no-op when it was taken over or the row is gone). Never throws. */
  private async release(databaseId: string, token: string): Promise<void> {
    await this.d.db
      .update(serverDatabases)
      .set({ operation: null, operationToken: null, operationStartedAt: null })
      .where(and(eq(serverDatabases.id, databaseId), eq(serverDatabases.operationToken, token)))
      .catch((err: unknown) => this.d.logger.warn({ databaseId, code: pgErrorCode(err) }, "could not release a database operation claim (it expires on its own)"));
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

  private async rowOf(serverId: string, databaseId: string, tx: Db | Tx = this.d.db, lock = false): Promise<{ r: Row; h: HostRow }> {
    const q = tx
      .select({ r: serverDatabases, h: databaseHosts })
      .from(serverDatabases)
      .innerJoin(databaseHosts, eq(databaseHosts.id, serverDatabases.hostId))
      .where(and(eq(serverDatabases.id, databaseId), eq(serverDatabases.serverId, serverId)))
      .limit(1);
    const [row] = lock ? await q.for("update", { of: serverDatabases }) : await q;
    if (!row) throw notFound("Database");
    return row;
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

    // 1. Reserve: limits, host capacity and names are checked and the row inserted (claimed as `creating`)
    //    in one short transaction; the host is contacted only after it committed.
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
        const now = new Date(this.d.clock.now());
        await tx.insert(serverDatabases).values({
          id,
          serverId: server.id,
          hostId: h.id,
          databaseName: database,
          username: user,
          remote,
          passwordEnc: this.d.box.encryptToString(password, dbAad(id)),
          createdBy: actorUserId(actor),
          createdAt: now,
          operation: "creating",
          operationToken: token,
          operationStartedAt: now,
        });
        return { host: h, username: user };
      }));
    } catch (err) {
      if (pgErrorCode(err) === "23505") throw conflict("A database with this name already exists on the host", { reason: "name_taken" });
      throw err;
    }

    // 2. Create the database, the account and the grant on the host; undo only what this request created.
    const created = { database: false, user: false };
    try {
      await this.d.connector.withConnection(
        this.d.hosts.connectionOf(host),
        async (run) => {
          await run(createDatabaseSql(database));
          created.database = true;
          await run(createUserSql(username, remote, password));
          created.user = true;
          const [partialRevokes] = (await run(PARTIAL_REVOKES_SQL)) as { Value?: unknown }[];
          const literalGrantNames = String(partialRevokes?.Value ?? "").toUpperCase() === "ON";
          await run(grantSql(database, username, remote, !literalGrantNames));
        },
        [password],
      );
    } catch (err) {
      // Only what this request created is removed: a pre-existing database or account of the same name
      // (ER_DB_CREATE_EXISTS / ER_CANNOT_USER) is never touched.
      await this.undoCreate(host, database, username, remote, created);
      await this.d.db.delete(serverDatabases).where(and(eq(serverDatabases.id, id), eq(serverDatabases.operationToken, token)));
      const e = err instanceof DatabaseHostError ? err : null;
      await this.d.audit.record({
        ...actor,
        action: "server.database.create",
        targetType: "server",
        targetId: server.id,
        outcome: "failed",
        details: { database, username, hostId: host.id, hostName: host.name, remote, error: e?.message ?? "failed", code: e?.code ?? null },
      });
      if (e?.code === "ER_DB_CREATE_EXISTS") throw conflict("A database with this name already exists on the host", { reason: "name_taken" });
      if (e) throw hostError(e.message, e.code);
      throw err;
    }

    // 3. Release the claim. The row may have been removed meanwhile (server deleted): then nothing may stay
    //    behind on the host either.
    const [still] = await this.d.db
      .update(serverDatabases)
      .set({ operation: null, operationToken: null, operationStartedAt: null })
      .where(and(eq(serverDatabases.id, id), eq(serverDatabases.operationToken, token)))
      .returning();
    if (!still) {
      const [exists] = await this.d.db.select({ id: serverDatabases.id }).from(serverDatabases).where(eq(serverDatabases.id, id)).limit(1);
      // Gone (server deleted meanwhile): remove what we created. Still there under another claim (taken over
      // as abandoned): that operation owns it now.
      if (!exists) await this.undoCreate(host, database, username, remote, created);
      throw invalidState(exists ? "Another operation took over this database while it was being created" : "The database was deleted while it was being created");
    }
    await this.d.audit.record({
      ...actor,
      action: "server.database.create",
      targetType: "server",
      targetId: server.id,
      outcome: "success",
      details: { databaseId: id, database, username, hostId: host.id, hostName: host.name, remote },
    });
    return this.toDto(still, host);
  }

  private async undoCreate(host: HostRow, database: string, username: string, remote: string, created: { database: boolean; user: boolean }): Promise<void> {
    if (!created.database && !created.user) return;
    try {
      await this.d.connector.withConnection(this.d.hosts.connectionOf(host), async (run) => {
        if (created.user) await run(dropUserSql(username, remote));
        if (created.database) await run(dropDatabaseSql(database));
      });
    } catch (err) {
      const e = err instanceof DatabaseHostError ? err : null;
      this.d.logger.warn({ hostId: host.id, database, code: e?.code ?? null, reason: e?.message ?? "failed" }, "could not undo a partially created database");
    }
  }

  /** Plaintext password (audited; the route answers with `Cache-Control: no-store`). */
  async password(access: ServerAccess, databaseId: string, actor: AuditActor): Promise<{ password: string }> {
    const { r } = await this.rowOf(access.server.id, databaseId);
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

  /** Host failure of a claimed operation: release the claim, audit, map to 502 (other errors pass through). */
  private async failClaimed(err: unknown, databaseId: string, token: string, action: string, actor: AuditActor, serverId: string): Promise<never> {
    await this.release(databaseId, token);
    if (err instanceof DatabaseHostError) {
      await this.d.audit.record({ ...actor, action, targetType: "server", targetId: serverId, outcome: "failed", details: { databaseId, error: err.message, code: err.code } });
      throw hostError(err.message, err.code);
    }
    throw err;
  }

  /**
   * New password: claim (short transaction) → `ALTER USER` on the host (no transaction open) → store the new
   * password and release the claim (short transaction, conditional on the claim). A host failure releases the
   * claim and keeps the old password everywhere (502). Narrow window: if the host applied `ALTER USER` but its
   * answer was lost (timeout) or the new password could not be stored afterwards, the stored password is
   * stale until the next successful rotation — rotating again always fixes it, since every rotation sets the
   * password from scratch.
   */
  async rotate(access: ServerAccess, databaseId: string, actor: AuditActor): Promise<ServerDatabase> {
    const password = generatePassword();
    const { r, h, token } = await this.claim(access.server.id, databaseId, "rotating");
    try {
      await this.d.connector.withConnection(this.d.hosts.connectionOf(h), (run) => run(alterUserPasswordSql(r.username, r.remote, password)), [password]);
    } catch (err) {
      return this.failClaimed(err, r.id, token, "server.database.rotate_password", actor, access.server.id);
    }
    const now = new Date(this.d.clock.now());
    let stored: Row | undefined;
    try {
      stored = await this.d.db.transaction(async (tx) => {
        const [row] = await tx
          .update(serverDatabases)
          .set({ passwordEnc: this.d.box.encryptToString(password, dbAad(r.id)), passwordRotatedAt: now, operation: null, operationToken: null, operationStartedAt: null })
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
      await this.release(r.id, token);
      throw err;
    }
    if (!stored) {
      // The row went away (server deletion) or the claim was taken over while the host was contacted.
      await this.d.audit.record({
        ...actor,
        action: "server.database.rotate_password",
        targetType: "server",
        targetId: access.server.id,
        outcome: "failed",
        details: { databaseId: r.id, error: "the database changed while its password was being rotated" },
      });
      throw conflict("The database changed while its password was being rotated; try again", { reason: "busy" });
    }
    return this.toDto(stored, h);
  }

  /**
   * Claim → drop the database and its account on the host (no transaction open) → delete the row. A host
   * failure releases the claim and keeps the row (502; retry). If the row cannot be deleted afterwards the
   * claim is released and a retry drops again (`IF EXISTS`, idempotent) and deletes it.
   */
  async remove(access: ServerAccess, databaseId: string, actor: AuditActor): Promise<void> {
    const { r, h, token } = await this.claim(access.server.id, databaseId, "deleting");
    try {
      await this.d.connector.withConnection(this.d.hosts.connectionOf(h), (run) => this.drop(run, r));
    } catch (err) {
      return this.failClaimed(err, r.id, token, "server.database.delete", actor, access.server.id);
    }
    try {
      await this.d.db.transaction(async (tx) => {
        // Already gone (server deletion dropped it meanwhile) is fine: the database is dropped either way.
        await tx.delete(serverDatabases).where(and(eq(serverDatabases.id, r.id), eq(serverDatabases.operationToken, token)));
        await this.d.audit.record(
          { ...actor, action: "server.database.delete", targetType: "server", targetId: access.server.id, outcome: "success", details: { databaseId: r.id, database: r.databaseName, username: r.username, hostId: h.id, hostName: h.name } },
          tx,
        );
      });
    } catch (err) {
      await this.release(r.id, token);
      throw err;
    }
  }

  private async drop(run: Run, r: Pick<Row, "databaseName" | "username" | "remote">): Promise<void> {
    await run(dropDatabaseSql(r.databaseName));
    await run(dropUserSql(r.username, r.remote));
  }

  /**
   * Server deletion (best effort, recorded): drops every database of the server on its host and deletes
   * the rows that were dropped. Failures are written to the job log and audited (`outcome: failed`, with
   * host and database name so an administrator can drop them by hand); the remaining rows go with the
   * server. Never throws.
   */
  async dropAllForServer(serverId: string, ctx: { jobId: string; log: JobLog }): Promise<{ dropped: number; failed: number }> {
    const rows = await this.d.db
      .select({ r: serverDatabases, h: databaseHosts })
      .from(serverDatabases)
      .innerJoin(databaseHosts, eq(databaseHosts.id, serverDatabases.hostId))
      .where(eq(serverDatabases.serverId, serverId));
    const byHost = new Map<string, { h: HostRow; rows: Row[] }>();
    for (const { r, h } of rows) {
      const g = byHost.get(h.id) ?? { h, rows: [] };
      g.rows.push(r);
      byHost.set(h.id, g);
    }
    let dropped = 0;
    let failed = 0;
    const record = async (r: Row, h: HostRow, error: DatabaseHostError | null) => {
      await this.d.audit.record({
        ...SYSTEM_JOB,
        action: "server.database.delete",
        targetType: "server",
        targetId: serverId,
        outcome: error ? "failed" : "success",
        details: { databaseId: r.id, database: r.databaseName, username: r.username, hostId: h.id, hostName: h.name, host: `${h.host}:${h.port}`, reason: "server_deleted", jobId: ctx.jobId, ...(error ? { error: error.message, code: error.code } : {}) },
      });
    };
    for (const { h, rows: list } of byHost.values()) {
      const done: Row[] = [];
      const errors = new Map<string, DatabaseHostError>();
      try {
        await this.d.connector.withConnection(this.d.hosts.connectionOf(h), async (run) => {
          for (const r of list) {
            try {
              await this.drop(run, r);
              done.push(r);
            } catch (err) {
              if (!(err instanceof DatabaseHostError) || err.connectFailed) throw err;
              errors.set(r.id, err);
            }
          }
        });
      } catch (err) {
        const e = err instanceof DatabaseHostError ? err : new DatabaseHostError(null, "database host error", true);
        for (const r of list) if (!done.includes(r) && !errors.has(r.id)) errors.set(r.id, e);
      }
      if (done.length) await this.d.db.delete(serverDatabases).where(inArray(serverDatabases.id, done.map((r) => r.id)));
      for (const r of done) {
        dropped++;
        await record(r, h, null);
      }
      for (const r of list) {
        const e = errors.get(r.id);
        if (!e) continue;
        failed++;
        await record(r, h, e);
        await ctx.log("warn", `Database ${r.databaseName} on ${h.name} (${h.host}:${h.port}) could not be dropped: ${e.message}. Drop it and user ${r.username} by hand.`);
      }
    }
    if (dropped) await ctx.log("info", `Dropped ${dropped} database(s)`);
    return { dropped, failed };
  }
}
