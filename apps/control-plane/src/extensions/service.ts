import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  ExtensionFileSnapshot,
  ExtensionHistoryEntry,
  ExtensionList,
  ExtensionUpdatesResponse,
  InstalledExtension,
  ModrinthInstallPlan as ContractInstallPlan,
  ModrinthInstallRequest,
  ModrinthPlanRequest,
  ModrinthProjectResponse,
  ModrinthSearchQuery,
  ModrinthSearchResult,
} from "@blockforge/contracts";
import {
  checkModrinthUpdates,
  EXTENSION_METADATA_ENTRIES,
  fromContractPlanRequest,
  fromContractSearchQuery,
  getModrinthProject,
  listCompatibleVersions,
  MAX_METADATA_BYTES,
  parseJarMetadata,
  planModrinthInstall,
  searchModrinth,
  toContractInstallPlan,
  toContractJarInfo,
  toContractProjectDetails,
  toContractSearchResult,
  toContractUpdateStatus,
  toContractVersionSummary,
  toggledExtensionPath,
} from "@blockforge/minecraft";
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { AgentCommandError } from "../agents/gateway.js";
import { commandErrorToHttp } from "../agents/errors.js";
import { actorUserId, type AuditActor } from "../audit/service.js";
import { extensionHistory, extensionScans, extensionUploads, installedExtensions, servers } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { BrowserTransfer } from "../files/browser-transfers.js";
import { AppError, conflict, notFound } from "../lib/errors.js";
import { decodeCursor, encodeCursor, TimeIdCursor } from "../lib/pagination.js";
import type { ServerAccess } from "../servers/access.js";
import { installedRefs } from "./jobs.js";
import {
  acquireExtensionLock,
  agentOpts,
  assertAgentSupportsExtensions,
  assertExtensionsAllowed,
  assertNoExtensionJob,
  displayName,
  ensureDir,
  ensureScanRow,
  EXTENSION_JOBS,
  HISTORY_RETENTION_MS,
  historyActor,
  historyDto,
  keptAreaPath,
  KEPT_PER_SERVER,
  KEPT_RETENTION_MS,
  lockExtensions,
  refetchable,
  requireTarget,
  restartRequired,
  rollbackOf,
  scanStatusOf,
  snapshotOf,
  targetOf,
  toDtos,
  UPLOAD_DIR,
  UPLOAD_TTL_MS,
  type ExtensionDeps,
  type ExtensionRow,
  type ExtensionTarget,
} from "./model.js";
import {
  deleteFile,
  describeUndo,
  exists,
  fencedUndo,
  HashFailedError,
  keepFile,
  KeptFileChangedError,
  memoryUndo,
  placeVerified,
  PlacementStuckError,
  pushUndo,
  sha512Of,
  UnverifiedKeptError,
  upsertEntry,
  writeHistory,
  type FileCtx,
  type Kept,
  type PendingEntry,
  type UndoStore,
} from "./ops.js";
import { JobError } from "../jobs/types.js";
import { publishExtensions } from "./scan.js";

type UploadWarning = { code: "REPLACED_EXISTING" | "INCOMPATIBLE_ALLOWED" | "DUPLICATE_ID" | "NO_METADATA"; level: "info" | "warning"; message: string };

const rejected = (status: 409 | 422, reason: string, message: string, extra: { compatibility?: unknown; existing?: unknown } = {}) =>
  new AppError(status, status === 409 ? "CONFLICT" : "PRECONDITION_FAILED", message, { reason, compatibility: extra.compatibility ?? null, existing: extra.existing ?? null });

const preempted = () => conflict("A stop, restart or kill of the server interrupted the change; it was undone", { reason: "preempted" });

/** HTTP form of a refused file operation (hash failure, unverifiable or changed kept file) or an agent error. */
function fileError(err: unknown): unknown {
  if (err instanceof HashFailedError) return new AppError(409, "CONFLICT", err.message, { reason: "hash_failed" });
  if (err instanceof UnverifiedKeptError) return new AppError(409, "CONFLICT", err.message, { reason: "kept_file_unverified", keptPath: err.keptPath });
  if (err instanceof KeptFileChangedError) return new AppError(409, "CONFLICT", err.message, { reason: "kept_file_changed", keptPath: err.keptPath });
  if (err instanceof JobError) return new AppError(409, "CONFLICT", err.message, { reason: err.code.toLowerCase() });
  return commandErrorToHttp(err);
}

/** Plugins & mods (api.md "Plugins & mods (Phase 4b)"). */
export class ExtensionsService {
  constructor(private readonly d: ExtensionDeps) {}

  private ctx(access: ServerAccess, actor: AuditActor): FileCtx {
    return { serverId: access.server.id, nodeId: access.server.nodeId, userId: actorUserId(actor), timeoutMs: 60_000 };
  }

  private modrinthError(err: unknown, what?: string): unknown {
    return this.d.upstreams.httpError(err, "modrinth", what);
  }

  private async rows(serverId: string): Promise<ExtensionRow[]> {
    return this.d.db.select().from(installedExtensions).where(eq(installedExtensions.serverId, serverId)).orderBy(installedExtensions.filename);
  }

  private async row(serverId: string, id: string): Promise<ExtensionRow> {
    const [r] = await this.d.db.select().from(installedExtensions).where(and(eq(installedExtensions.serverId, serverId), eq(installedExtensions.id, id)));
    if (!r) throw notFound("Extension");
    return r;
  }

  /**
   * A synchronous change left a file in the keep area it cannot vouch for (or could not put back): a
   * failed history row points at it (digest only when known) so an operator can inspect it and pruning
   * removes it later; it is never restored automatically.
   */
  private async recordUnverified(
    access: ServerAccess,
    actor: AuditActor,
    historyId: string,
    action: "remove" | "upload",
    r: { name: string; path: string; from: ExtensionFileSnapshot },
    err: UnverifiedKeptError,
    keptSha512: string | null = null,
  ): Promise<void> {
    await writeHistory(
      this.d,
      access.server.id,
      [{ id: historyId, action, extensionId: null, extensionName: r.name, path: r.path, from: r.from, to: null, keptPath: err.keptPath, keptSha512, leftInKeep: true }],
      { actor: await historyActor(this.d.db, actor), jobId: null, status: "failed", error: err.message },
    );
    await this.d.audit.record({ ...actor, action: `server.extension.${action}`, targetType: "server", targetId: access.server.id, outcome: "failed", details: { path: r.path, keptPath: err.keptPath, reason: err.code } });
  }

  /**
   * A synchronous change lost its hold (pre-emption or the stale-hold sweep): the fenced undo puts files back
   * only under a new cleanup hold (no other operation, server stopped/crashed); otherwise nothing is touched
   * and a failed history row records every kept file and every file the change wrote. Always 409.
   */
  private async preemptedSync(access: ServerAccess, actor: AuditActor, c: FileCtx, store: UndoStore, held: () => Promise<boolean>): Promise<never> {
    store.log.started = true;
    store.log.error = { code: "PREEMPTED", message: "A stop, restart or kill of the server interrupted the change" };
    const outcome = await fencedUndo(this.d, c, store, held);
    const r = describeUndo(store.log, outcome);
    if (outcome.skipped || store.log.failed.length || store.log.notes.length) {
      await writeHistory(this.d, access.server.id, store.log.entries, { actor: await historyActor(this.d.db, actor), jobId: null, status: "failed", error: r.message });
      await this.d.audit.record({ ...actor, action: `server.extension.${store.log.entries[0]?.action ?? "change"}`, targetType: "server", targetId: access.server.id, outcome: "failed", details: { reason: outcome.skipped ? "preempted_undo_skipped" : "preempted", error: r.message } });
    }
    throw conflict(r.message, { reason: outcome.skipped ? "preempted_undo_skipped" : "preempted" });
  }

  private async audit(actor: AuditActor, access: ServerAccess, action: string, details: Record<string, unknown>): Promise<void> {
    await this.d.audit.record({ ...actor, action: `server.extension.${action}`, targetType: "server", targetId: access.server.id, outcome: "success", details });
  }

  /**
   * Enqueues an extension job under the per-server extension lock. Jobs that change the server's files
   * (everything but scans) also take the server's `extensions` operation lock, so backup, restore,
   * reinstall and delete are refused while they run and vice versa (released by the job's finalize).
   */
  private async enqueue(access: ServerAccess, type: string, input: Record<string, unknown>, actor: AuditActor | null): Promise<string> {
    assertExtensionsAllowed(access.server);
    assertAgentSupportsExtensions(this.d.gateway, access.server.nodeId);
    const serverId = access.server.id;
    return withTransaction(this.d.db, async (tx, after) => {
      // The server row is locked first (like backups and power actions), then the job is created.
      const fileChange = type !== EXTENSION_JOBS.scan;
      if (fileChange) await lockExtensions(this.d, tx, serverId);
      const jobId = await this.d.jobs.enqueue(type, { serverId, ...input }, { targetType: "server", targetId: serverId, requestedBy: actor ? actorUserId(actor) : null }, tx, after);
      if (fileChange) {
        await this.d.state.attachJob(tx, serverId, jobId);
        after.add(() => this.d.state.notify(serverId));
      }
      await acquireExtensionLock(tx, serverId, jobId);
      return jobId;
    });
  }

  /**
   * A synchronous file change (enable/disable, remove, upload completion) holds the server's `extensions`
   * operation lock for its whole duration, taken atomically with the extension-job check (L3). `held`
   * re-checks it before each file operation: a pre-empting stop/restart/kill makes the change undo
   * itself and answer 409 `preempted`.
   */
  private async syncChange<T>(access: ServerAccess, fn: (held: () => Promise<boolean>) => Promise<T>): Promise<T> {
    assertExtensionsAllowed(access.server);
    const serverId = access.server.id;
    const token = await withTransaction(this.d.db, async (tx) => {
      const t = await lockExtensions(this.d, tx, serverId);
      await ensureScanRow(tx, serverId);
      await assertNoExtensionJob(tx, serverId, { lock: true });
      return t;
    });
    this.d.state.notify(serverId);
    try {
      return await fn(() => this.d.state.holdsToken(serverId, token));
    } finally {
      await this.d.state.unlock(serverId, token);
    }
  }

  // --- Installed --------------------------------------------------------------------------------

  async list(access: ServerAccess): Promise<ExtensionList> {
    const target = targetOf(access.server);
    const [scanRow] = await this.d.db.select().from(extensionScans).where(eq(extensionScans.serverId, access.server.id));
    const uploads = await this.uploadPolicy();
    if (!target) return { installDir: null, kind: null, items: [], skipped: [], scan: scanStatusOf(scanRow), truncated: false, uploads };
    let scan = scanStatusOf(scanRow);
    if (scan.status === "never" && !scanRow?.activeJobId) {
      // First look: scan automatically (system job; ignored while another job holds the lock).
      try {
        const jobId = await this.enqueue(access, EXTENSION_JOBS.scan, { full: false }, null);
        await ensureScanRow(this.d.db, access.server.id);
        await this.d.db.update(extensionScans).set({ status: "running", jobId, startedAt: new Date(this.d.clock.now()) }).where(eq(extensionScans.serverId, access.server.id));
        scan = { ...scan, status: "running", jobId };
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        // An outdated agent is reported like an explicit scan reports it (L6); a busy server is not an error.
        if ((err.details as { reason?: unknown } | undefined)?.reason === "agent_outdated") scan = { ...scan, error: err.message.slice(0, 1024) };
      }
    }
    const items = await toDtos(this.d.db, (await this.rows(access.server.id)).slice(0, 4096));
    return { installDir: target.installDir, kind: target.kind, items, skipped: scanRow?.skipped ?? [], scan, truncated: scanRow?.truncated ?? false, uploads };
  }

  async get(access: ServerAccess, id: string): Promise<InstalledExtension> {
    requireTarget(access.server);
    return (await toDtos(this.d.db, [await this.row(access.server.id, id)]))[0]!;
  }

  async scan(access: ServerAccess, full: boolean, actor: AuditActor): Promise<{ jobId: string }> {
    requireTarget(access.server);
    const jobId = await this.enqueue(access, EXTENSION_JOBS.scan, { full }, actor);
    await this.audit(actor, access, "scan", { full, jobId });
    return { jobId };
  }

  async setEnabled(access: ServerAccess, id: string, enabled: boolean, actor: AuditActor): Promise<{ extension: InstalledExtension; restartRequired: boolean }> {
    requireTarget(access.server);
    const r = await this.row(access.server.id, id);
    const to = toggledExtensionPath(r.path, enabled);
    if (to === null) return { extension: (await toDtos(this.d.db, [r]))[0]!, restartRequired: false };
    const updated = await this.syncChange(access, async (held) => {
      const cur = await this.row(access.server.id, id);
      if (cur.path !== r.path) throw conflict("The extension changed meanwhile; reload it", { reason: "exists" });
      const c = this.ctx(access, actor);
      if (await exists(this.d, c, to).catch((err: unknown) => Promise.reject(commandErrorToHttp(err)))) throw conflict(`${to} already exists`, { reason: "exists" });
      if (!(await held())) throw preempted();
      // Hashed first so a pre-empted toggle can be undone verifiably.
      // A file that cannot be hashed is not renamed (its rename could not be undone verifiably).
      const sha = await sha512Of(this.d, c, r.path).catch((err: unknown) => Promise.reject(commandErrorToHttp(err)));
      if (!sha) {
        if (!(await exists(this.d, c, r.path).catch(() => true))) throw notFound("Extension file");
        throw conflict(`${r.path} could not be hashed; nothing was renamed`, { reason: "hash_failed" });
      }
      try {
        await this.d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: r.path, to }, agentOpts(c));
      } catch (err) {
        if (err instanceof AgentCommandError && err.code === "NOT_FOUND") throw notFound("Extension file");
        throw commandErrorToHttp(err);
      }
      const from = snapshotOf(r);
      const entry: PendingEntry = { id: randomUUID(), action: enabled ? "enable" : "disable", extensionId: r.id, extensionName: displayName(r), path: to, from, to: { ...from, path: to }, keptPath: null, keptSha512: null };
      if (!(await held())) {
        const store = memoryUndo();
        await upsertEntry(store, entry);
        await pushUndo(store, { kind: "restore", kept: to, sha512: sha, path: r.path, entryId: entry.id });
        return this.preemptedSync(access, actor, c, store, held);
      }
      const filename = to.slice(to.indexOf("/") + 1);
      const [u] = await this.d.db.update(installedExtensions).set({ path: to, filename, enabled }).where(eq(installedExtensions.id, r.id)).returning();
      await writeHistory(this.d, access.server.id, [entry], { actor: await historyActor(this.d.db, actor), jobId: null, status: "succeeded" });
      return u!;
    });
    await this.audit(actor, access, enabled ? "enable" : "disable", { extensionId: r.id, from: r.path, to });
    void publishExtensions(this.d, access.server.id, [r.id]);
    return { extension: (await toDtos(this.d.db, [updated]))[0]!, restartRequired: restartRequired(access.server.state) };
  }

  async remove(access: ServerAccess, id: string, actor: AuditActor): Promise<{ restartRequired: boolean; historyEntryId: string; rollbackAvailable: boolean }> {
    requireTarget(access.server);
    await this.row(access.server.id, id);
    const historyId = randomUUID();
    const { r, kept } = await this.syncChange(access, async (held) => {
      const r = await this.row(access.server.id, id);
      const c = this.ctx(access, actor);
      let kept: Kept | null = null;
      if (!(await held())) throw preempted();
      try {
        // The digest of what was actually kept (#6, hashed before and verified after the move), not the scan-time hash.
        kept = await keepFile(this.d, c, r.path, historyId);
      } catch (err) {
        // Already gone from disk: only the row is removed.
        if (!(err instanceof AgentCommandError && err.code === "NOT_FOUND")) {
          if (err instanceof UnverifiedKeptError) await this.recordUnverified(access, actor, historyId, "remove", { name: displayName(r), path: r.path, from: snapshotOf(r) }, err);
          throw fileError(err);
        }
      }
      if (kept && !(await held())) {
        const store = memoryUndo();
        await upsertEntry(store, { id: historyId, action: "remove", extensionId: r.id, extensionName: displayName(r), path: r.path, from: snapshotOf(r), to: null, keptPath: kept.path, keptSha512: kept.sha512 });
        await pushUndo(store, { kind: "restore", kept: kept.path, sha512: kept.sha512, path: r.path, entryId: historyId });
        return this.preemptedSync(access, actor, c, store, held);
      }
      await this.d.db.delete(installedExtensions).where(eq(installedExtensions.id, r.id));
      await writeHistory(
        this.d,
        access.server.id,
        [{ id: historyId, action: "remove", extensionId: null, extensionName: displayName(r), path: r.path, from: snapshotOf(r), to: null, keptPath: kept?.path ?? null, keptSha512: kept?.sha512 ?? null }],
        { actor: await historyActor(this.d.db, actor), jobId: null, status: "succeeded" },
      );
      return { r, kept };
    });
    const from = snapshotOf(r);
    await this.audit(actor, access, "remove", { extensionId: r.id, path: r.path, kept: kept !== null });
    void publishExtensions(this.d, access.server.id, [r.id]);
    return { restartRequired: restartRequired(access.server.state), historyEntryId: historyId, rollbackAvailable: refetchable(from) || (kept !== null && !!kept.sha512) };
  }

  // --- Modrinth ---------------------------------------------------------------------------------

  async search(access: ServerAccess, q: ModrinthSearchQuery): Promise<ModrinthSearchResult> {
    const t = requireTarget(access.server);
    const installed = new Set((await this.rows(access.server.id)).map((r) => r.modrinthProjectId).filter((x): x is string => !!x));
    try {
      return toContractSearchResult(await searchModrinth(this.d.upstreams.modrinth, fromContractSearchQuery(q, t)), installed);
    } catch (err) {
      throw this.modrinthError(err);
    }
  }

  /** `allowPrerelease` (default false, like plans and updates): beta/alpha versions are listed only on request. */
  async project(access: ServerAccess, ref: string, allowPrerelease = false): Promise<ModrinthProjectResponse> {
    const t = requireTarget(access.server);
    try {
      const p = await getModrinthProject(this.d.upstreams.modrinth, ref, t.software);
      const versions = await listCompatibleVersions(this.d.upstreams.modrinth, p.projectId, t, { allowPrerelease });
      const rows = await this.rows(access.server.id);
      return {
        project: toContractProjectDetails(p, t.software),
        versions: versions.slice(0, 100).map(toContractVersionSummary),
        installed: rows
          .filter((r) => r.modrinthProjectId === p.projectId && r.modrinth)
          .slice(0, 16)
          .map((r) => ({ extensionId: r.id, versionId: r.modrinth!.versionId, path: r.path })),
      };
    } catch (err) {
      throw this.modrinthError(err, "Modrinth project");
    }
  }

  private async planFor(access: ServerAccess, t: ExtensionTarget, req: ModrinthPlanRequest): Promise<ContractInstallPlan> {
    const rows = await this.rows(access.server.id);
    try {
      const plan = await planModrinthInstall(this.d.upstreams.modrinth, fromContractPlanRequest(req, { software: t.software, minecraftVersion: t.minecraftVersion, installed: installedRefs(rows) }));
      return toContractInstallPlan(plan, { restartRequired: restartRequired(access.server.state) });
    } catch (err) {
      throw this.modrinthError(err, "Modrinth project or version");
    }
  }

  async plan(access: ServerAccess, req: ModrinthPlanRequest): Promise<ContractInstallPlan> {
    return this.planFor(access, requireTarget(access.server), req);
  }

  /** Re-plans at install time; a different or non-installable plan → 409 `plan_changed` (nothing touched). */
  async install(access: ServerAccess, req: ModrinthInstallRequest, actor: AuditActor): Promise<{ jobId: string }> {
    const t = requireTarget(access.server);
    assertExtensionsAllowed(access.server);
    await assertNoExtensionJob(this.d.db, access.server.id);
    const { expect, ...planReq } = req;
    const plan = await this.planFor(access, t, planReq);
    const key = (f: { projectId: string; versionId: string; action: string }) => `${f.projectId}:${f.versionId}:${f.action}`;
    const fresh = new Set(plan.files.map(key));
    const expected = new Set(expect.map(key));
    if (!plan.installable || fresh.size !== expected.size || [...fresh].some((k) => !expected.has(k))) {
      throw conflict(plan.installable ? "The install plan changed; review it again" : "The install plan is no longer installable", { reason: "plan_changed", plan });
    }
    const jobId = await this.enqueue(access, EXTENSION_JOBS.install, { plan, actor: await historyActor(this.d.db, actor), userId: actorUserId(actor) }, actor);
    await this.audit(actor, access, "install", {
      project: plan.root.projectId,
      versionId: plan.root.versionId,
      files: plan.files.map((f) => ({ projectId: f.projectId, versionId: f.versionId, action: f.action, destPath: f.destPath })),
      jobId,
    });
    return { jobId };
  }

  async updates(access: ServerAccess, allowPrerelease: boolean): Promise<ExtensionUpdatesResponse> {
    const t = requireTarget(access.server);
    const rows = await this.rows(access.server.id);
    const identified = rows.filter((r) => r.sha512 && r.modrinth);
    let statuses: Awaited<ReturnType<typeof checkModrinthUpdates>> = [];
    if (identified.length) {
      try {
        statuses = await checkModrinthUpdates(this.d.upstreams.modrinth, t, installedRefs(identified), { allowPrerelease });
      } catch (err) {
        throw this.modrinthError(err);
      }
    }
    const byId = new Map(identified.map((r, i) => [r.id, statuses[i]]));
    return {
      checkedAt: this.d.clock.now(),
      items: rows.map((r) => {
        const s = byId.get(r.id);
        return s ? toContractUpdateStatus(s, r.id) : { extensionId: r.id, path: r.path, current: null, latest: null, updateAvailable: false, file: null, problem: null };
      }),
    };
  }

  async applyUpdates(access: ServerAccess, req: { extensionIds: string[]; allowPrerelease: boolean }, actor: AuditActor): Promise<{ jobId: string }> {
    requireTarget(access.server);
    const rows = await this.rows(access.server.id);
    const missing = req.extensionIds.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) throw notFound("Extension");
    const jobId = await this.enqueue(access, EXTENSION_JOBS.update, { extensionIds: req.extensionIds, allowPrerelease: req.allowPrerelease, actor: await historyActor(this.d.db, actor), userId: actorUserId(actor) }, actor);
    await this.audit(actor, access, "update", { extensionIds: req.extensionIds, allowPrerelease: req.allowPrerelease, jobId });
    return { jobId };
  }

  // --- Uploads ----------------------------------------------------------------------------------

  private async uploadPolicy() {
    return this.d.settings.get("extensions.uploads");
  }

  async createUpload(access: ServerAccess, req: { filename: string; sizeBytes: number }, sessionId: string, actor: AuditActor): Promise<{ url: string; expiresAt: number; uploadId: string }> {
    requireTarget(access.server);
    if (!(await this.uploadPolicy()).allowed) throw rejected(422, "uploads_disabled", "Extension uploads are disabled by the administrator");
    assertExtensionsAllowed(access.server);
    const id = randomUUID();
    const now = this.d.clock.now();
    const stagingPath = `${UPLOAD_DIR}/${id}.jar.part`;
    await this.d.db.insert(extensionUploads).values({
      id,
      serverId: access.server.id,
      filename: req.filename,
      sizeBytes: req.sizeBytes,
      stagingPath,
      createdBy: actorUserId(actor),
      createdAt: new Date(now),
      expiresAt: new Date(now + UPLOAD_TTL_MS),
    });
    const t = this.d.browser.issue({
      direction: "upload",
      sessionId,
      userId: access.principal.userId,
      serverId: access.server.id,
      nodeId: access.server.nodeId,
      path: stagingPath,
      maxBytes: req.sizeBytes,
      extensionUploadId: id,
    });
    await this.audit(actor, access, "upload.create", { uploadId: id, filename: req.filename, sizeBytes: req.sizeBytes });
    return { url: `/api/v1/transfers/${t.token}`, expiresAt: t.expiresAt, uploadId: id };
  }

  /** `PUT /transfers/:token` of an extension upload: streamed by the agent into the staging file. */
  async receiveUpload(access: ServerAccess, t: BrowserTransfer, body: Readable, actor: AuditActor): Promise<{ bytes: number; sha256: string }> {
    const [u] = await this.d.db.select().from(extensionUploads).where(and(eq(extensionUploads.id, t.extensionUploadId!), eq(extensionUploads.serverId, access.server.id)));
    if (!u || u.completedAt || u.expiresAt.getTime() <= this.d.clock.now()) throw notFound("Upload");
    const c = this.ctx(access, actor);
    await ensureDir(this.d.gateway, c.nodeId, c.serverId, UPLOAD_DIR, c).catch((err: unknown) => Promise.reject(commandErrorToHttp(err)));
    const transferId = randomUUID();
    const offered = this.d.transfers.offerDownload({ id: transferId, nodeId: t.nodeId, maxBytes: u.sizeBytes }, body);
    offered.catch(() => undefined);
    let result: { bytes: number; sha256: string };
    try {
      result = await this.d.gateway.send(t.nodeId, "fs.transfer.pull", { workloadId: u.serverId, path: u.stagingPath, transferId, maxBytes: u.sizeBytes }, { userId: t.userId, timeoutMs: 15 * 60_000 });
    } catch (err) {
      this.d.transfers.cancel(transferId);
      throw commandErrorToHttp(err);
    }
    await offered.catch((err: unknown) => {
      throw conflict(`upload stream failed: ${(err as Error).message}`);
    });
    await this.audit(actor, access, "upload.receive", { uploadId: u.id, bytes: result.bytes });
    return result;
  }

  async completeUpload(
    access: ServerAccess,
    uploadId: string,
    req: { replaceExisting: boolean; allowIncompatible: boolean },
    actor: AuditActor,
  ): Promise<{ extension: InstalledExtension; compatibility: NonNullable<InstalledExtension["compatibility"]>; warnings: UploadWarning[]; restartRequired: boolean }> {
    const t = requireTarget(access.server);
    const [u] = await this.d.db.select().from(extensionUploads).where(and(eq(extensionUploads.id, uploadId), eq(extensionUploads.serverId, access.server.id)));
    if (!u) throw notFound("Upload");
    if (u.completedAt && u.result) {
      // Idempotent per upload id: the original outcome (with the extension's current state).
      const [r] = await this.d.db.select().from(installedExtensions).where(eq(installedExtensions.id, u.result.extensionId));
      if (!r) throw notFound("Extension");
      return { extension: (await toDtos(this.d.db, [r]))[0]!, compatibility: u.result.compatibility, warnings: u.result.warnings as UploadWarning[], restartRequired: restartRequired(access.server.state) };
    }
    if (u.expiresAt.getTime() <= this.d.clock.now()) throw notFound("Upload");
    const policy = await this.uploadPolicy();
    if (!policy.allowed) throw rejected(422, "uploads_disabled", "Extension uploads are disabled by the administrator");
    assertExtensionsAllowed(access.server);
    assertAgentSupportsExtensions(this.d.gateway, access.server.nodeId);
    await assertNoExtensionJob(this.d.db, access.server.id);
    const c = this.ctx(access, actor);
    const send = <T extends "fs.hash" | "jar.readEntries">(type: T, payload: Parameters<typeof this.d.gateway.send<T>>[2]) =>
      this.d.gateway.send(c.nodeId, type, payload, agentOpts({ ...c, timeoutMs: 120_000 })).catch((err: unknown) => Promise.reject(commandErrorToHttp(err)));

    const hashed = (await send("fs.hash", { workloadId: u.serverId, paths: [u.stagingPath], algorithms: ["sha1", "sha512"], maxBytesPerFile: u.sizeBytes + 1, maxTotalBytes: 16 * 1024 ** 3 })).files[0];
    if (!hashed?.ok) {
      if (hashed?.error === "TOO_LARGE") throw rejected(422, "size_mismatch", "The uploaded file is larger than announced");
      throw notFound("Uploaded file (upload it first)");
    }
    if (hashed.sizeBytes !== u.sizeBytes) throw rejected(422, "size_mismatch", `The uploaded file has ${hashed.sizeBytes} bytes, ${u.sizeBytes} were announced`);
    const jar = (
      await send("jar.readEntries", {
        workloadId: u.serverId,
        paths: [u.stagingPath],
        entries: [...EXTENSION_METADATA_ENTRIES],
        maxEntryBytes: MAX_METADATA_BYTES,
        maxJarBytes: u.sizeBytes,
        maxTotalBytes: 4 * 1024 * 1024,
        hash: [],
      })
    ).jars[0];
    if (!jar?.ok) {
      if (jar?.error === "NOT_A_ZIP" || jar?.error === "AMBIGUOUS_ENTRY") throw rejected(422, "not_a_jar", "The file is not a readable jar (zip central directory)");
      throw new AppError(502, "UPSTREAM_ERROR", `The staged file could not be read (${jar?.error ?? "no result"})`);
    }
    const entries: Record<string, string> = {};
    for (const e of jar.entries) entries[e.name] = e.content;
    const info = toContractJarInfo(parseJarMetadata(entries), t.software);
    if (policy.requireMetadata && info.metadata.length === 0) throw rejected(422, "no_metadata", "The jar declares no plugin or mod (metadata required by policy)", { compatibility: info.compatibility });
    if (!info.compatibility.loadable && !req.allowIncompatible) throw rejected(422, "incompatible", "The jar cannot be loaded by this server's software", { compatibility: info.compatibility });

    const dest = `${t.installDir}/${u.filename}`;
    const staged = hashed.sha512;
    if (!staged) throw new AppError(502, "UPSTREAM_ERROR", "The agent returned no SHA-512 for the staged file");
    return this.syncChange(access, (held) => this.installUpload(access, u, t, dest, { ...hashed, sha512: staged }, info, req, actor, c, held));
  }

  /** The file-changing half of `completeUpload` (under the server's `extensions` operation lock). */
  private async installUpload(
    access: ServerAccess,
    u: typeof extensionUploads.$inferSelect,
    t: ExtensionTarget,
    dest: string,
    hashed: { sizeBytes: number; mtime: number; sha1?: string | undefined; sha512: string },
    info: ReturnType<typeof toContractJarInfo>,
    req: { replaceExisting: boolean; allowIncompatible: boolean },
    actor: AuditActor,
    c: FileCtx,
    held: () => Promise<boolean>,
  ): Promise<{ extension: InstalledExtension; compatibility: NonNullable<InstalledExtension["compatibility"]>; warnings: UploadWarning[]; restartRequired: boolean }> {
    const [again] = await this.d.db.select({ completedAt: extensionUploads.completedAt }).from(extensionUploads).where(eq(extensionUploads.id, u.id));
    if (!again || again.completedAt) throw conflict("The upload was completed meanwhile; repeat the request", { reason: "exists", existing: null });
    const rows = await this.rows(access.server.id);
    const existingRow = rows.find((r) => r.path === dest) ?? null;
    const onDisk = existingRow !== null || (await exists(this.d, c, dest).catch((err: unknown) => Promise.reject(commandErrorToHttp(err))));
    if (onDisk && !req.replaceExisting) throw rejected(409, "exists", `${dest} already exists`, { existing: { extensionId: existingRow?.id ?? null, path: dest } });

    const warnings: UploadWarning[] = [];
    const historyId = randomUUID();
    let kept: Kept | null = null;
    const existingSnapshot = {
      name: existingRow ? displayName(existingRow) : u.filename,
      path: dest,
      from: existingRow ? snapshotOf(existingRow) : ({ source: "unknown", path: dest, projectId: null, versionId: null, versionNumber: null, sha512: null, sizeBytes: null } as const),
    };
    // The undo record of this completion (kept file back to `dest`, placed upload back to staging).
    const store = memoryUndo();
    const entry: PendingEntry = { id: historyId, action: "upload", extensionId: existingRow?.id ?? null, extensionName: existingSnapshot.name, path: dest, from: onDisk ? existingSnapshot.from : null, to: null, keptPath: null, keptSha512: null };
    await upsertEntry(store, entry);
    if (!(await held())) throw preempted();
    if (onDisk) {
      try {
        // The digest of what was actually kept (#6, hashed before and verified after the move; also for unscanned paths).
        kept = await keepFile(this.d, c, dest, historyId);
      } catch (err) {
        if (!(err instanceof AgentCommandError && err.code === "NOT_FOUND")) {
          if (err instanceof UnverifiedKeptError) await this.recordUnverified(access, actor, historyId, "upload", existingSnapshot, err);
          throw fileError(err);
        }
      }
      if (kept) {
        Object.assign(entry, { keptPath: kept.path, keptSha512: kept.sha512 });
        await upsertEntry(store, entry);
        await pushUndo(store, { kind: "restore", kept: kept.path, sha512: kept.sha512, path: dest, entryId: historyId });
      }
      warnings.push({ code: "REPLACED_EXISTING", level: "info", message: `Replaced ${dest} (kept for rollback)` });
    }
    /** Refuses the completion after running the fenced undo (and records whatever could not be put back). */
    const failUpload = async (reason: string, message: string, err: unknown): Promise<never> => {
      store.log.started = true;
      store.log.error = { code: reason.toUpperCase(), message };
      const outcome = await fencedUndo(this.d, c, store, held);
      const r = describeUndo(store.log, outcome);
      const leftOver = outcome.skipped || store.log.entries.some((e) => e.leftInKeep);
      if (leftOver) await writeHistory(this.d, access.server.id, store.log.entries, { actor: await historyActor(this.d.db, actor), jobId: null, status: "failed", error: r.message });
      await this.d.audit.record({
        ...actor,
        action: "server.extension.upload.complete",
        targetType: "server",
        targetId: access.server.id,
        outcome: "failed",
        details: { uploadId: u.id, path: dest, reason, undoSkipped: outcome.skipped, keptPath: leftOver ? (kept?.path ?? null) : null, error: (err as Error | null)?.message ?? null },
      });
      throw new AppError(409, "CONFLICT", r.message, {
        reason: outcome.skipped ? "preempted_undo_skipped" : store.log.failed.length ? "undo_failed" : reason,
        keptPath: leftOver ? (kept?.path ?? null) : null,
      });
    };
    if (kept && !(await held())) return failUpload("preempted", "The upload was interrupted by a stop/restart/kill of the server", null);
    try {
      // Verified after the move: staged bytes that changed after they were checked are moved back and refused.
      await placeVerified(this.d, c, u.stagingPath, dest, hashed.sha512);
    } catch (err) {
      if (err instanceof PlacementStuckError) {
        // The destination holds bytes nobody vouches for: never restore onto it; record the state for the operator.
        entry.leftInKeep = true;
        await upsertEntry(store, entry);
        await writeHistory(this.d, access.server.id, store.log.entries, { actor: await historyActor(this.d.db, actor), jobId: null, status: "failed", error: err.message });
        await this.d.audit.record({ ...actor, action: "server.extension.upload.complete", targetType: "server", targetId: access.server.id, outcome: "failed", details: { uploadId: u.id, path: dest, reason: "placement_stuck", keptPath: kept?.path ?? null } });
        throw new AppError(409, "CONFLICT", kept ? `${err.message}; the replaced file stays at ${kept.path}` : err.message, { reason: "placement_stuck", path: dest, keptPath: kept?.path ?? null });
      }
      if (err instanceof JobError && err.code === "FILE_CHANGED") return failUpload("upload_changed", "The staged file changed after it was checked; upload it again", err);
      if (err instanceof JobError && err.code === "CONFLICT") return failUpload("exists", `${dest} appeared meanwhile; nothing was replaced`, err);
      if (kept) return failUpload("install_failed", `Installing the upload failed: ${(err as Error).message}`, err);
      throw commandErrorToHttp(err);
    }
    await pushUndo(store, { kind: "restore", kept: dest, sha512: hashed.sha512, path: u.stagingPath });
    if (!(await held())) return failUpload("preempted", "The upload was interrupted by a stop/restart/kill of the server", null);
    if (!info.compatibility.loadable) warnings.push({ code: "INCOMPATIBLE_ALLOWED", level: "warning", message: "Installed although the server software cannot load it" });
    if (info.metadata.length === 0) warnings.push({ code: "NO_METADATA", level: "warning", message: "No plugin/mod metadata found in the jar" });
    const selected = info.compatibility.metadataIndex !== null ? info.metadata[info.compatibility.metadataIndex] : undefined;
    if (selected) {
      const dup = rows.find((r) => r.path !== dest && r.metadata.some((m) => m.id.toLowerCase() === selected.id.toLowerCase() && m.format === selected.format));
      if (dup) warnings.push({ code: "DUPLICATE_ID", level: "warning", message: `${dup.path} declares the same ${t.kind === "plugin" ? "plugin name" : "mod id"} (${selected.id}); the server loads only one of them` });
    }
    const now = new Date(this.d.clock.now());
    const values = {
      kind: t.kind,
      source: "upload",
      path: dest,
      filename: u.filename,
      enabled: true,
      sizeBytes: hashed.sizeBytes,
      mtime: new Date(hashed.mtime),
      sha512: hashed.sha512 ?? null,
      sha1: hashed.sha1 ?? null,
      metadata: info.metadata,
      compatibility: info.compatibility,
      modrinth: null,
      modrinthProjectId: null,
      identifiedSha512: null,
      installedAt: now,
      installedBy: actorUserId(actor),
      lastSeenAt: now,
    };
    const row = existingRow
      ? (await this.d.db.update(installedExtensions).set(values).where(eq(installedExtensions.id, existingRow.id)).returning())[0]!
      : (await this.d.db.insert(installedExtensions).values({ id: randomUUID(), serverId: access.server.id, firstSeenAt: now, ...values }).returning())[0]!;
    await writeHistory(
      this.d,
      access.server.id,
      [
        {
          id: historyId,
          action: "upload",
          extensionId: row.id,
          extensionName: displayName(row),
          path: dest,
          from: existingRow ? snapshotOf(existingRow) : onDisk ? { source: "unknown", path: dest, projectId: null, versionId: null, versionNumber: null, sha512: null, sizeBytes: null } : null,
          to: snapshotOf(row),
          keptPath: kept?.path ?? null,
          keptSha512: kept?.sha512 ?? null,
        },
      ],
      { actor: await historyActor(this.d.db, actor), jobId: null, status: "succeeded" },
    );
    await this.d.db.update(extensionUploads).set({ completedAt: now, result: { extensionId: row.id, warnings, compatibility: info.compatibility } }).where(eq(extensionUploads.id, u.id));
    await this.audit(actor, access, "upload.complete", { uploadId: u.id, path: dest, extensionId: row.id, sha512: row.sha512, replaced: onDisk, allowIncompatible: req.allowIncompatible, loadable: info.compatibility.loadable });
    void publishExtensions(this.d, access.server.id, [row.id]);
    return { extension: (await toDtos(this.d.db, [row]))[0]!, compatibility: info.compatibility, warnings, restartRequired: restartRequired(access.server.state) };
  }

  // --- History and rollback -----------------------------------------------------------------------

  async history(access: ServerAccess, q: { limit: number; cursor?: string | undefined; extensionId?: string | undefined }): Promise<{ items: ExtensionHistoryEntry[]; nextCursor: string | null }> {
    requireTarget(access.server);
    const cursor = decodeCursor(TimeIdCursor, q.cursor);
    const conds = [eq(extensionHistory.serverId, access.server.id)];
    if (q.extensionId) conds.push(eq(extensionHistory.extensionId, q.extensionId));
    if (cursor) {
      const t = new Date(cursor.t);
      conds.push(or(lt(extensionHistory.at, t), and(eq(extensionHistory.at, t), lt(extensionHistory.id, cursor.id)))!);
    }
    const rows = await this.d.db
      .select()
      .from(extensionHistory)
      .where(and(...conds))
      .orderBy(desc(extensionHistory.at), desc(extensionHistory.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const oldest = page.at(-1)?.at;
    const newer = oldest
      ? await this.d.db
          .select()
          .from(extensionHistory)
          .where(and(eq(extensionHistory.serverId, access.server.id), eq(extensionHistory.status, "succeeded"), gt(extensionHistory.at, oldest)))
      : [];
    const now = this.d.clock.now();
    const last = page.at(-1);
    return {
      items: page.map((e) => historyDto(e, newer.filter((n) => n.at > e.at), now)),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.at.getTime(), id: last.id }) : null,
    };
  }

  async rollback(access: ServerAccess, entryId: string, actor: AuditActor): Promise<{ jobId: string }> {
    requireTarget(access.server);
    const [e] = await this.d.db.select().from(extensionHistory).where(and(eq(extensionHistory.id, entryId), eq(extensionHistory.serverId, access.server.id)));
    if (!e) throw notFound("History entry");
    const newer = await this.d.db.select().from(extensionHistory).where(and(eq(extensionHistory.serverId, access.server.id), eq(extensionHistory.status, "succeeded"), gt(extensionHistory.at, e.at)));
    const unavailable = (cause: string) => conflict("This change can no longer be rolled back", { reason: "rollback_unavailable", cause });
    const r = rollbackOf(e, newer, this.d.clock.now());
    if (!r.available) throw unavailable(r.reason!);
    if (e.from && !refetchable(e.from)) {
      // The kept jar must still be exactly the file that was kept.
      const sha = await sha512Of(this.d, this.ctx(access, actor), e.keptPath!).catch((err: unknown) => Promise.reject(commandErrorToHttp(err)));
      if (sha !== e.keptSha512) throw unavailable("file_unavailable");
    }
    const jobId = await this.enqueue(access, EXTENSION_JOBS.rollback, { entryId, actor: await historyActor(this.d.db, actor), userId: actorUserId(actor) }, actor);
    await this.audit(actor, access, "rollback", { entryId, action: e.action, path: e.path, jobId });
    return { jobId };
  }

  // --- Retention (maintenance) ---------------------------------------------------------------------

  /** Kept jars beyond 30 days / 20 per server are deleted (node must be connected); history rows after 1 year. */
  async prune(): Promise<void> {
    const now = this.d.clock.now();
    // A synchronous change's lock left behind by a crashed request (they take seconds, never 30 minutes).
    await this.d.state.releaseStaleLocks("extensions", 30 * 60_000);
    const stale = await this.d.db.execute<{ id: string; server_id: string; kept_path: string; node_id: string }>(sql`
      SELECT x.id, x.server_id, x.kept_path, s.node_id FROM (
        SELECT id, server_id, kept_path, kept_until, row_number() OVER (PARTITION BY server_id ORDER BY at DESC) AS rn
          FROM extension_history WHERE kept_path IS NOT NULL) x
        JOIN servers s ON s.id = x.server_id
       WHERE x.rn > ${KEPT_PER_SERVER} OR x.kept_until < ${new Date(now)}`);
    for (const k of stale.rows) {
      // Only files inside the keep area are ever deleted (L4); anything else is forgotten, not touched.
      const inKeep = keptAreaPath(k.kept_path);
      if (!inKeep) {
        this.d.logger.warn({ serverId: k.server_id, historyId: k.id }, "a kept path outside the keep area was not deleted");
        await this.d.db.update(extensionHistory).set({ keptPath: null, keptSha512: null, keptUntil: null }).where(eq(extensionHistory.id, k.id));
        continue;
      }
      if (!this.d.gateway.isReady(k.node_id)) continue;
      try {
        await deleteFile(this.d, { serverId: k.server_id, nodeId: k.node_id, timeoutMs: 30_000 }, inKeep);
        await this.d.db.update(extensionHistory).set({ keptPath: null, keptSha512: null, keptUntil: null }).where(eq(extensionHistory.id, k.id));
      } catch (err) {
        this.d.logger.warn({ err: (err as Error).message, serverId: k.server_id }, "pruning a kept extension jar failed");
      }
    }
    await this.d.db.delete(extensionHistory).where(and(lt(extensionHistory.at, new Date(now - HISTORY_RETENTION_MS)), isNull(extensionHistory.keptPath)));
    // Unfinished uploads expire after 1 h (staging file removed); completed rows are kept 1 day for idempotent replays.
    const expired = await this.d.db
      .select({ u: extensionUploads, nodeId: servers.nodeId })
      .from(extensionUploads)
      .innerJoin(servers, eq(servers.id, extensionUploads.serverId))
      .where(or(and(isNull(extensionUploads.completedAt), lt(extensionUploads.expiresAt, new Date(now))), and(isNotNull(extensionUploads.completedAt), lt(extensionUploads.completedAt, new Date(now - 86_400_000)))));
    for (const { u, nodeId } of expired) {
      if (!u.completedAt) {
        if (!this.d.gateway.isReady(nodeId)) continue;
        try {
          await deleteFile(this.d, { serverId: u.serverId, nodeId, timeoutMs: 30_000 }, u.stagingPath);
        } catch (err) {
          this.d.logger.warn({ err: (err as Error).message, uploadId: u.id }, "removing an expired extension upload failed");
          continue;
        }
      }
      await this.d.db.delete(extensionUploads).where(eq(extensionUploads.id, u.id));
    }
  }

  /** History rows whose kept file was pruned: no rollback from the keep area (rows stay for the record). */
  static readonly keptRetentionMs = KEPT_RETENTION_MS;
}

