import type { ServerState, WorkloadStatus } from "@blockforge/contracts";
import { isSaveConfirmation } from "@blockforge/minecraft";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { AgentCommandError } from "../agents/gateway.js";
import type { ConsoleLine } from "../agents/console-buffer.js";
import { backups, servers } from "../db/schema/index.js";
import { JobError, SKIP_STEP, type FinalizeContext, type JobDefinition, type StepContext } from "../jobs/types.js";
import { exitColumns, settleFromRuntime, startServerAndWait, stopWorkload, type ServerJobDeps } from "../servers/jobs.js";
import { loadRuntimeContext, minecraftGame } from "../servers/runtime.js";
import { StorageError, type BackupStorage, type S3Config } from "./storage.js";

export const BACKUP_JOBS = { create: "server.backup", restore: "server.backup.restore", remove: "server.backup.delete" } as const;

/** Archive size limit sent to the agent (contract maximum). */
const MAX_ARCHIVE_BYTES = 512 * 1024 ** 3;
const ARCHIVE_TIMEOUT_MS = 6 * 3600_000;

export interface BackupJobDeps extends ServerJobDeps {
  storage: BackupStorage;
  /** Publishes `backup.updated` for a backup row. */
  publish(backupId: string): Promise<void>;
  /** Publishes `backup.deleted`. */
  publishDeleted(serverId: string, backupId: string): Promise<void>;
  /** How long to wait for "Saved the game" after `save-all flush`. */
  saveTimeoutMs?: number;
}

type BackupRow = typeof backups.$inferSelect;
type Ctx<I> = StepContext<I>;

/** Save confirmation after `save-all flush` (vanilla/Paper/Forge, 26.x "System chat:" prefix) — from @blockforge/minecraft. */
export { isSaveConfirmation };

function wrap(err: unknown, what: string): never {
  if (err instanceof AgentCommandError) throw new JobError(err.code, `${what}: ${err.message}`, err.retryable);
  if (err instanceof StorageError) throw new JobError("STORAGE_ERROR", `${what}: ${err.message}`);
  throw err;
}

async function row(deps: BackupJobDeps, backupId: string): Promise<BackupRow> {
  const [r] = await deps.db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
  if (!r) throw new JobError("NOT_FOUND", "the backup no longer exists");
  return r;
}

async function setRow(deps: BackupJobDeps, backupId: string, set: Partial<BackupRow>): Promise<void> {
  await deps.db.update(backups).set(set).where(eq(backups.id, backupId));
  await deps.publish(backupId).catch(() => undefined);
}

async function workloadStatus(deps: BackupJobDeps, nodeId: string, serverId: string, signal?: AbortSignal): Promise<WorkloadStatus | null> {
  if (!deps.gateway.isReady(nodeId)) throw new JobError("NODE_UNAVAILABLE", "the server's node is not connected", true);
  const r = await deps.gateway.send(nodeId, "workload.status", { workloadId: serverId }, { timeoutMs: 15_000, ...(signal ? { signal } : {}) }).catch((err: unknown) => wrap(err, "workload.status"));
  return r.workloads.find((w) => w.workloadId === serverId) ?? null;
}

const isRunning = (st: WorkloadStatus | null) => st?.state === "running" || st?.state === "restarting";

/** Waits for a console line matching `match` (ts ≥ since). */
function waitForConsole(deps: BackupJobDeps, serverId: string, since: number, match: (line: string) => boolean, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.gateway.off("consoleLines", onLines);
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const check = (lines: readonly ConsoleLine[]) => {
      if (lines.some((l) => l.ts >= since && l.stream !== "system" && match(l.line))) done(true);
    };
    const onLines = (id: string, lines: ConsoleLine[]) => {
      if (id === serverId) check(lines);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    deps.gateway.on("consoleLines", onLines);
    signal.addEventListener("abort", onAbort, { once: true });
    check(deps.consoles.tail(serverId, 2000).lines);
  });
}

async function consoleCommand(deps: BackupJobDeps, nodeId: string, serverId: string, line: string, opts: { jobId?: string; signal?: AbortSignal } = {}): Promise<void> {
  await deps.gateway.send(nodeId, "workload.console", { workloadId: serverId, line }, { timeoutMs: 15_000, ...opts });
}

/** `backup.create` for a row; records size, sha256 and skipped symlinks. */
export async function archiveBackup(deps: BackupJobDeps, ctx: { jobId: string; signal: AbortSignal; log: Ctx<unknown>["log"] }, b: BackupRow, nodeId: string): Promise<BackupRow> {
  await setRow(deps, b.id, { status: "running" });
  const started = deps.clock.now();
  const r = await deps.gateway
    .send(nodeId, "backup.create", { workloadId: b.serverId, backupId: b.id, ignore: b.ignored, maxBytes: MAX_ARCHIVE_BYTES }, { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 900_000, resultTimeoutMs: ARCHIVE_TIMEOUT_MS })
    .catch((err: unknown) => wrap(err, "backup.create"));
  await ctx.log("info", `Archived ${r.files} files (${r.sizeBytes} bytes, sha256 ${r.sha256}) in ${Math.round((r.durationMs || deps.clock.now() - started) / 1000)} s`);
  if (r.skippedSymlinks) await ctx.log("warn", `${r.skippedSymlinks} symbolic link(s) were not archived`);
  await setRow(deps, b.id, { sizeBytes: r.sizeBytes, sha256: r.sha256, skippedSymlinks: r.skippedSymlinks });
  return { ...b, sizeBytes: r.sizeBytes, sha256: r.sha256, skippedSymlinks: r.skippedSymlinks };
}

/**
 * S3: presigned multipart upload by the agent, completed here with its ETags, verified by size, then
 * the local archive is deleted. The multipart upload is aborted on any failure.
 */
export async function uploadBackup(
  deps: BackupJobDeps,
  ctx: { jobId: string; signal: AbortSignal; log: Ctx<unknown>["log"]; state?: Record<string, unknown> },
  b: BackupRow,
  nodeId: string,
  cfg: S3Config,
): Promise<string> {
  if (b.sizeBytes === null) throw new JobError("INTERNAL", "the archive size is unknown");
  await setRow(deps, b.id, { status: "uploading" });
  const key = deps.storage.objectKey(cfg, b.serverId, b.id);
  const mp = await deps.storage.startMultipart(cfg, key, b.sizeBytes).catch((err: unknown) => wrap(err, "upload"));
  if (ctx.state) ctx.state.multipart = { key, uploadId: mp.uploadId };
  try {
    await ctx.log("info", `Uploading to object storage in ${mp.parts.length} part(s) of ${Math.round(mp.partSize / 1024 ** 2)} MiB`);
    const r = await deps.gateway
      .send(nodeId, "backup.upload", { workloadId: b.serverId, backupId: b.id, partSize: mp.partSize, parts: mp.parts, deleteLocal: false }, { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 900_000, resultTimeoutMs: ARCHIVE_TIMEOUT_MS })
      .catch((err: unknown) => wrap(err, "backup.upload"));
    if (r.parts.length !== mp.parts.length) throw new JobError("UPLOAD_FAILED", `the agent uploaded ${r.parts.length} of ${mp.parts.length} parts`);
    await deps.storage.completeMultipart(cfg, key, mp.uploadId, r.parts).catch((err: unknown) => wrap(err, "upload"));
  } catch (err) {
    await deps.storage.abortMultipart(cfg, key, mp.uploadId).catch(() => undefined);
    if (ctx.state) delete ctx.state.multipart;
    throw err;
  }
  if (ctx.state) delete ctx.state.multipart;
  const size = await deps.storage.objectSize(cfg, key).catch((err: unknown) => wrap(err, "verification"));
  if (size !== b.sizeBytes) {
    await deps.storage.deleteObject(cfg, key).catch(() => undefined);
    throw new JobError("UPLOAD_FAILED", `the uploaded object has ${size ?? "no"} bytes, expected ${b.sizeBytes}`);
  }
  await deps.gateway.send(nodeId, "backup.delete", { workloadId: b.serverId, backupId: b.id }, { jobId: ctx.jobId, timeoutMs: 60_000 }).catch(async (err: unknown) => {
    await ctx.log("warn", `The local copy could not be removed: ${(err as Error).message}`);
  });
  await deps.db.update(backups).set({ objectKey: key }).where(eq(backups.id, b.id));
  await ctx.log("info", "Upload verified");
  return key;
}

/** Removes a backup's data (S3 object or local archive). Missing data is not an error. */
export async function deleteBackupData(deps: BackupJobDeps, b: BackupRow, nodeId: string, opts: { jobId?: string; signal?: AbortSignal } = {}): Promise<void> {
  if (b.storage === "s3") {
    if (!b.objectKey) return;
    const cfg = await deps.storage.current().catch((err: unknown) => wrap(err, "storage settings"));
    if (cfg.type !== "s3") throw new JobError("STORAGE_ERROR", "the backup is stored in S3 but S3 storage is no longer configured");
    await deps.storage.deleteObject(cfg, b.objectKey).catch((err: unknown) => wrap(err, "delete"));
    return;
  }
  if (!deps.gateway.isReady(nodeId)) throw new JobError("NODE_UNAVAILABLE", "the server's node is not connected", true);
  await deps.gateway.send(nodeId, "backup.delete", { workloadId: b.serverId, backupId: b.id }, { timeoutMs: 60_000, ...opts }).catch((err: unknown) => {
    if (err instanceof AgentCommandError && err.code === "NOT_FOUND") return;
    wrap(err, "backup.delete");
  });
}

type ServerRow = typeof servers.$inferSelect;

/**
 * Minecraft save cycle for a running server: `save-off`, `save-all flush`, wait for the confirmation.
 * Returns the consistency of the archive taken afterwards; `save-on` follows via {@link resumeSaving}
 * (and the job's finalize hook if anything fails in between).
 */
async function saveCycle(deps: BackupJobDeps, ctx: Ctx<unknown>, s: ServerRow): Promise<"save-flush" | "live"> {
  const rt = await loadRuntimeContext(deps.db, s.id);
  if (minecraftGame(rt) !== "java") return "live";
  const since = deps.clock.now();
  ctx.state.saveOff = true;
  await consoleCommand(deps, s.nodeId, s.id, "save-off", { jobId: ctx.jobId, signal: ctx.signal }).catch((err: unknown) => wrap(err, "save-off"));
  await consoleCommand(deps, s.nodeId, s.id, "save-all flush", { jobId: ctx.jobId, signal: ctx.signal }).catch((err: unknown) => wrap(err, "save-all"));
  const saved = await waitForConsole(deps, s.id, since, isSaveConfirmation, deps.saveTimeoutMs ?? 120_000, ctx.signal);
  if (!saved) throw new JobError("SAVE_TIMEOUT", `the server did not confirm "save-all flush" within ${Math.round((deps.saveTimeoutMs ?? 120_000) / 1000)} s`);
  await ctx.log("info", "World saved and automatic saving paused");
  return "save-flush";
}

async function resumeSaving(deps: BackupJobDeps, ctx: Ctx<unknown>, s: ServerRow): Promise<void> {
  if (!ctx.state.saveOff || ctx.state.saveOnSent) return;
  await consoleCommand(deps, s.nodeId, s.id, "save-on", { jobId: ctx.jobId, signal: ctx.signal }).catch((err: unknown) => wrap(err, "save-on"));
  ctx.state.saveOnSent = true;
  await ctx.log("info", "Automatic saving resumed");
}

/** finalize: `save-on` is never skipped, also after a failed or cancelled job. */
async function ensureSaveOn(deps: BackupJobDeps, f: FinalizeContext<{ serverId: string }>, s: ServerRow | undefined): Promise<void> {
  if (!s || !f.state.saveOff || f.state.saveOnSent) return;
  await consoleCommand(deps, s.nodeId, s.id, "save-on", { jobId: f.jobId })
    .then(() => f.log("info", "Automatic saving resumed"))
    .catch((err: unknown) => f.log("error", `save-on could not be sent: ${(err as Error).message}`));
}

const BackupInput = z.object({
  serverId: z.uuid(),
  backupId: z.uuid(),
  stopServer: z.boolean().default(false),
  rotateBackupId: z.uuid().nullable().default(null),
  /** The server's state before the backup (a stopped/crashed server returns to it). */
  fromState: z.string().default("stopped"),
});
const RestoreInput = z.object({
  serverId: z.uuid(),
  backupId: z.uuid(),
  truncate: z.boolean(),
  startAfter: z.boolean(),
  /** Decided at request time (limit and permissions of the requester). */
  safetyBackupId: z.uuid().nullable(),
  safetySkippedReason: z.string().nullable().default(null),
});
const DeleteInput = z.object({ serverId: z.uuid(), backupId: z.uuid() });

/** A minimal step context for best-effort work in finalize hooks. */
function finalizeCtx(f: FinalizeContext<{ serverId: string }>, timeoutMs: number): Ctx<{ serverId: string }> {
  return {
    jobId: f.jobId,
    input: { serverId: f.input.serverId },
    attempt: 1,
    targetType: "server",
    targetId: f.input.serverId,
    requestedBy: null,
    signal: AbortSignal.timeout(timeoutMs),
    state: {},
    log: f.log,
    setMessage: async () => undefined,
  };
}

export function backupJobDefinitions(deps: BackupJobDeps): JobDefinition<never>[] {
  const server = async (id: string) => {
    const [s] = await deps.db.select().from(servers).where(eq(servers.id, id)).limit(1);
    if (!s) throw new JobError("NOT_FOUND", "server no longer exists");
    return s;
  };

  const create: JobDefinition<z.infer<typeof BackupInput>> = {
    type: BACKUP_JOBS.create,
    input: BackupInput,
    cancelPermission: "servers.backups.create",
    retryLimit: 0,
    expireInSeconds: 8 * 3600,
    steps: [
      {
        key: "rotate",
        label: "Rotate out the oldest backup",
        run: async (ctx) => {
          if (!ctx.input.rotateBackupId) return SKIP_STEP;
          const [old] = await deps.db.select().from(backups).where(eq(backups.id, ctx.input.rotateBackupId)).limit(1);
          if (!old) return SKIP_STEP;
          if (old.locked) throw new JobError("BACKUP_LOCKED", "the backup chosen for rotation was locked in the meantime");
          const s = await server(ctx.input.serverId);
          await deleteBackupData(deps, old, s.nodeId, { jobId: ctx.jobId, signal: ctx.signal });
          await deps.db.delete(backups).where(eq(backups.id, old.id));
          void deps.publishDeleted(s.id, old.id).catch(() => undefined);
          await ctx.log("info", `Rotated out backup "${old.name}"`);
        },
      },
      {
        key: "prepare",
        label: "Prepare the server",
        run: async (ctx) => {
          const s = await server(ctx.input.serverId);
          const st = await workloadStatus(deps, s.nodeId, s.id, ctx.signal);
          ctx.state.wasRunning = isRunning(st);
          await deps.bus.publish({ type: "backup.started", subjectType: "server", subjectId: s.id, data: { backupId: ctx.input.backupId, jobId: ctx.jobId } });
          if (!isRunning(st)) {
            await setRow(deps, ctx.input.backupId, { consistency: "stopped" });
            return SKIP_STEP;
          }
          if (ctx.input.stopServer) {
            await ctx.setMessage("Stopping the server");
            const rt = await loadRuntimeContext(deps.db, s.id);
            const stopped = await stopWorkload(deps, ctx, rt, 60_000);
            await deps.db.update(servers).set(exitColumns(stopped)).where(eq(servers.id, s.id));
            ctx.state.stoppedForBackup = true;
            await setRow(deps, ctx.input.backupId, { consistency: "stopped" });
            await ctx.log("info", "Server stopped for the backup");
            return;
          }
          // Minecraft: stop automatic saving, flush everything to disk, wait for the confirmation.
          const consistency = await saveCycle(deps, ctx, s);
          await setRow(deps, ctx.input.backupId, { consistency });
          if (consistency === "live") await ctx.log("info", "Archiving the running server live");
        },
      },
      {
        key: "archive",
        label: "Archive the server files",
        run: async (ctx) => {
          const s = await server(ctx.input.serverId);
          await archiveBackup(deps, ctx, await row(deps, ctx.input.backupId), s.nodeId);
        },
      },
      {
        key: "upload",
        label: "Upload to object storage",
        run: async (ctx) => {
          const b = await row(deps, ctx.input.backupId);
          if (b.storage !== "s3") {
            await setRow(deps, b.id, { status: "completed", completedAt: new Date(deps.clock.now()) });
            return SKIP_STEP;
          }
          const cfg = await deps.storage.current().catch((err: unknown) => wrap(err, "storage settings"));
          if (cfg.type !== "s3") throw new JobError("STORAGE_ERROR", "S3 storage is no longer configured");
          const s = await server(ctx.input.serverId);
          await uploadBackup(deps, ctx, b, s.nodeId, cfg);
          await setRow(deps, b.id, { status: "completed", completedAt: new Date(deps.clock.now()) });
        },
      },
      {
        key: "resume",
        label: "Resume the server",
        run: async (ctx) => {
          const s = await server(ctx.input.serverId);
          await resumeSaving(deps, ctx, s);
          if (ctx.state.stoppedForBackup) {
            await deps.state.transition(s.id, "stopped", {}, { reason: "backup done" });
            await startServerAndWait(deps, ctx);
            ctx.state.restarted = true;
            return;
          }
          if (!ctx.state.saveOff) return SKIP_STEP;
        },
      },
    ],
    async finalize(f) {
      const id = f.input.serverId;
      const s = await deps.db.select().from(servers).where(eq(servers.id, id)).limit(1).then((r) => r[0]);
      if (s) {
        // `save-on` is never skipped: also after a failed or cancelled backup.
        await ensureSaveOn(deps, f, s);
        // Abort a multipart upload left open (S3 would keep the parts).
        const mp = f.state.multipart as { key: string; uploadId: string } | undefined;
        if (mp) {
          const cfg = await deps.storage.current().catch(() => null);
          if (cfg?.type === "s3") await deps.storage.abortMultipart(cfg, mp.key, mp.uploadId).catch(() => undefined);
        }
        if (f.state.stoppedForBackup && !f.state.restarted) {
          // The server was stopped for the backup: bring it back up even though the backup failed.
          await deps.state.transition(id, "stopped", {}, { reason: "backup ended" });
          await startServerAndWait(deps, finalizeCtx(f, deps.readyTimeoutMs ?? 15 * 60_000)).catch((err: unknown) =>
            f.log("error", `The server could not be started again: ${(err as Error).message}`),
          );
        }
        const [cur] = await deps.db.select({ state: servers.state }).from(servers).where(eq(servers.id, id));
        if (cur?.state === "backing_up") {
          const before: ServerState = f.input.fromState === "crashed" ? "crashed" : "stopped";
          if (f.status === "succeeded") await deps.state.transition(id, f.state.wasRunning ? "running" : before, {}, { reason: "backup done" });
          else await settleFromRuntime(deps, id, before);
        }
      }
      const [b] = await deps.db.select().from(backups).where(eq(backups.id, f.input.backupId)).limit(1);
      if (b && b.status !== "completed") {
        await setRow(deps, b.id, { status: "failed", error: f.error?.message ?? f.status, completedAt: new Date(deps.clock.now()) });
        if (b.storage === "local" && s) await deleteBackupData(deps, b, s.nodeId).catch(() => undefined);
      }
      const ok = b?.status === "completed" || (b && f.status === "succeeded");
      await deps.bus.publish({
        type: ok ? "backup.completed" : "backup.failed",
        subjectType: "server",
        subjectId: id,
        data: { backupId: f.input.backupId, jobId: f.jobId, ...(ok ? {} : { error: f.error?.message ?? f.status }) },
      });
      await deps.state.end(id, f.jobId);
    },
  };

  const restore: JobDefinition<z.infer<typeof RestoreInput>> = {
    type: BACKUP_JOBS.restore,
    input: RestoreInput,
    cancelPermission: "servers.backups.restore",
    retryLimit: 0,
    expireInSeconds: 8 * 3600,
    steps: [
      {
        key: "safety",
        label: "Safety backup of the current files",
        run: async (ctx) => {
          if (!ctx.input.safetyBackupId) {
            if (ctx.input.safetySkippedReason) await ctx.log("warn", `Safety backup skipped: ${ctx.input.safetySkippedReason}`);
            return SKIP_STEP;
          }
          const s = await server(ctx.input.serverId);
          let b = await row(deps, ctx.input.safetyBackupId);
          try {
            // Taken before stopping (contract): a running Minecraft server goes through the save cycle.
            const st = await workloadStatus(deps, s.nodeId, s.id, ctx.signal);
            const consistency = isRunning(st) ? await saveCycle(deps, ctx, s) : "stopped";
            await setRow(deps, b.id, { consistency });
            b = await archiveBackup(deps, ctx, b, s.nodeId);
            await resumeSaving(deps, ctx, s);
            if (b.storage === "s3") {
              const cfg = await deps.storage.current().catch((err: unknown) => wrap(err, "storage settings"));
              if (cfg.type !== "s3") throw new JobError("STORAGE_ERROR", "S3 storage is no longer configured");
              await uploadBackup(deps, ctx, b, s.nodeId, cfg);
            }
            await setRow(deps, b.id, { status: "completed", completedAt: new Date(deps.clock.now()) });
          } catch (err) {
            await setRow(deps, b.id, { status: "failed", error: (err as Error).message, completedAt: new Date(deps.clock.now()) });
            throw err;
          }
          await ctx.log("info", `Safety backup "${b.name}" created (locked)`);
        },
      },
      {
        key: "stop",
        label: "Stop the server",
        run: async (ctx) => {
          const s = await server(ctx.input.serverId);
          const st = await workloadStatus(deps, s.nodeId, s.id, ctx.signal);
          if (isRunning(st)) {
            const stopped = await stopWorkload(deps, ctx, await loadRuntimeContext(deps.db, s.id), 60_000);
            await deps.db.update(servers).set(exitColumns(stopped)).where(eq(servers.id, s.id));
            await ctx.log("info", "Server stopped for the restore");
          }
          // stopping → stopped → restoring (a server that was already stopped is `restoring` already).
          const [cur] = await deps.db.select({ state: servers.state }).from(servers).where(eq(servers.id, s.id));
          if (cur?.state === "stopping") {
            await deps.state.transition(s.id, "stopped", {}, { reason: "stopped for restore" });
            await deps.state.transition(s.id, "restoring", {}, { reason: "restore" });
          }
          if (!isRunning(st)) return SKIP_STEP;
        },
      },
      {
        key: "restore",
        label: "Restore the files",
        run: async (ctx) => {
          const s = await server(ctx.input.serverId);
          const b = await row(deps, ctx.input.backupId);
          if (b.status !== "completed" || !b.sha256) throw new JobError("BACKUP_UNAVAILABLE", "the backup is not complete");
          let source: { type: "local" } | { type: "url"; url: string } = { type: "local" };
          if (b.storage === "s3") {
            const cfg = await deps.storage.current().catch((err: unknown) => wrap(err, "storage settings"));
            if (cfg.type !== "s3" || !b.objectKey) throw new JobError("STORAGE_ERROR", "the backup's object storage is not configured");
            source = { type: "url", url: await deps.storage.presignGet(cfg, b.objectKey, 6 * 3600) };
          }
          const r = await deps.gateway
            .send(
              s.nodeId,
              "backup.restore",
              { workloadId: s.id, backupId: b.id, source, sha256: b.sha256, truncate: ctx.input.truncate, maxTotalBytes: MAX_ARCHIVE_BYTES },
              { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 900_000, resultTimeoutMs: ARCHIVE_TIMEOUT_MS },
            )
            .catch((err: unknown) => wrap(err, "backup.restore"));
          await ctx.log("info", `Restored ${r.files} files (${r.bytes} bytes) from "${b.name}"`);
          ctx.state.restored = true;
        },
      },
      {
        key: "start",
        label: "Start the server",
        run: async (ctx) => {
          if (!ctx.input.startAfter) return SKIP_STEP;
          await deps.state.transition(ctx.input.serverId, "stopped", {}, { reason: "restored" });
          await startServerAndWait(deps, ctx);
        },
      },
    ],
    async finalize(f) {
      const id = f.input.serverId;
      await ensureSaveOn(deps, f, (await deps.db.select().from(servers).where(eq(servers.id, id)).limit(1))[0]);
      const [cur] = await deps.db.select({ state: servers.state }).from(servers).where(eq(servers.id, id));
      // Whatever happened, a server left in `restoring`/`stopping` ends up stopped (a failed restore never auto-starts).
      if (cur?.state === "restoring") await deps.state.transition(id, "stopped", {}, { reason: f.status === "succeeded" ? "restored" : "restore failed" });
      else if (cur?.state === "starting" || cur?.state === "stopping") await settleFromRuntime(deps, id, "stopped");
      if (f.state.restored) {
        await deps.bus.publish({ type: "backup.restored", subjectType: "server", subjectId: id, data: { backupId: f.input.backupId, jobId: f.jobId } });
      }
      if (f.status !== "succeeded" && !f.state.restored) await f.log("error", "The restore did not complete; the server was left stopped");
      if (f.status !== "succeeded" && f.state.restored) await f.log("warn", "The files were restored but the server did not start");
      await deps.state.end(id, f.jobId);
    },
  };

  const remove: JobDefinition<z.infer<typeof DeleteInput>> = {
    type: BACKUP_JOBS.remove,
    input: DeleteInput,
    cancelPermission: "servers.backups.delete",
    retryLimit: 3,
    retryDelaySeconds: 10,
    steps: [
      {
        key: "delete",
        label: "Delete the backup",
        run: async (ctx) => {
          const [b] = await deps.db.select().from(backups).where(eq(backups.id, ctx.input.backupId)).limit(1);
          if (!b) return SKIP_STEP;
          if (b.locked) throw new JobError("BACKUP_LOCKED", "the backup is locked");
          const s = await server(ctx.input.serverId);
          await deleteBackupData(deps, b, s.nodeId, { jobId: ctx.jobId, signal: ctx.signal });
          await deps.db.delete(backups).where(eq(backups.id, b.id));
          void deps.publishDeleted(s.id, b.id).catch(() => undefined);
          await ctx.log("info", `Deleted backup "${b.name}"`);
        },
      },
    ],
  };

  return [create, restore, remove] as unknown as JobDefinition<never>[];
}

/** Server deletion: every backup's data goes first (locked ones too — the server is going away). */
export async function deleteAllBackups(deps: BackupJobDeps, serverId: string, ctx: { jobId: string; signal: AbortSignal; log: Ctx<unknown>["log"] }): Promise<void> {
  const rows = await deps.db.select().from(backups).where(eq(backups.serverId, serverId)).orderBy(asc(backups.createdAt));
  if (!rows.length) return;
  const [s] = await deps.db.select({ nodeId: servers.nodeId }).from(servers).where(eq(servers.id, serverId));
  for (const b of rows) {
    await deleteBackupData(deps, b, s?.nodeId ?? "", { jobId: ctx.jobId, signal: ctx.signal });
    await deps.db.delete(backups).where(and(eq(backups.id, b.id), eq(backups.serverId, serverId)));
  }
  await ctx.log("info", `Deleted ${rows.length} backup(s)`);
}

