import { BACKUP_COUNTED_STATUSES, type ServerState, type WorkloadStatus } from "@blockforge/contracts";
import { createSaveTracker, isSaveConfirmation, isSaveOffConfirmation, isSaveOnConfirmation } from "@blockforge/minecraft";
import { and, asc, count, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { AgentCommandError } from "../agents/gateway.js";
import type { ConsoleLine } from "../agents/console-buffer.js";
import { backups, jobs, servers } from "../db/schema/index.js";
import { JobError, SKIP_STEP, type FinalizeContext, type JobDefinition, type StepContext } from "../jobs/types.js";
import { exitColumns, settleFromRuntime, startServerAndWait, stopWorkload, withLockRelease, type ServerJobDeps } from "../servers/jobs.js";
import { loadRuntimeContext, minecraftGame } from "../servers/runtime.js";
import { StorageError, type BackupStorage, type S3Config } from "./storage.js";

export const BACKUP_JOBS = { create: "server.backup", restore: "server.backup.restore", remove: "server.backup.delete" } as const;

/** Archive size limit sent to the agent (contract maximum). */
const MAX_ARCHIVE_BYTES = 512 * 1024 ** 3;
const ARCHIVE_TIMEOUT_MS = 6 * 3600_000;
/** How long `save-off` / `save-on` acknowledgements may take. */
const SAVE_TOGGLE_TIMEOUT_MS = 15_000;

export interface BackupJobDeps extends ServerJobDeps {
  storage: BackupStorage;
  /** Publishes `backup.updated` for a backup row. */
  publish(backupId: string): Promise<void>;
  /** Publishes `backup.deleted`. */
  publishDeleted(serverId: string, backupId: string): Promise<void>;
  /** How long to wait for "Saved the game" after `save-all flush`. */
  saveTimeoutMs?: number;
  /** How long `save-off` / `save-on` acknowledgements may take (default 15 s). */
  saveToggleTimeoutMs?: number;
}

type BackupRow = typeof backups.$inferSelect;
type ServerRow = typeof servers.$inferSelect;
type Ctx<I> = StepContext<I>;
type LogCtx = { jobId: string; signal?: AbortSignal; log: Ctx<unknown>["log"] };

/** Save confirmation after `save-all flush` (vanilla/Paper/Forge, 26.x "System chat:" prefix) — from @blockforge/minecraft. */
export { isSaveConfirmation };

function wrap(err: unknown, what: string): never {
  if (err instanceof AgentCommandError) {
    if (err.code === "QUOTA_EXCEEDED") {
      throw new JobError(
        "QUOTA_EXCEEDED",
        `${what}: the node does not have enough free disk space for another backup (older backups are only rotated out after the new one is complete — free space or delete a backup): ${err.message}`,
      );
    }
    throw new JobError(err.code, `${what}: ${err.message}`, err.retryable);
  }
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

/** The newest console seq of a server (lines after it are newer output). */
function lastSeq(deps: BackupJobDeps, serverId: string): number {
  return deps.consoles.tail(serverId, 1).lines.at(-1)?.seq ?? 0;
}

type ConsoleVerdict = "ok" | "failed" | null;

/** A stateless matcher: `ok` when a line matches. */
const confirmedBy =
  (ok: (line: string) => boolean) =>
  (line: string): ConsoleVerdict =>
    ok(line) ? "ok" : null;

/**
 * `save-all flush`: "Saved the game" counts only after this save's own progress line ("Saving the
 * game …") — a stray or forged confirmation before it is ignored; a save failure fails at once.
 * Only the server's own logger is trusted (@blockforge/minecraft `createSaveTracker`).
 */
function saveAllOutcome(): (line: string) => ConsoleVerdict {
  const tracker = createSaveTracker();
  return (line) => {
    const e = tracker.push(line);
    return e === "saved" ? "ok" : e === "failed" ? "failed" : null;
  };
}

/**
 * Waits for a console line after `afterSeq` (seq, not timestamps: agent and control-plane clocks may
 * differ) for which `match` returns a verdict. Every line is passed to `match` once, in seq order
 * (matchers may be stateful).
 */
function waitForConsole(
  deps: BackupJobDeps,
  serverId: string,
  afterSeq: number,
  match: (line: string) => ConsoleVerdict,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"ok" | "failed" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    let cursor = afterSeq;
    const done = (v: "ok" | "failed" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.gateway.off("consoleLines", onLines);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const check = (lines: readonly ConsoleLine[]) => {
      for (const l of lines) {
        if (settled || l.seq <= cursor) continue;
        cursor = l.seq;
        if (l.stream === "system") continue;
        const v = match(l.line);
        if (v) return done(v);
      }
    };
    const onLines = (id: string, lines: ConsoleLine[]) => {
      if (id === serverId) check(lines);
    };
    const onAbort = () => done("timeout");
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    timer.unref();
    deps.gateway.on("consoleLines", onLines);
    signal?.addEventListener("abort", onAbort, { once: true });
    check(deps.consoles.tail(serverId, 2000).lines);
  });
}

async function consoleCommand(deps: BackupJobDeps, nodeId: string, serverId: string, line: string, opts: { jobId?: string; signal?: AbortSignal } = {}): Promise<void> {
  await deps.gateway.send(nodeId, "workload.console", { workloadId: serverId, line }, { timeoutMs: 15_000, ...opts });
}

// --- Storage --------------------------------------------------------------------------------

/** The S3 configuration a backup was (or is being) written with — never today's settings. */
async function s3For(deps: BackupJobDeps, b: BackupRow): Promise<S3Config> {
  if (b.storageRef) return deps.storage.fromRef(b.storageRef).catch((err: unknown) => wrap(err, "storage"));
  throw new JobError("STORAGE_ERROR", "the backup has no storage reference");
}

/** `backup.create` for a row; records size, sha256 and skipped symlinks. */
export async function archiveBackup(deps: BackupJobDeps, ctx: LogCtx, b: BackupRow, nodeId: string): Promise<BackupRow> {
  await setRow(deps, b.id, { status: "running" });
  const started = deps.clock.now();
  const r = await deps.gateway
    .send(nodeId, "backup.create", { workloadId: b.serverId, backupId: b.id, ignore: b.ignored, maxBytes: MAX_ARCHIVE_BYTES }, { jobId: ctx.jobId, ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 900_000, resultTimeoutMs: ARCHIVE_TIMEOUT_MS })
    .catch((err: unknown) => wrap(err, "backup.create"));
  await ctx.log("info", `Archived ${r.files} files (${r.sizeBytes} bytes, sha256 ${r.sha256}) in ${Math.round((r.durationMs || deps.clock.now() - started) / 1000)} s`);
  if (r.skippedSymlinks) await ctx.log("warn", `${r.skippedSymlinks} symbolic link(s) were not archived`);
  await setRow(deps, b.id, { sizeBytes: r.sizeBytes, sha256: r.sha256, skippedSymlinks: r.skippedSymlinks });
  return { ...b, sizeBytes: r.sizeBytes, sha256: r.sha256, skippedSymlinks: r.skippedSymlinks };
}

/**
 * S3: the upload id and key are persisted before the agent uploads (a crash leaves an abortable
 * upload, not an orphan); presigned multipart parts PUT by the agent, completed here with its ETags,
 * verified by size, then the local archive is deleted. Aborted on any failure.
 */
export async function uploadBackup(deps: BackupJobDeps, ctx: LogCtx, b: BackupRow, nodeId: string): Promise<string> {
  if (b.sizeBytes === null) throw new JobError("INTERNAL", "the archive size is unknown");
  const cfg = await s3For(deps, b);
  const key = deps.storage.objectKey(cfg, b.serverId, b.id);
  if (b.uploadId) {
    // An earlier attempt (control plane restarted mid-upload) left an open upload.
    await deps.storage.abortMultipart(cfg, b.objectKey ?? key, b.uploadId).catch(() => undefined);
    await deps.db.update(backups).set({ uploadId: null }).where(eq(backups.id, b.id));
  }
  const uploadId = await deps.storage.createMultipart(cfg, key).catch((err: unknown) => wrap(err, "upload"));
  await deps.db.update(backups).set({ uploadId, objectKey: key }).where(eq(backups.id, b.id));
  await setRow(deps, b.id, { status: "uploading" });
  try {
    const plan = await deps.storage.presignParts(cfg, key, uploadId, b.sizeBytes).catch((err: unknown) => wrap(err, "upload"));
    await ctx.log("info", `Uploading to object storage in ${plan.parts.length} part(s) of ${Math.round(plan.partSize / 1024 ** 2)} MiB`);
    const r = await deps.gateway
      .send(nodeId, "backup.upload", { workloadId: b.serverId, backupId: b.id, partSize: plan.partSize, parts: plan.parts, deleteLocal: false }, { jobId: ctx.jobId, ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 900_000, resultTimeoutMs: ARCHIVE_TIMEOUT_MS })
      .catch((err: unknown) => wrap(err, "backup.upload"));
    if (r.parts.length !== plan.parts.length) throw new JobError("UPLOAD_FAILED", `the agent uploaded ${r.parts.length} of ${plan.parts.length} parts`);
    await deps.storage.completeMultipart(cfg, key, uploadId, r.parts).catch((err: unknown) => wrap(err, "upload"));
  } catch (err) {
    await deps.storage.abortMultipart(cfg, key, uploadId).catch(() => undefined);
    await deps.db.update(backups).set({ uploadId: null }).where(eq(backups.id, b.id));
    throw err;
  }
  await deps.db.update(backups).set({ uploadId: null }).where(eq(backups.id, b.id));
  const size = await deps.storage.objectSize(cfg, key).catch((err: unknown) => wrap(err, "verification"));
  if (size !== b.sizeBytes) {
    await deps.storage.deleteObject(cfg, key).catch(() => undefined);
    throw new JobError("UPLOAD_FAILED", `the uploaded object has ${size ?? "no"} bytes, expected ${b.sizeBytes}`);
  }
  await deps.gateway.send(nodeId, "backup.delete", { workloadId: b.serverId, backupId: b.id }, { jobId: ctx.jobId, timeoutMs: 60_000 }).catch(async (err: unknown) => {
    await ctx.log("warn", `The local copy could not be removed: ${(err as Error).message}`);
  });
  await ctx.log("info", "Upload verified");
  return key;
}

/**
 * Removes a backup's data: its S3 object (with its own storage reference) and/or an open upload, and
 * the node-local archive (also present for S3 backups that never finished uploading).
 */
export async function deleteBackupData(deps: BackupJobDeps, b: BackupRow, nodeId: string | null, opts: { jobId?: string; signal?: AbortSignal } = {}): Promise<void> {
  if (b.storage === "s3" && b.storageRef && (b.objectKey || b.uploadId)) {
    const cfg = await s3For(deps, b);
    if (b.uploadId && b.objectKey) await deps.storage.abortMultipart(cfg, b.objectKey, b.uploadId).catch(() => undefined);
    if (b.objectKey) await deps.storage.deleteObject(cfg, b.objectKey).catch((err: unknown) => wrap(err, "delete"));
  }
  const localMayExist = b.storage === "local" || b.status !== "completed";
  if (!localMayExist || !nodeId) return;
  if (!deps.gateway.isReady(nodeId)) {
    if (b.storage === "local" && b.status === "completed") throw new JobError("NODE_UNAVAILABLE", "the server's node is not connected", true);
    return;
  }
  await deps.gateway.send(nodeId, "backup.delete", { workloadId: b.serverId, backupId: b.id }, { timeoutMs: 60_000, ...opts }).catch((err: unknown) => {
    if (err instanceof AgentCommandError && err.code === "NOT_FOUND") return;
    wrap(err, "backup.delete");
  });
}

/** Deletes a backup row (unlocked only unless `force`), then its data; the row goes first (no race with a lock). */
export async function removeBackup(
  deps: BackupJobDeps,
  backupId: string,
  opts: { force?: boolean; state?: Record<string, unknown> } & { jobId?: string; signal?: AbortSignal } = {},
): Promise<BackupRow | null> {
  // A retry after the row was deleted continues with the data of the persisted row.
  let deleted = (opts.state?.deletedRow as BackupRow | undefined) ?? null;
  if (!deleted) {
    const conds = [eq(backups.id, backupId)];
    if (!opts.force) conds.push(eq(backups.locked, false));
    deleted = (await deps.db.delete(backups).where(and(...conds)).returning())[0] ?? null;
    if (!deleted) return null;
    if (opts.state) opts.state.deletedRow = deleted;
    void deps.publishDeleted(deleted.serverId, deleted.id).catch(() => undefined);
  }
  const [s] = await deps.db.select({ nodeId: servers.nodeId }).from(servers).where(eq(servers.id, deleted.serverId));
  await deleteBackupData(deps, deleted, s?.nodeId ?? null, { ...(opts.jobId ? { jobId: opts.jobId } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
  await deps.storage.releaseSecret(deleted.storageRef?.secretId);
  if (opts.state) delete opts.state.deletedRow;
  return deleted;
}

// --- Minecraft save cycle ---------------------------------------------------------------------

async function setSaveOnPending(deps: BackupJobDeps, serverId: string, pending: boolean): Promise<void> {
  await deps.db.update(servers).set({ saveOnPending: pending }).where(eq(servers.id, serverId));
}

/**
 * `save-off` (acknowledged) → `save-all flush` → "Saved the game"; a save failure fails at once.
 * `save_on_pending` is set first, so `save-on` is retried until acknowledged even if this process dies.
 */
async function saveCycle(deps: BackupJobDeps, ctx: Ctx<unknown>, s: ServerRow): Promise<"save-flush" | "live"> {
  const rt = await loadRuntimeContext(deps.db, s.id);
  if (minecraftGame(rt) !== "java") return "live";
  ctx.state.saveOff = true;
  await setSaveOnPending(deps, s.id, true);
  const beforeOff = lastSeq(deps, s.id);
  await consoleCommand(deps, s.nodeId, s.id, "save-off", { jobId: ctx.jobId, signal: ctx.signal }).catch((err: unknown) => wrap(err, "save-off"));
  if ((await waitForConsole(deps, s.id, beforeOff, confirmedBy(isSaveOffConfirmation), deps.saveToggleTimeoutMs ?? SAVE_TOGGLE_TIMEOUT_MS, ctx.signal)) !== "ok") {
    throw new JobError("SAVE_OFF_TIMEOUT", "the server did not confirm save-off");
  }
  // Only output after this point counts (an earlier "Saved the game" is not this save).
  const beforeSave = lastSeq(deps, s.id);
  await consoleCommand(deps, s.nodeId, s.id, "save-all flush", { jobId: ctx.jobId, signal: ctx.signal }).catch((err: unknown) => wrap(err, "save-all"));
  const timeout = deps.saveTimeoutMs ?? 120_000;
  const r = await waitForConsole(deps, s.id, beforeSave, saveAllOutcome(), timeout, ctx.signal);
  if (r === "failed") throw new JobError("SAVE_FAILED", "the server could not save the world (is there enough disk space?)");
  if (r === "timeout") throw new JobError("SAVE_TIMEOUT", `the server did not confirm "save-all flush" within ${Math.round(timeout / 1000)} s`);
  await ctx.log("info", "World saved and automatic saving paused");
  return "save-flush";
}

/** `save-on`, acknowledged by the server; otherwise left pending for {@link retryPendingSaveOn}. */
async function sendSaveOn(deps: BackupJobDeps, s: Pick<ServerRow, "id" | "nodeId">, log: (msg: string, level: "info" | "warn") => Promise<void>, jobId?: string): Promise<boolean> {
  const before = lastSeq(deps, s.id);
  try {
    await consoleCommand(deps, s.nodeId, s.id, "save-on", jobId ? { jobId } : {});
  } catch (err) {
    await log(`save-on could not be sent (will be retried): ${(err as Error).message}`, "warn");
    return false;
  }
  if ((await waitForConsole(deps, s.id, before, confirmedBy(isSaveOnConfirmation), deps.saveToggleTimeoutMs ?? SAVE_TOGGLE_TIMEOUT_MS)) !== "ok") {
    await log("save-on was not acknowledged (will be retried)", "warn");
    return false;
  }
  await setSaveOnPending(deps, s.id, false);
  await log("Automatic saving resumed", "info");
  return true;
}

async function resumeSaving(deps: BackupJobDeps, ctx: Ctx<unknown>, s: ServerRow): Promise<void> {
  if (!ctx.state.saveOff || ctx.state.saveOnSent) return;
  ctx.state.saveOnSent = true;
  await sendSaveOn(deps, s, (m, l) => ctx.log(l, m), ctx.jobId);
}

/** finalize: `save-on` is never skipped, also after a failed or cancelled job. */
async function ensureSaveOn(deps: BackupJobDeps, f: FinalizeContext<{ serverId: string }>, s: ServerRow | undefined): Promise<void> {
  if (!s || !f.state.saveOff || f.state.saveOnSent) return;
  await sendSaveOn(deps, s, (m, l) => f.log(l, m), f.jobId);
}

/**
 * Durable `save-on`: servers whose `save-on` was never acknowledged (node disconnected, control plane
 * restarted) get it again once their node is connected and no backup/restore is running. A server
 * that is no longer running had autosave re-enabled by its restart.
 */
export async function retryPendingSaveOn(deps: BackupJobDeps, nodeId?: string): Promise<number> {
  const conds = [eq(servers.saveOnPending, true)];
  if (nodeId) conds.push(eq(servers.nodeId, nodeId));
  const rows = await deps.db.select().from(servers).where(and(...conds));
  let resumed = 0;
  for (const s of rows) {
    if (s.activeOperation === "backup" || s.activeOperation === "restore") continue;
    if (!deps.gateway.isReady(s.nodeId)) continue;
    const st = await workloadStatus(deps, s.nodeId, s.id).catch(() => null);
    if (!isRunning(st)) {
      await setSaveOnPending(deps, s.id, false);
      continue;
    }
    if (await sendSaveOn(deps, s, async (m, l) => void deps.logger[l === "warn" ? "warn" : "info"]({ serverId: s.id }, m))) resumed++;
  }
  return resumed;
}

/** Multipart uploads left open by crashed or finished jobs are aborted (startup + periodically). */
export async function abortStaleUploads(deps: BackupJobDeps): Promise<number> {
  const rows = await deps.db
    .select({ b: backups, jobStatus: jobs.status })
    .from(backups)
    .leftJoin(jobs, eq(jobs.id, backups.jobId))
    .where(isNotNull(backups.uploadId));
  let aborted = 0;
  for (const { b, jobStatus } of rows) {
    const active = jobStatus === "running" || jobStatus === "queued";
    if (active && b.status === "uploading") continue;
    if (b.storageRef && b.objectKey && b.uploadId) {
      const cfg = await deps.storage.fromRef(b.storageRef).catch(() => null);
      if (cfg) await deps.storage.abortMultipart(cfg, b.objectKey, b.uploadId).catch(() => undefined);
    }
    await deps.db.update(backups).set({ uploadId: null }).where(eq(backups.id, b.id));
    aborted++;
  }
  return aborted;
}

// --- Jobs -----------------------------------------------------------------------------------

const BackupInput = z.object({
  serverId: z.uuid(),
  backupId: z.uuid(),
  stopServer: z.boolean().default(false),
  /** At the limit: rotate out the oldest unlocked completed backup once this one is complete. */
  rotate: z.boolean().default(false),
  /** Legacy (pre-review) input: a pre-chosen rotation target meant "rotate". */
  rotateBackupId: z.uuid().nullable().default(null),
  limit: z.number().int().nonnegative().nullable().default(null),
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
    checkpoint: async () => undefined,
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
            const stopped = await stopWorkload(deps, ctx, await loadRuntimeContext(deps.db, s.id), 60_000);
            await deps.db.update(servers).set(exitColumns(stopped)).where(eq(servers.id, s.id));
            ctx.state.stoppedForBackup = true;
            await setRow(deps, ctx.input.backupId, { consistency: "stopped" });
            await ctx.log("info", "Server stopped for the backup");
            return;
          }
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
          const b = await archiveBackup(deps, ctx, await row(deps, ctx.input.backupId), s.nodeId);
          if (b.storage === "local") await setRow(deps, b.id, { status: "completed", completedAt: new Date(deps.clock.now()) });
        },
      },
      {
        key: "resume",
        label: "Resume the server",
        run: async (ctx) => {
          // Right after archiving: the upload below may take long.
          const s = await server(ctx.input.serverId);
          await resumeSaving(deps, ctx, s);
          if (ctx.state.stoppedForBackup) {
            await deps.state.transition(s.id, "stopped", {}, { reason: "backup archived" });
            await startServerAndWait(deps, ctx);
            ctx.state.restarted = true;
            return;
          }
          if (!ctx.state.saveOff) return SKIP_STEP;
        },
      },
      {
        key: "upload",
        label: "Upload to object storage",
        run: async (ctx) => {
          const b = await row(deps, ctx.input.backupId);
          if (b.storage !== "s3") return SKIP_STEP;
          const s = await server(ctx.input.serverId);
          await uploadBackup(deps, ctx, b, s.nodeId);
          await setRow(deps, b.id, { status: "completed", completedAt: new Date(deps.clock.now()) });
        },
      },
      {
        key: "rotate",
        label: "Rotate out the oldest backup",
        run: async (ctx) => {
          if (!ctx.input.rotate && !ctx.input.rotateBackupId) return SKIP_STEP;
          // Only now that the new backup is complete and verified does the oldest one go.
          const s = await server(ctx.input.serverId);
          const limit = ctx.input.limit ?? s.backupLimit;
          const [n] = await deps.db.select({ n: count() }).from(backups).where(and(eq(backups.serverId, s.id), inArray(backups.status, [...BACKUP_COUNTED_STATUSES])));
          if (Number(n?.n ?? 0) <= limit) return SKIP_STEP;
          const candidates = await deps.db
            .select({ id: backups.id, name: backups.name })
            .from(backups)
            .where(and(eq(backups.serverId, s.id), eq(backups.locked, false), eq(backups.status, "completed"), ne(backups.id, ctx.input.backupId)))
            .orderBy(asc(backups.createdAt))
            .limit(5);
          for (const c of candidates) {
            const gone = await removeBackup(deps, c.id, { state: ctx.state, jobId: ctx.jobId, signal: ctx.signal });
            if (gone) {
              await ctx.log("info", `Rotated out backup "${gone.name}"`);
              return;
            }
          }
          await ctx.log("warn", "Every older backup is locked: the server is over its backup limit");
        },
      },
    ],
    async finalize(f) {
      const id = f.input.serverId;
      try {
        const [s] = await deps.db.select().from(servers).where(eq(servers.id, id)).limit(1);
        if (s) {
          await ensureSaveOn(deps, f, s);
          if (f.state.stoppedForBackup && !f.state.restarted) {
            // The server was stopped for the backup: bring it back up even though the backup failed.
            await deps.state.transition(id, "stopped", {}, { reason: "backup ended" });
            await startServerAndWait(deps, finalizeCtx(f, deps.readyTimeoutMs ?? 15 * 60_000)).catch((err: unknown) =>
              f.log("error", `The server could not be started again: ${(err as Error).message}`),
            );
          }
          const [cur] = await deps.db.select({ state: servers.state }).from(servers).where(eq(servers.id, id));
          if (cur?.state === "backing_up") {
            // From the workload's real state (a crash during the backup is not hidden).
            await settleFromRuntime(deps, id, (f.input.fromState === "crashed" ? "crashed" : "stopped") as ServerState);
          }
        }
        const [b] = await deps.db.select().from(backups).where(eq(backups.id, f.input.backupId)).limit(1);
        if (b && b.status !== "completed") {
          await setRow(deps, b.id, { status: "failed", error: f.error?.message ?? f.status, completedAt: new Date(deps.clock.now()) });
          // No partial data: the local archive (also of S3 backups that never finished uploading) and any open upload.
          await deleteBackupData(deps, b, s?.nodeId ?? null).catch((err: unknown) => f.log("warn", `Cleaning up the failed backup: ${(err as Error).message}`));
        }
        const ok = b?.status === "completed";
        await deps.bus.publish({
          type: ok ? "backup.completed" : "backup.failed",
          subjectType: "server",
          subjectId: id,
          data: { backupId: f.input.backupId, jobId: f.jobId, ...(ok ? {} : { error: f.error?.message ?? f.status }) },
        });
      } finally {
        await deps.state.end(id, f.jobId);
      }
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
            if (b.storage === "s3") await uploadBackup(deps, ctx, b, s.nodeId);
            await setRow(deps, b.id, { status: "completed", completedAt: new Date(deps.clock.now()) });
          } catch (err) {
            await setRow(deps, b.id, { status: "failed", error: (err as Error).message, completedAt: new Date(deps.clock.now()) });
            await deleteBackupData(deps, await row(deps, b.id), s.nodeId).catch(() => undefined);
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
            if (!b.objectKey) throw new JobError("STORAGE_ERROR", "the backup has no object");
            const cfg = await s3For(deps, b);
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
      try {
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
      } finally {
        await deps.state.end(id, f.jobId);
      }
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
          // Conditional row delete (locked=false) first, then the data — a lock set meanwhile wins.
          const gone = await removeBackup(deps, ctx.input.backupId, { state: ctx.state, jobId: ctx.jobId, signal: ctx.signal });
          if (!gone) {
            const [still] = await deps.db.select({ locked: backups.locked }).from(backups).where(eq(backups.id, ctx.input.backupId));
            if (still?.locked) throw new JobError("BACKUP_LOCKED", "the backup was locked");
            return SKIP_STEP;
          }
          await ctx.log("info", `Deleted backup "${gone.name}"`);
        },
      },
    ],
  };

  return [withLockRelease(create, deps.state), withLockRelease(restore, deps.state), remove] as unknown as JobDefinition<never>[];
}

/** Failed backups kept for diagnosis: the newest 10 per server, at most 7 days. */
export const FAILED_BACKUPS_KEPT = 10;
export const FAILED_BACKUP_RETENTION_MS = 7 * 86_400_000;

export async function pruneFailedBackups(deps: BackupJobDeps): Promise<number> {
  const cutoff = new Date(deps.clock.now() - FAILED_BACKUP_RETENTION_MS);
  const r = await deps.db.execute<{ id: string }>(sql`
    SELECT id FROM (
      SELECT id, created_at, locked, row_number() OVER (PARTITION BY server_id ORDER BY created_at DESC) AS rn
        FROM backups WHERE status = 'failed') x
     WHERE NOT x.locked AND (x.rn > ${FAILED_BACKUPS_KEPT} OR x.created_at < ${cutoff})`);
  let n = 0;
  for (const { id } of r.rows) {
    if (await removeBackup(deps, id).catch((err: unknown) => (deps.logger.warn({ err, backupId: id }, "pruning a failed backup"), null))) n++;
  }
  return n;
}

/** Server deletion: every backup's data goes first (locked ones too — the server is going away). */
export async function deleteAllBackups(deps: BackupJobDeps, serverId: string, ctx: { jobId: string; signal: AbortSignal; log: Ctx<unknown>["log"] }): Promise<void> {
  const rows = await deps.db.select({ id: backups.id }).from(backups).where(eq(backups.serverId, serverId)).orderBy(asc(backups.createdAt));
  for (const b of rows) await removeBackup(deps, b.id, { force: true, jobId: ctx.jobId, signal: ctx.signal });
  if (rows.length) await ctx.log("info", `Deleted ${rows.length} backup(s)`);
}
