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

/** SHA-512 of one file (null when it does not exist or cannot be hashed). */
export async function sha512Of(d: ExtensionDeps, c: FileCtx, path: string): Promise<string | null> {
  const r = await d.gateway.send(c.nodeId, "fs.hash", { workloadId: c.serverId, paths: [path], algorithms: ["sha512"], maxBytesPerFile: 2 * 1024 ** 3, maxTotalBytes: 16 * 1024 ** 3 }, agentOpts(c));
  const f = r.files.length === 1 && r.files[0]?.path === path ? r.files[0] : undefined;
  return f?.ok ? (f.sha512 ?? null) : null;
}

/** A jar in the keep area and the SHA-512 of exactly what was kept (null: it could not be hashed). */
export interface Kept {
  path: string;
  sha512: string | null;
}

/**
 * Moves a jar into the keep area (`.blockforge/extensions/kept/<name>.jar`) and hashes the kept file
 * right away: that digest — never a scan-time one — is what a later restore must find again.
 */
export async function keepFile(d: ExtensionDeps, c: FileCtx, path: string, name: string): Promise<Kept> {
  await ensureDir(d.gateway, c.nodeId, c.serverId, KEPT_DIR, c);
  const kept = keptPathOf(name);
  await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: path, to: kept }, agentOpts(c));
  let sha512: string | null = null;
  try {
    sha512 = await sha512Of(d, c, kept);
  } catch (err) {
    await c.log?.("warn", `Hashing the kept file ${kept} failed: ${(err as Error).message}`);
  }
  return { path: kept, sha512 };
}

/** A kept file that changed (or vanished) since it was kept is never moved back. */
export class KeptFileChangedError extends JobError {
  constructor(
    readonly keptPath: string,
    readonly target: string,
  ) {
    super("KEPT_FILE_CHANGED", `the kept file ${keptPath} is missing or changed since it was kept; it was not restored to ${target} (left in the keep area)`);
    this.name = "KeptFileChangedError";
  }
}

/**
 * Moves a kept jar back to `to` only while it still has the digest taken right after it was kept; the
 * agent's `fs.rename` never overwrites an existing `to`.
 */
export async function restoreKept(d: ExtensionDeps, c: FileCtx, kept: string, expectedSha512: string | null, to: string): Promise<void> {
  const actual = await sha512Of(d, c, kept);
  if (!expectedSha512 || actual !== expectedSha512) throw new KeptFileChangedError(kept, to);
  await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: kept, to }, agentOpts(c));
}

/** Deletes a file this job wrote, only while it still has the digest it was written with (else it is left alone). */
export async function deleteCreated(d: ExtensionDeps, c: FileCtx, path: string, sha512: string): Promise<void> {
  const actual = await sha512Of(d, c, path);
  if (actual === null) return;
  if (actual !== sha512) throw new JobError("FILE_CHANGED", `${path} changed after it was written; it was not deleted`);
  await deleteFile(d, c, path);
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

type Undo = { kind: "delete"; path: string; sha512: string } | { kind: "restore"; kept: string; sha512: string | null; path: string };

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
  /** A failed change could not put the kept file back (it changed): the row keeps `keptPath` (pruned later). */
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
      // A failed change put the kept file back: nothing is kept for it (unless it could not be put back).
      const keptPath = o.status === "succeeded" || e.leftInKeep ? e.keptPath : null;
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
        error: o.status === "failed" ? (o.error ?? "failed").slice(0, 1024) : null,
        keptPath,
        keptSha512: o.status === "succeeded" ? e.keptSha512 : null,
        keptUntil: keptPath ? new Date(now + KEPT_RETENTION_MS) : null,
      };
    }),
  );
}

/**
 * Progress of an interrupted apply, persisted by the job (`ctx.state`) before and after every file
 * operation: whether the destination was occupied and the digest of every file kept so far.
 */
export interface ApplyJournal {
  get(id: string): JournalEntry | undefined;
  set(id: string, e: JournalEntry): Promise<void>;
}
export interface JournalEntry {
  atDest: boolean;
  /** Source path → SHA-512 of its kept copy (taken right after the move). */
  kept: Record<string, string | null>;
}

export interface ApplyResult {
  entries: PendingEntry[];
  /** The history of this apply was already written by an interrupted attempt (do not write it again). */
  recorded: boolean;
}

/**
 * Applies planned Modrinth files in dependency order: an existing file at the destination is moved
 * to the keep area first, the new file is fetched (SHA-512 verified), then the files it `replaces` are
 * kept. Any failure undoes everything done so far (fetched files removed while unchanged, kept files
 * restored while unchanged) and records the history entries as failed.
 *
 * Idempotent for a resumed job step (#5): history ids and keep-area names derive from the job id, an
 * already recorded history is returned as is, and with a journal a file that was already kept or
 * fetched is neither kept again nor fetched again.
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
    /** Re-checks the server's operation lock before every file. */
    assertLock?: () => Promise<void>;
  },
): Promise<ApplyResult> {
  const key = o.key ?? "apply";
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
      if (failed) throw new JobError("INSTALL_FAILED", `install: ${failed.error ?? "failed"}`);
      return { entries: prior.map(pendingOf), recorded: true };
    }
  }
  const rows = await d.db.select().from(installedExtensions).where(eq(installedExtensions.serverId, c.serverId));
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const undo: Undo[] = [];
  const entries: PendingEntry[] = [];
  try {
    for (const { f, id, others } of plan) {
      await o.assertLock?.();
      let j = o.journal?.get(id);
      const resumed = j !== undefined;
      if (!j) {
        j = { atDest: byPath.has(f.destPath) || (await exists(d, c, f.destPath)), kept: {} };
        await o.journal?.set(id, j);
      }
      const journal = j;
      /**
       * Keeps `path` as `name` once: a copy recorded by an interrupted attempt is reused, and a copy it
       * made just before it could record it is adopted. Null: nothing to keep (`optional` source missing).
       */
      const keepOnce = async (path: string, name: string, optional: boolean): Promise<Kept | null> => {
        const target = keptPathOf(name);
        if (path in journal.kept) return { path: target, sha512: journal.kept[path] ?? null };
        let k: Kept;
        if (await exists(d, c, path)) k = await keepFile(d, c, path, name);
        else if (resumed && (await exists(d, c, target))) k = { path: target, sha512: await sha512Of(d, c, target) };
        else if (optional) return null;
        else k = await keepFile(d, c, path, name); // fails with NOT_FOUND
        journal.kept[path] = k.sha512;
        await o.journal?.set(id, journal);
        return k;
      };

      const primary = journal.atDest ? f.destPath : (others[0]?.path ?? null);
      const primaryRow = primary ? (byPath.get(primary) ?? null) : null;
      let keptPrimary: Kept | null = null;
      if (journal.atDest) {
        keptPrimary = await keepOnce(f.destPath, id, false);
        undo.push({ kind: "restore", kept: keptPrimary!.path, sha512: keptPrimary!.sha512, path: f.destPath });
      }
      // Skip the download when an interrupted attempt already put exactly this file in place.
      const fetched = resumed && (await sha512Of(d, c, f.destPath)) === f.sha512;
      if (!fetched) {
        if (resumed && (await exists(d, c, f.destPath))) throw new JobError("CONFLICT", `${f.destPath} is occupied by a file this job did not write`);
        await c.log?.("info", `Downloading ${f.filename} (${f.projectTitle ?? f.projectId} ${f.versionNumber})`);
        await fetchModrinthFile(d, c, f);
      }
      undo.push({ kind: "delete", path: f.destPath, sha512: f.sha512 });
      const extra: PendingEntry[] = [];
      for (const [i, x] of others.entries()) {
        const asPrimary = !journal.atDest && i === 0;
        const k = await keepOnce(x.path, asPrimary ? id : x.id, true);
        if (!k) continue;
        undo.push({ kind: "restore", kept: k.path, sha512: k.sha512, path: x.path });
        if (asPrimary) keptPrimary = k;
        else {
          const r = byPath.get(x.path);
          extra.push({ id: x.id, action: "remove", extensionId: r?.id ?? null, extensionName: r ? displayName(r) : x.path, path: x.path, from: r ? snapshotOf(r) : bareSnapshot(x.path), to: null, keptPath: k.path, keptSha512: k.sha512 });
        }
      }
      entries.push({
        id,
        action: o.action?.(f, primaryRow) ?? (primary ? "update" : "install"),
        extensionId: primaryRow?.id ?? null,
        extensionName: f.projectTitle ?? f.projectSlug ?? f.filename,
        path: f.destPath,
        from: primary ? (primaryRow ? snapshotOf(primaryRow) : bareSnapshot(primary)) : null,
        to: plannedSnapshot(f),
        keptPath: keptPrimary?.path ?? null,
        keptSha512: keptPrimary?.sha512 ?? null,
      });
      entries.push(...extra);
    }
  } catch (err) {
    if (err instanceof JobError && err.code === "LOCK_LOST") throw err;
    const notes: string[] = [];
    for (const u of undo.reverse()) {
      try {
        if (u.kind === "delete") await deleteCreated(d, c, u.path, u.sha512);
        else await restoreKept(d, c, u.kept, u.sha512, u.path);
      } catch (e) {
        notes.push((e as Error).message);
        if (u.kind === "restore") for (const en of entries) if (en.keptPath === u.kept) en.leftInKeep = true;
        await c.log?.("error", `Undo failed for ${u.path}: ${(e as Error).message}`);
      }
    }
    const base = err instanceof Error ? err.message : String(err);
    const message = notes.length ? `${base}; undo: ${notes.join("; ")}` : base;
    await writeHistory(d, c.serverId, entries, { actor: o.actor, jobId: o.jobId, status: "failed", error: message });
    if (notes.length) {
      const e = jobAgentError(err, "install");
      throw new JobError(e instanceof JobError ? e.code : "INSTALL_FAILED", `${e instanceof Error ? e.message : base}; undo: ${notes.join("; ")}`);
    }
    throw jobAgentError(err, "install");
  }
  return { entries, recorded: false };
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
