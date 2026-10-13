import { createHash, randomUUID } from "node:crypto";
import type { ExtensionFileSnapshot, ExtensionHistoryAction, ModrinthPlannedFile, ModrinthRef } from "@blockforge/contracts";
import { assertAllowedUrl, MODRINTH_HOSTS } from "@blockforge/minecraft";
import { and, asc, eq, inArray } from "drizzle-orm";
import { AgentCommandError } from "../agents/gateway.js";
import type { DbOrTx } from "../db/client.js";
import { extensionHistory, installedExtensions } from "../db/schema/index.js";
import { JobError, type JobLogLevel } from "../jobs/types.js";
import {
  agentOpts,
  displayName,
  ensureDir,
  FETCH_DIR,
  jobAgentError,
  KEPT_DIR,
  KEPT_RETENTION_MS,
  keptPathOf,
  snapshotOf,
  type ExtensionDeps,
  type ExtensionRow,
  type HistoryRow,
  type SendOpts,
} from "./model.js";

/*
 * Verify-after-move: the agent's `fs.rename` takes no expected digest, so every move of a jar is
 * bracketed by hashes — before (what we decided to move) and after (what actually arrived). A swap in
 * the window between the first hash and the rename is detected after the fact and the move is undone
 * or refused; it is not prevented. An agent-side "rename if digest matches" would close that residual
 * window (possible later improvement; not part of the agent protocol today).
 */

export type HistoryActorFields = Pick<HistoryRow, "actorType" | "actorId" | "actorName">;

export interface FileCtx extends SendOpts {
  serverId: string;
  nodeId: string;
  log?: (level: JobLogLevel, message: string) => Promise<void>;
}

/**
 * Deterministic UUID (v4 layout) for `(jobId, key)`: a resumed job step derives the same history ids and
 * keep-area names as the interrupted attempt. Without a job: random.
 */
export function stableId(jobId: string | null | undefined, key: string): string {
  if (!jobId) return randomUUID();
  const h = createHash("sha256").update(`${jobId}\0${key}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** `fs.delete` that tolerates a missing file. */
export async function deleteFile(d: ExtensionDeps, c: FileCtx, path: string): Promise<void> {
  try {
    await d.gateway.send(c.nodeId, "fs.delete", { workloadId: c.serverId, path, recursive: false }, agentOpts(c));
  } catch (err) {
    if (err instanceof AgentCommandError && err.code === "NOT_FOUND") return;
    throw err;
  }
}

export async function exists(d: ExtensionDeps, c: FileCtx, path: string): Promise<boolean> {
  try {
    await d.gateway.send(c.nodeId, "fs.stat", { workloadId: c.serverId, path }, agentOpts(c));
    return true;
  } catch (err) {
    if (err instanceof AgentCommandError && err.code === "NOT_FOUND") return false;
    throw err;
  }
}

/** SHA-512 of one regular file, or the agent's per-file error (`NOT_FOUND`, `NOT_REGULAR`, `IO_ERROR`, …). */
export async function hashFile(d: ExtensionDeps, c: FileCtx, path: string): Promise<{ ok: true; sha512: string } | { ok: false; error: string }> {
  const r = await d.gateway.send(c.nodeId, "fs.hash", { workloadId: c.serverId, paths: [path], algorithms: ["sha512"], maxBytesPerFile: 2 * 1024 ** 3, maxTotalBytes: 16 * 1024 ** 3 }, agentOpts(c));
  const f = r.files.length === 1 && r.files[0]?.path === path ? r.files[0] : undefined;
  if (!f) return { ok: false, error: "PROTOCOL" };
  if (!f.ok) return { ok: false, error: f.error };
  return f.sha512 ? { ok: true, sha512: f.sha512 } : { ok: false, error: "NO_DIGEST" };
}

/** SHA-512 of one file (null when it does not exist or cannot be hashed). */
export async function sha512Of(d: ExtensionDeps, c: FileCtx, path: string): Promise<string | null> {
  const h = await hashFile(d, c, path);
  return h.ok ? h.sha512 : null;
}

/** A jar in the keep area and the SHA-512 it had when it was moved there. */
export interface Kept {
  path: string;
  sha512: string;
}

/** A kept file that changed (or vanished) since it was kept is never moved back. */
export class KeptFileChangedError extends JobError {
  constructor(
    readonly keptPath: string,
    readonly target: string,
    detail = "is missing or changed since it was kept",
  ) {
    super("KEPT_FILE_CHANGED", `the kept file ${keptPath} ${detail}; it was not restored to ${target} (left in the keep area)`);
    this.name = "KeptFileChangedError";
  }
}

/**
 * A file in the keep area whose content cannot be vouched for (it changed while being moved there, or an
 * interrupted attempt left it without a recorded digest). It is never restored automatically; the
 * history row points at it (no digest) so an operator can inspect it, and pruning removes it later.
 */
export class UnverifiedKeptError extends JobError {
  constructor(
    readonly keptPath: string,
    detail: string,
  ) {
    super("KEPT_FILE_UNVERIFIED", `the kept file ${keptPath} ${detail}; it is left in the keep area for inspection and will not be restored`);
    this.name = "UnverifiedKeptError";
  }
}

/** A file could not be hashed, so it was not moved (nothing changed). */
export class HashFailedError extends JobError {
  constructor(path: string, reason: string) {
    super("HASH_FAILED", `${path} could not be hashed (${reason}); nothing was moved`);
    this.name = "HashFailedError";
  }
}

/**
 * Moves a jar into the keep area (`.blockforge/extensions/kept/<name>.jar`): hashed before the move
 * (`beforeMove` gets the digest, e.g. to journal it), verified after it. A missing source fails with
 * the agent's `NOT_FOUND`; any other hash error fails before anything moves.
 */
export async function keepFile(d: ExtensionDeps, c: FileCtx, path: string, name: string, o: { beforeMove?: (sha512: string) => Promise<void> } = {}): Promise<Kept> {
  const h = await hashFile(d, c, path);
  if (!h.ok) {
    if (h.error === "NOT_FOUND") throw new AgentCommandError("NOT_FOUND", `${path} does not exist`, false);
    throw new HashFailedError(path, h.error);
  }
  await o.beforeMove?.(h.sha512);
  await ensureDir(d.gateway, c.nodeId, c.serverId, KEPT_DIR, c);
  const kept = keptPathOf(name);
  await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: path, to: kept }, agentOpts(c));
  if ((await sha512Of(d, c, kept)) !== h.sha512) throw new UnverifiedKeptError(kept, `changed while it was being moved from ${path}`);
  return { path: kept, sha512: h.sha512 };
}

/** Journal state of one keep: the digest recorded before the move, and whether the move was confirmed. */
export interface KeepRecord {
  sha512: string;
  moved: boolean;
}

/**
 * `keepFile` for resumable jobs. The digest is journaled before the move and the move confirmed after
 * it; on resume a confirmed keep is reused, a pending one is adopted only if the kept file still has the
 * journaled digest, and a kept file without a journaled digest is never adopted (`UnverifiedKeptError`).
 * Null: the source does not exist (nothing to keep).
 */
export async function keepJournaled(
  d: ExtensionDeps,
  c: FileCtx,
  path: string,
  name: string,
  jr: { record: KeepRecord | undefined; save(r: KeepRecord): Promise<void>; resumed: boolean },
): Promise<Kept | null> {
  const keptPath = keptPathOf(name);
  if (jr.record?.moved) return { path: keptPath, sha512: jr.record.sha512 };
  if (jr.record || jr.resumed) {
    const [src, kept] = [await exists(d, c, path), await exists(d, c, keptPath)];
    if (kept) {
      if (!jr.record) throw new UnverifiedKeptError(keptPath, "was found without a digest recorded before the move");
      if (src) throw new UnverifiedKeptError(keptPath, `exists while ${path} is still in place`);
      if ((await sha512Of(d, c, keptPath)) !== jr.record.sha512) throw new UnverifiedKeptError(keptPath, "no longer has the digest recorded before the move");
      await jr.save({ sha512: jr.record.sha512, moved: true });
      return { path: keptPath, sha512: jr.record.sha512 };
    }
    if (!src) return null;
  }
  try {
    const k = await keepFile(d, c, path, name, { beforeMove: (sha512) => jr.save({ sha512, moved: false }) });
    await jr.save({ sha512: k.sha512, moved: true });
    return k;
  } catch (err) {
    if (err instanceof AgentCommandError && err.code === "NOT_FOUND") return null;
    throw err;
  }
}

/**
 * Moves `from` to `to` (never overwriting) and verifies `to` has `sha512` afterwards; on a mismatch the
 * file is moved back to `from` (when still free) and the move is refused.
 */
export async function placeVerified(d: ExtensionDeps, c: FileCtx, from: string, to: string, sha512: string): Promise<void> {
  // `fs.rename` does not create parents (a fresh server may have no plugins/ or mods/ yet).
  const dir = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
  if (dir) await ensureDir(d.gateway, c.nodeId, c.serverId, dir, c);
  try {
    await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from, to }, agentOpts(c));
  } catch (err) {
    if (err instanceof AgentCommandError && (err.code === "ALREADY_EXISTS" || err.code === "CONFLICT")) throw new JobError("CONFLICT", `${to} is occupied by another file; it was not replaced`);
    throw err;
  }
  if ((await sha512Of(d, c, to)) === sha512) return;
  try {
    await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: to, to: from }, agentOpts(c));
  } catch (e) {
    throw new PlacementStuckError(to, from, (e as Error).message);
  }
  throw new JobError("FILE_CHANGED", `${from} changed while it was being moved to ${to}; it was moved back`);
}

/** A file that changed during a move could not be moved back: `path` holds bytes nobody vouches for. */
export class PlacementStuckError extends JobError {
  constructor(
    readonly path: string,
    readonly from: string,
    reason: string,
  ) {
    super("FILE_STUCK", `${path} received bytes that changed during the move from ${from}, and they could not be moved back (${reason}); check ${path} by hand`);
    this.name = "PlacementStuckError";
  }
}

/**
 * Moves a kept jar back to `to` only while it still has the digest taken when it was kept (verified
 * before and after the move; the agent's `fs.rename` never overwrites an existing `to`).
 */
export async function restoreKept(d: ExtensionDeps, c: FileCtx, kept: string, expectedSha512: string | null, to: string): Promise<void> {
  const actual = await sha512Of(d, c, kept);
  if (!expectedSha512 || actual !== expectedSha512) throw new KeptFileChangedError(kept, to);
  try {
    await placeVerified(d, c, kept, to, expectedSha512);
  } catch (err) {
    if (err instanceof JobError && err.code === "FILE_CHANGED") throw new KeptFileChangedError(kept, to, "changed while it was being restored");
    throw err;
  }
}

/**
 * Deletes a file this job wrote, only while it still has the digest it was written with: it is moved to
 * a private name first and verified there (else put back and refused).
 */
export async function deleteCreated(d: ExtensionDeps, c: FileCtx, path: string, sha512: string): Promise<void> {
  const actual = await sha512Of(d, c, path);
  if (actual === null) return;
  if (actual !== sha512) throw new JobError("FILE_CHANGED", `${path} changed after it was written; it was not deleted`);
  await ensureDir(d.gateway, c.nodeId, c.serverId, FETCH_DIR, c);
  const doomed = `${FETCH_DIR}/${randomUUID()}.delete`;
  await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: path, to: doomed }, agentOpts(c));
  if ((await sha512Of(d, c, doomed)) !== sha512) {
    try {
      await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: doomed, to: path }, agentOpts(c));
    } catch (e) {
      throw new JobError("FILE_ORPHANED", `${path} changed while it was being removed and could not be put back (${(e as Error).message}); it is at ${doomed}`);
    }
    throw new JobError("FILE_CHANGED", `${path} changed while it was being removed; it was put back, not deleted`);
  }
  await deleteFile(d, c, doomed);
}

/** `artifact.fetch` of a Modrinth file (CDN host re-checked, SHA-512 verified by the agent). */
export async function fetchModrinthFile(d: ExtensionDeps, c: FileCtx, f: { url: string; destPath: string; sha512: string; sizeBytes: number }): Promise<void> {
  const url = assertAllowedUrl(f.url, d.upstreams.modrinth.cdnHosts ?? MODRINTH_HOSTS.cdn, "artifact").href;
  await d.gateway.send(
    c.nodeId,
    "artifact.fetch",
    { workloadId: c.serverId, url, destPath: f.destPath, checksum: { algorithm: "sha512", value: f.sha512 }, maxBytes: f.sizeBytes, cache: true },
    agentOpts({ ...c, timeoutMs: c.timeoutMs ?? 15 * 60_000 }),
  );
}

export function modrinthRefOf(f: Pick<ModrinthPlannedFile, "projectId" | "projectSlug" | "projectTitle" | "versionId" | "versionNumber" | "versionType">): ModrinthRef {
  return {
    projectId: f.projectId,
    slug: f.projectSlug,
    title: f.projectTitle,
    versionId: f.versionId,
    versionNumber: f.versionNumber,
    versionType: f.versionType,
    iconUrl: null,
    pageUrl: `https://modrinth.com/project/${encodeURIComponent(f.projectSlug ?? f.projectId)}`,
  };
}

export const plannedSnapshot = (f: ModrinthPlannedFile): ExtensionFileSnapshot => ({
  source: "modrinth",
  path: f.destPath,
  projectId: f.projectId,
  versionId: f.versionId,
  versionNumber: f.versionNumber,
  sha512: f.sha512,
  sizeBytes: f.sizeBytes,
});

/** A placeholder snapshot of a file found on disk without a row. */
const bareSnapshot = (path: string): ExtensionFileSnapshot => ({ source: "unknown", path, projectId: null, versionId: null, versionNumber: null, sha512: null, sizeBytes: null });

export interface PendingEntry {
  id: string;
  action: ExtensionHistoryAction;
  extensionId: string | null;
  extensionName: string;
  path: string;
  from: ExtensionFileSnapshot | null;
  to: ExtensionFileSnapshot | null;
  keptPath: string | null;
  keptSha512: string | null;
  /** A failed change could not put the kept file back: the row keeps `keptPath` (and its digest, if any) for inspection and pruning. */
  leftInKeep?: boolean;
}

export const pendingOf = (r: HistoryRow): PendingEntry => ({
  id: r.id,
  action: r.action as ExtensionHistoryAction,
  extensionId: r.extensionId,
  extensionName: r.extensionName,
  path: r.path,
  from: r.from ?? null,
  to: r.to ?? null,
  keptPath: r.keptPath,
  keptSha512: r.keptSha512,
});

export async function writeHistory(
  d: ExtensionDeps,
  serverId: string,
  entries: readonly PendingEntry[],
  o: { actor: HistoryActorFields; jobId: string | null; status: "succeeded" | "failed"; error?: string | null },
  db: DbOrTx = d.db,
): Promise<void> {
  if (!entries.length) return;
  const now = d.clock.now();
  await db.insert(extensionHistory).values(
    entries.map((e, i) => {
      // A failed change put the kept file back: nothing is kept for it — unless it could not be put back.
      const keep = o.status === "succeeded" || e.leftInKeep === true;
      const keptPath = keep ? e.keptPath : null;
      return {
        id: e.id,
        serverId,
        extensionId: e.extensionId,
        action: e.action,
        status: o.status,
        extensionName: e.extensionName.slice(0, 256),
        path: e.path,
        from: e.from,
        to: e.to,
        ...o.actor,
        // Strictly increasing within one write so "newest entry" is well defined.
        at: new Date(now + i),
        jobId: o.jobId,
        error: o.status === "failed" ? (o.error ?? "failed").slice(0, 2048) : null,
        keptPath,
        keptSha512: keep ? e.keptSha512 : null,
        keptUntil: keptPath ? new Date(now + KEPT_RETENTION_MS) : null,
      };
    }),
  );
}

// --- Undo -------------------------------------------------------------------------------------

/**
 * One reversible file operation: `delete` removes a file this change wrote (while it has `sha512`),
 * `restore` moves `kept` back to `path` (while it has `sha512`; also used to move a placed file back).
 */
export type UndoStep = { kind: "delete"; path: string; sha512: string } | { kind: "restore"; kept: string; sha512: string; path: string; entryId?: string };

/**
 * The durable undo record of one change: every reversible step from the moment it happened, the history
 * entries, and — once the change failed — the error and which steps were attempted/failed. Jobs keep it
 * in `ctx.state` (checkpointed on every change), so an undo interrupted by a crash is finished (or
 * deliberately skipped) on resume instead of the apply being resumed.
 */
export interface UndoLog {
  steps: UndoStep[];
  entries: PendingEntry[];
  started: boolean;
  error: { code: string; message: string } | null;
  done: number[];
  failed: number[];
  notes: string[];
}

export interface UndoStore {
  log: UndoLog;
  save(): Promise<void>;
}

export const emptyUndoLog = (): UndoLog => ({ steps: [], entries: [], started: false, error: null, done: [], failed: [], notes: [] });

/** An undo record that lives only as long as the request (synchronous changes). */
export function memoryUndo(): UndoStore {
  return { log: emptyUndoLog(), save: async () => undefined };
}

const sameStep = (a: UndoStep, b: UndoStep) => a.kind === b.kind && a.path === b.path && a.sha512 === b.sha512 && (a.kind !== "restore" || (b.kind === "restore" && a.kept === b.kept));

/** Records a step (once) and persists the record. */
export async function pushUndo(store: UndoStore, step: UndoStep): Promise<void> {
  if (store.log.steps.some((s) => sameStep(s, step))) return;
  store.log.steps.push(step);
  await store.save();
}

/** Records (or refreshes) a history entry by id; the live object is kept so later field changes are persisted. */
export async function upsertEntry(store: UndoStore, entry: PendingEntry): Promise<void> {
  const i = store.log.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) {
    if (store.log.entries[i] === entry) return;
    store.log.entries[i] = entry;
  } else store.log.entries.push(entry);
  await store.save();
}

async function runStep(d: ExtensionDeps, c: FileCtx, s: UndoStep): Promise<void> {
  if (s.kind === "delete") await deleteCreated(d, c, s.path, s.sha512);
  else await restoreKept(d, c, s.kept, s.sha512, s.path);
}

/**
 * Runs the recorded undo — fenced. While the change still holds its lock (`stillHeld`) it undoes under
 * it; after a pre-emption it may only touch plugin/mod files under a new cleanup hold (`lockForCleanup`:
 * no other operation, server stopped or crashed). Without one — or if the hold is lost midway — nothing
 * (more) is touched and the result is `skipped`. Steps run newest first, once each (progress persisted).
 */
export async function fencedUndo(d: ExtensionDeps, c: FileCtx, store: UndoStore, stillHeld: () => Promise<boolean>): Promise<{ skipped: boolean; preempted: boolean }> {
  const log = store.log;
  let held = stillHeld;
  let token: string | null = null;
  let preempted = false;
  if (!(await stillHeld())) {
    preempted = true;
    token = await d.state.lockForCleanup(c.serverId);
    if (!token) return { skipped: true, preempted };
    const t = token;
    held = () => d.state.holdsToken(c.serverId, t);
  }
  try {
    for (let i = log.steps.length - 1; i >= 0; i--) {
      if (log.done.includes(i)) continue;
      if (!(await held())) return { skipped: true, preempted: true };
      try {
        await runStep(d, c, log.steps[i]!);
      } catch (e) {
        log.failed.push(i);
        log.notes.push((e as Error).message);
        await c.log?.("error", `Undo failed for ${log.steps[i]!.path}: ${(e as Error).message}`);
      }
      log.done.push(i);
      await store.save();
    }
    return { skipped: false, preempted };
  } finally {
    if (token) await d.state.unlock(c.serverId, token);
  }
}

/**
 * Turns a fenced undo's outcome into the failure record: entries whose kept file did not go back keep
 * `keptPath`/`keptSha512`; when the undo was skipped the error lists every kept file and every file the
 * change wrote (path + SHA-512) so an operator can put things right from the history.
 */
export function describeUndo(log: UndoLog, outcome: { skipped: boolean }): { message: string; code: string } {
  const error = log.error ?? { code: "FAILED", message: "the change failed" };
  const notDone = (i: number) => !log.done.includes(i) || log.failed.includes(i);
  log.steps.forEach((s, i) => {
    if (s.kind === "restore" && s.entryId && notDone(i)) {
      const e = log.entries.find((x) => x.id === s.entryId);
      if (e) e.leftInKeep = true;
    }
  });
  if (outcome.skipped) {
    const left = log.steps.filter((_, i) => notDone(i));
    const kept = left.filter((s) => s.kind === "restore").map((s) => `${(s as { kept: string }).kept} (was ${s.path}, sha512 ${s.sha512})`);
    const written = left.filter((s) => s.kind === "delete").map((s) => `${s.path} (sha512 ${s.sha512})`);
    const message =
      `${error.message}; undo skipped: another operation holds the server or it is not stopped, so no file was touched` +
      (kept.length ? `; kept files: ${kept.join(", ")}` : "") +
      (written.length ? `; files written by this change: ${written.join(", ")}` : "") +
      (log.notes.length ? `; undo: ${log.notes.join("; ")}` : "");
    return { code: "PREEMPTED_UNDO_SKIPPED", message };
  }
  return { code: error.code, message: log.notes.length ? `${error.message}; undo: ${log.notes.join("; ")}` : error.message };
}

const errorOf = (err: unknown, what: string): { code: string; message: string } => {
  const e = jobAgentError(err, what);
  if (e instanceof JobError) return { code: e.code, message: e.message };
  return { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
};

/**
 * The failure path of a job's change: marks the undo record started (persisted), runs the fenced undo,
 * writes the failed history rows and throws the resulting `JobError`. Also the resume path of an undo
 * that a crash interrupted (`err` undefined, record already started).
 */
export async function failWithUndo(
  d: ExtensionDeps,
  c: FileCtx,
  store: UndoStore,
  o: { err?: unknown; what: string; stillHeld: () => Promise<boolean>; actor: HistoryActorFields; jobId: string | null },
): Promise<never> {
  if (!store.log.started) {
    store.log.started = true;
    store.log.error = errorOf(o.err, o.what);
    await store.save();
  }
  const outcome = await fencedUndo(d, c, store, o.stillHeld);
  const r = describeUndo(store.log, outcome);
  await writeHistory(d, c.serverId, store.log.entries, { actor: o.actor, jobId: o.jobId, status: "failed", error: r.message });
  throw new JobError(r.code, r.message);
}

/**
 * Progress of an interrupted apply, persisted by the job (`ctx.state`) before and after every file
 * operation: whether the destination was occupied and the keep records (digest journaled before each move).
 */
export interface ApplyJournal {
  get(id: string): JournalEntry | undefined;
  set(id: string, e: JournalEntry): Promise<void>;
}
export interface JournalEntry {
  atDest: boolean;
  /** Source path → keep record. */
  kept: Record<string, KeepRecord>;
}

export interface ApplyResult {
  entries: PendingEntry[];
  /** The history of this apply was already written by an interrupted attempt (do not write it again). */
  recorded: boolean;
}

/**
 * Applies planned Modrinth files in dependency order: an existing file at the destination is moved
 * to the keep area first, the new file is fetched (SHA-512 verified) to a temporary name and renamed
 * into place (never over another file), then the files it `replaces` are kept. Any failure — including
 * a lost server lock (`LOCK_LOST`, e.g. a pre-empting stop/kill) — runs the fenced undo (`failWithUndo`)
 * and records the history entries as failed; every kept file has an entry from the moment it was kept.
 *
 * Idempotent for a resumed job step (#5): history ids and keep-area names derive from the job id, an
 * already recorded history is returned as is (or its failure re-thrown), an interrupted undo is finished
 * (never the apply), and with a journal a file already kept or fetched is neither kept nor fetched again.
 */
export async function applyPlannedFiles(
  d: ExtensionDeps,
  c: FileCtx,
  files: readonly ModrinthPlannedFile[],
  o: {
    actor: HistoryActorFields;
    jobId: string | null;
    action?: (f: ModrinthPlannedFile, replaced: ExtensionRow | null) => ExtensionHistoryAction;
    /** Distinguishes several applies of one job (stable ids). */
    key?: string;
    journal?: ApplyJournal;
    undo?: UndoStore;
    /** Whether the job still holds the server's operation lock (re-checked before every file, after every download and at the end). */
    holdsLock?: () => Promise<boolean>;
  },
): Promise<ApplyResult> {
  const key = o.key ?? "apply";
  const store = o.undo ?? memoryUndo();
  const stillHeld = o.holdsLock ?? (async () => true);
  const assertLock = async () => {
    if (!(await stillHeld())) throw new JobError("LOCK_LOST", "the server's operation lock was taken over (e.g. by a stop/restart/kill); the plugin/mod change stopped");
  };
  const plan = files.map((f) => ({
    f,
    id: stableId(o.jobId, `${key}:${f.destPath}`),
    others: f.replaces.filter((p) => p !== f.destPath).map((p) => ({ path: p, id: stableId(o.jobId, `${key}:${f.destPath}:replaces:${p}`) })),
  }));
  if (o.jobId) {
    const ids = plan.flatMap((p) => [p.id, ...p.others.map((x) => x.id)]);
    const prior = await d.db
      .select()
      .from(extensionHistory)
      .where(and(eq(extensionHistory.jobId, o.jobId), inArray(extensionHistory.id, ids)))
      .orderBy(asc(extensionHistory.at));
    if (prior.length) {
      const failed = prior.find((r) => r.status === "failed");
      if (failed) throw new JobError(store.log.error?.code ?? "INSTALL_FAILED", `install: ${failed.error ?? "failed"}`);
      return { entries: prior.map(pendingOf), recorded: true };
    }
  }
  const fail = (err?: unknown) => failWithUndo(d, c, store, { err, what: "install", stillHeld, actor: o.actor, jobId: o.jobId });
  // A crash interrupted the undo: finish it (fenced), never resume the apply.
  if (store.log.started) return fail();
  const rows = await d.db.select().from(installedExtensions).where(eq(installedExtensions.serverId, c.serverId));
  const byPath = new Map(rows.map((r) => [r.path, r]));
  try {
    for (const { f, id, others } of plan) {
      await assertLock();
      let j = o.journal?.get(id);
      const resumed = j !== undefined;
      if (!j) {
        j = { atDest: byPath.has(f.destPath) || (await exists(d, c, f.destPath)), kept: {} };
        await o.journal?.set(id, j);
      }
      const journal = j;
      /** Keeps `path` as `name` (journaled); the entry is recorded as soon as something is kept, also when it cannot be vouched for. */
      const keepFor = async (entry: PendingEntry, path: string, name: string): Promise<Kept | null> => {
        try {
          const k = await keepJournaled(d, c, path, name, {
            record: journal.kept[path],
            resumed,
            save: async (r) => {
              journal.kept[path] = r;
              await o.journal?.set(id, journal);
            },
          });
          if (k) {
            entry.keptPath = k.path;
            entry.keptSha512 = k.sha512;
            await upsertEntry(store, entry);
            await pushUndo(store, { kind: "restore", kept: k.path, sha512: k.sha512, path, entryId: entry.id });
          }
          return k;
        } catch (err) {
          if (err instanceof UnverifiedKeptError) {
            Object.assign(entry, { keptPath: err.keptPath, keptSha512: null, leftInKeep: true });
            await upsertEntry(store, entry);
          }
          throw err;
        }
      };

      const primary = journal.atDest ? f.destPath : (others[0]?.path ?? null);
      const primaryRow = primary ? (byPath.get(primary) ?? null) : null;
      const entry: PendingEntry = {
        id,
        action: o.action?.(f, primaryRow) ?? (primary ? "update" : "install"),
        extensionId: primaryRow?.id ?? null,
        extensionName: f.projectTitle ?? f.projectSlug ?? f.filename,
        path: f.destPath,
        from: primary ? (primaryRow ? snapshotOf(primaryRow) : bareSnapshot(primary)) : null,
        to: plannedSnapshot(f),
        keptPath: null,
        keptSha512: null,
      };
      if (journal.atDest && !(await keepFor(entry, f.destPath, id))) throw new JobError("NOT_FOUND", `${f.destPath} disappeared before it could be kept`);
      // Skip the download when an interrupted attempt already put exactly this file in place.
      const placed = resumed && (await sha512Of(d, c, f.destPath)) === f.sha512;
      if (!placed) {
        const temp = `${FETCH_DIR}/${id}.jar`;
        const downloaded = resumed && (await sha512Of(d, c, temp)) === f.sha512;
        // Recorded before the download: whatever lands at the temporary name with this digest is ours.
        await pushUndo(store, { kind: "delete", path: temp, sha512: f.sha512 });
        if (!downloaded) {
          await c.log?.("info", `Downloading ${f.filename} (${f.projectTitle ?? f.projectId} ${f.versionNumber})`);
          await ensureDir(d.gateway, c.nodeId, c.serverId, FETCH_DIR, c);
          await fetchModrinthFile(d, c, { ...f, destPath: temp });
        }
        await assertLock();
        await placeVerified(d, c, temp, f.destPath, f.sha512);
      }
      await pushUndo(store, { kind: "delete", path: f.destPath, sha512: f.sha512 });
      await upsertEntry(store, entry);
      for (const [i, x] of others.entries()) {
        const asPrimary = !journal.atDest && i === 0;
        const r = byPath.get(x.path);
        const target: PendingEntry = asPrimary
          ? entry
          : { id: x.id, action: "remove", extensionId: r?.id ?? null, extensionName: r ? displayName(r) : x.path, path: x.path, from: r ? snapshotOf(r) : bareSnapshot(x.path), to: null, keptPath: null, keptSha512: null };
        await keepFor(target, x.path, asPrimary ? id : x.id);
      }
    }
    await assertLock();
  } catch (err) {
    return fail(err);
  }
  return { entries: store.log.entries, recorded: false };
}

/**
 * After the rescan: rows of the fetched files get their BlockForge install facts and Modrinth identity
 * (from the plan, no extra lookup), and the history entries are linked to the rows.
 */
export async function stampInstalled(
  d: ExtensionDeps,
  serverId: string,
  files: readonly ModrinthPlannedFile[],
  entries: readonly PendingEntry[],
  userId: string | null,
): Promise<string[]> {
  const now = new Date(d.clock.now());
  const ids: string[] = [];
  for (const f of files) {
    const [row] = await d.db
      .update(installedExtensions)
      .set({ source: "modrinth", modrinth: modrinthRefOf(f), modrinthProjectId: f.projectId, identifiedSha512: f.sha512, installedAt: now, installedBy: userId })
      .where(and(eq(installedExtensions.serverId, serverId), eq(installedExtensions.path, f.destPath), eq(installedExtensions.sha512, f.sha512)))
      .returning({ id: installedExtensions.id });
    if (!row) continue;
    ids.push(row.id);
    const linked = entries.filter((e) => e.path === f.destPath && e.action !== "remove").map((e) => e.id);
    if (linked.length) await d.db.update(extensionHistory).set({ extensionId: row.id }).where(inArray(extensionHistory.id, linked));
  }
  return ids;
}
