import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { BACKUP_COUNTED_STATUSES, type Backup } from "@blockforge/contracts";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import type { Logger } from "pino";
import type { AgentGateway } from "../agents/gateway.js";
import { commandErrorToHttp } from "../agents/errors.js";
import type { TransferBroker } from "../agents/transfers.js";
import { actorUserId, type AuditActor, type AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { backups, users } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { BrowserTransfers } from "../files/browser-transfers.js";
import type { JobRunner } from "../jobs/runner.js";
import type { Clock } from "../lib/clock.js";
import { AppError, conflict, forbidden, notFound } from "../lib/errors.js";
import type { RealtimeHub } from "../realtime/hub.js";
import type { ServerAccess, ServerAccessService } from "../servers/access.js";
import type { ServerStateService } from "../servers/state.js";
import { BACKUP_JOBS } from "./jobs.js";
import { PRESIGN_DOWNLOAD_TTL_S, StorageError, type BackupStorage } from "./storage.js";

type Row = typeof backups.$inferSelect;
/** Backups that count toward `backupLimit` (failed ones do not). */
const COUNTED: string[] = [...BACKUP_COUNTED_STATUSES];

export interface BackupsDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  audit: AuditService;
  hub: RealtimeHub;
  gateway: AgentGateway;
  jobs: JobRunner;
  storage: BackupStorage;
  access: ServerAccessService;
  state: ServerStateService;
  browser: BrowserTransfers;
  transfers: TransferBroker;
}

export interface CreateOptions {
  name?: string | undefined;
  ignore: string[];
  locked: boolean;
  stopServer: boolean;
  rotate: boolean;
  /** Set for scheduled backups. */
  scheduleId?: string | null;
}

const archiveName = (b: Pick<Row, "name" | "id">) => `${(b.name || "backup").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}-${b.id.slice(0, 8)}.tar.gz`;

/**
 * Server backups (api.md "Backups"): limits and rotation, the `backup`/`restore` operation locks,
 * local or S3 storage, downloads and realtime `backup.updated` on `server:<id>`.
 */
export class BackupsService {
  constructor(private readonly d: BackupsDeps) {}

  private async toDtos(rows: Row[]): Promise<Backup[]> {
    const ids = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => Boolean(x)))];
    const names = new Map<string, string>();
    if (ids.length) for (const u of await this.d.db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids))) names.set(u.id, u.username);
    return rows.map((r) => ({
      id: r.id,
      serverId: r.serverId,
      name: r.name,
      status: r.status as Backup["status"],
      locked: r.locked,
      storage: r.storage as Backup["storage"],
      consistency: (r.consistency as Backup["consistency"]) ?? null,
      sizeBytes: r.sizeBytes,
      sha256: r.sha256,
      ignored: r.ignored,
      skippedSymlinks: r.skippedSymlinks,
      error: r.error,
      createdBy: r.createdBy,
      createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
      scheduleId: r.scheduleId,
      jobId: r.jobId,
      createdAt: r.createdAt.getTime(),
      completedAt: r.completedAt?.getTime() ?? null,
    }));
  }

  private async rowOf(serverId: string, backupId: string): Promise<Row> {
    const [r] = await this.d.db.select().from(backups).where(and(eq(backups.id, backupId), eq(backups.serverId, serverId))).limit(1);
    if (!r) throw notFound("Backup");
    return r;
  }

  async list(access: ServerAccess): Promise<Backup[]> {
    return this.toDtos(await this.d.db.select().from(backups).where(eq(backups.serverId, access.server.id)).orderBy(desc(backups.createdAt)));
  }

  /** `backup.updated` to subscribers of `server:<id>` who may view the server's backups. */
  async publish(backupId: string): Promise<void> {
    const [r] = await this.d.db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
    if (!r) return;
    const topic = `server:${r.serverId}`;
    const clients = this.d.hub.subscribers(topic);
    if (!clients.length) return;
    const [dto] = await this.toDtos([r]);
    for (const c of clients) {
      const a = await this.d.access.load(r.serverId, c.principal).catch(() => null);
      if (a?.permissions.has("servers.backups.view")) this.d.hub.sendTo(c, topic, "backup.updated", dto);
    }
  }

  /** `backup.deleted` on `server:<id>` (rotation, deletion). */
  async publishDeleted(serverId: string, backupId: string): Promise<void> {
    const topic = `server:${serverId}`;
    for (const c of this.d.hub.subscribers(topic)) {
      const a = await this.d.access.load(serverId, c.principal).catch(() => null);
      if (a?.permissions.has("servers.backups.view")) this.d.hub.sendTo(c, topic, "backup.deleted", { serverId, backupId });
    }
  }

  /**
   * Limit check: `backupLimit` 0 disables backups for non-administrators; at the limit, `rotate`
   * picks the oldest unlocked completed backup (deleted by the job), otherwise 409.
   */
  private async limitCheck(access: ServerAccess, rotate: boolean, extra = 0): Promise<{ rotateBackupId: string | null }> {
    if (access.permissions.has("servers.admin")) return { rotateBackupId: null };
    const limit = access.server.backupLimit;
    if (limit === 0) throw forbidden("Backups are disabled for this server");
    const [n] = await this.d.db.select({ n: count() }).from(backups).where(and(eq(backups.serverId, access.server.id), inArray(backups.status, COUNTED)));
    if (Number(n?.n ?? 0) + extra < limit) return { rotateBackupId: null };
    if (!rotate) throw conflict(`The server has reached its backup limit (${limit})`, { limit });
    const [oldest] = await this.d.db
      .select({ id: backups.id })
      .from(backups)
      .where(and(eq(backups.serverId, access.server.id), eq(backups.locked, false), eq(backups.status, "completed")))
      .orderBy(asc(backups.createdAt))
      .limit(1);
    if (!oldest) throw conflict(`The server has reached its backup limit (${limit}) and every backup is locked`, { limit });
    return { rotateBackupId: oldest.id };
  }

  async create(access: ServerAccess, opts: CreateOptions, actor: AuditActor): Promise<{ backup: Backup; jobId: string }> {
    const { rotateBackupId } = await this.limitCheck(access, opts.rotate);
    const stored = await this.d.storage.view();
    const now = new Date(this.d.clock.now());
    const id = randomUUID();
    const serverId = access.server.id;
    const name = opts.name?.trim() || `Backup ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const jobId = await withTransaction(this.d.db, async (tx, after) => {
      const { from } = await this.d.state.begin(tx, serverId, "backup");
      await tx.insert(backups).values({
        id,
        serverId,
        name,
        status: "pending",
        locked: opts.locked,
        storage: stored.type,
        ignored: opts.ignore,
        // Schedule-created backups have no creating user (contract).
        createdBy: opts.scheduleId ? null : actorUserId(actor),
        scheduleId: opts.scheduleId ?? null,
        createdAt: now,
      });
      const job = await this.d.jobs.enqueue(
        BACKUP_JOBS.create,
        { serverId, backupId: id, stopServer: opts.stopServer, rotateBackupId, fromState: from },
        { targetType: "server", targetId: serverId, requestedBy: actorUserId(actor) },
        tx,
        after,
      );
      await tx.update(backups).set({ jobId: job }).where(eq(backups.id, id));
      await this.d.state.attachJob(tx, serverId, job);
      await this.d.audit.record(
        {
          ...actor,
          action: "server.backup.create",
          targetType: "server",
          targetId: serverId,
          outcome: "success",
          details: { backupId: id, name, storage: stored.type, locked: opts.locked, stopServer: opts.stopServer, rotated: rotateBackupId, scheduleId: opts.scheduleId ?? null, jobId: job },
        },
        tx,
      );
      after.add(() => this.d.state.notify(serverId));
      return job;
    });
    void this.publish(id);
    const [dto] = await this.toDtos([await this.rowOf(serverId, id)]);
    return { backup: dto!, jobId };
  }

  async update(access: ServerAccess, backupId: string, input: { name?: string | undefined; locked?: boolean | undefined }, actor: AuditActor): Promise<Backup> {
    const r = await this.rowOf(access.server.id, backupId);
    const set: Partial<Row> = {};
    if (input.name !== undefined) set.name = input.name.trim() || r.name;
    if (input.locked !== undefined) set.locked = input.locked;
    if (Object.keys(set).length) {
      await this.d.db.update(backups).set(set).where(eq(backups.id, r.id));
      await this.d.audit.record({ ...actor, action: "server.backup.update", targetType: "server", targetId: access.server.id, outcome: "success", details: { backupId, ...set } });
      void this.publish(r.id);
    }
    const [dto] = await this.toDtos([await this.rowOf(access.server.id, backupId)]);
    return dto!;
  }

  async remove(access: ServerAccess, backupId: string, actor: AuditActor): Promise<{ jobId: string }> {
    const r = await this.rowOf(access.server.id, backupId);
    if (r.locked) throw conflict("The backup is locked; unlock it first");
    if (r.status === "pending" || r.status === "running" || r.status === "uploading") throw conflict("The backup is still being created");
    if (access.server.activeOperation === "restore") throw conflict("A restore is in progress");
    const jobId = await this.d.jobs.enqueue(BACKUP_JOBS.remove, { serverId: access.server.id, backupId }, { targetType: "server", targetId: access.server.id, requestedBy: actorUserId(actor) });
    await this.d.audit.record({ ...actor, action: "server.backup.delete", targetType: "server", targetId: access.server.id, outcome: "success", details: { backupId, name: r.name, jobId } });
    return { jobId };
  }

  /** Local: single-use transfer URL streamed from the agent; S3: presigned GET (5 minutes). */
  async downloadUrl(access: ServerAccess, backupId: string, binding: string, actor: AuditActor): Promise<{ url: string; expiresAt: number }> {
    const r = await this.rowOf(access.server.id, backupId);
    if (r.status !== "completed") throw conflict("The backup is not complete");
    await this.d.audit.record({ ...actor, action: "server.backup.download", targetType: "server", targetId: access.server.id, outcome: "success", details: { backupId, storage: r.storage } });
    if (r.storage === "s3") {
      const cfg = await this.d.storage.current();
      if (cfg.type !== "s3" || !r.objectKey) throw new AppError(409, "PRECONDITION_FAILED", "The backup's object storage is not configured");
      const url = await this.d.storage.presignGet(cfg, r.objectKey, PRESIGN_DOWNLOAD_TTL_S, archiveName(r)).catch((err: unknown) => {
        throw new AppError(502, "UPSTREAM_ERROR", err instanceof StorageError ? err.message : "presigning failed");
      });
      return { url, expiresAt: this.d.clock.now() + PRESIGN_DOWNLOAD_TTL_S * 1000 };
    }
    const t = this.d.browser.issue({
      direction: "download",
      sessionId: binding,
      userId: access.principal.userId,
      serverId: access.server.id,
      nodeId: access.server.nodeId,
      path: archiveName(r),
      maxBytes: r.sizeBytes ?? 512 * 1024 ** 3,
      backupId: r.id,
    });
    return { url: `/api/v1/transfers/${t.token}`, expiresAt: t.expiresAt };
  }

  /** Streams a local archive (`backup.transfer.push`) into the HTTP response. */
  async streamLocal(access: ServerAccess, backupId: string, maxBytes: number, actor: AuditActor): Promise<Readable> {
    const r = await this.rowOf(access.server.id, backupId);
    if (r.status !== "completed" || r.storage !== "local") throw notFound("Backup");
    const transferId = randomUUID();
    const nodeId = access.server.nodeId;
    const incoming = this.d.transfers.expectUpload({ id: transferId, nodeId, maxBytes });
    const pushed = this.d.gateway.send(nodeId, "backup.transfer.push", { workloadId: r.serverId, backupId: r.id, transferId }, { userId: actorUserId(actor), timeoutMs: 15 * 60_000 });
    const first = await Promise.race([incoming.then((s) => ({ stream: s })), pushed.then(() => ({ stream: null }), (err: unknown) => ({ error: err }))]);
    if ("error" in first) {
      this.d.transfers.cancel(transferId);
      throw commandErrorToHttp(first.error);
    }
    const stream = first.stream ?? (await incoming);
    pushed.catch((err: unknown) => stream.destroy(err instanceof Error ? err : new Error(String(err))));
    return stream;
  }

  async restore(access: ServerAccess, backupId: string, req: { truncate: boolean; safetyBackup: boolean; startAfter: boolean }, actor: AuditActor): Promise<{ jobId: string }> {
    const r = await this.rowOf(access.server.id, backupId);
    if (r.status !== "completed") throw conflict("Only completed backups can be restored");
    let safetyBackupId: string | null = null;
    let safetySkippedReason: string | null = null;
    if (req.safetyBackup) {
      try {
        await this.limitCheck(access, false);
        safetyBackupId = randomUUID();
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        safetySkippedReason = err.message;
      }
    }
    const stored = await this.d.storage.view();
    const now = new Date(this.d.clock.now());
    const serverId = access.server.id;
    const jobId = await withTransaction(this.d.db, async (tx, after) => {
      await this.d.state.begin(tx, serverId, "restore");
      if (safetyBackupId) {
        await tx.insert(backups).values({
          id: safetyBackupId,
          serverId,
          name: `Safety backup before restoring "${r.name}"`.slice(0, 120),
          status: "pending",
          locked: true,
          storage: stored.type,
          ignored: [],
          createdBy: actorUserId(actor),
          createdAt: now,
        });
      }
      const job = await this.d.jobs.enqueue(
        BACKUP_JOBS.restore,
        { serverId, backupId, truncate: req.truncate, startAfter: req.startAfter, safetyBackupId, safetySkippedReason },
        { targetType: "server", targetId: serverId, requestedBy: actorUserId(actor) },
        tx,
        after,
      );
      if (safetyBackupId) await tx.update(backups).set({ jobId: job }).where(eq(backups.id, safetyBackupId));
      await this.d.state.attachJob(tx, serverId, job);
      await this.d.audit.record(
        { ...actor, action: "server.backup.restore", targetType: "server", targetId: serverId, outcome: "success", details: { backupId, name: r.name, ...req, safetyBackupId, jobId: job } },
        tx,
      );
      after.add(() => this.d.state.notify(serverId));
      return job;
    });
    if (safetyBackupId) void this.publish(safetyBackupId);
    return { jobId };
  }

  /** Completed backups (not failed) count; used by tests and the UI summary. */
  async countActive(serverId: string): Promise<number> {
    const [n] = await this.d.db.select({ n: count() }).from(backups).where(and(eq(backups.serverId, serverId), ne(backups.status, "failed")));
    return Number(n?.n ?? 0);
  }
}
