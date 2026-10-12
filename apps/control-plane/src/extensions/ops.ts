import { randomUUID } from "node:crypto";
import type { ExtensionFileSnapshot, ExtensionHistoryAction, ModrinthPlannedFile, ModrinthRef } from "@blockforge/contracts";
import { assertAllowedUrl, MODRINTH_HOSTS } from "@blockforge/minecraft";
import { and, eq, inArray } from "drizzle-orm";
import { AgentCommandError } from "../agents/gateway.js";
import { extensionHistory, installedExtensions } from "../db/schema/index.js";
import type { JobLogLevel } from "../jobs/types.js";
import {
  agentOpts,
  displayName,
  ensureDir,
  jobAgentError,
  KEPT_DIR,
  KEPT_RETENTION_MS,
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

/** Moves a jar into the keep area (`.blockforge/extensions/kept/<name>.jar`) and returns the kept path. */
export async function keepFile(d: ExtensionDeps, c: FileCtx, path: string, name: string): Promise<string> {
  await ensureDir(d.gateway, c.nodeId, c.serverId, KEPT_DIR, c);
  const kept = `${KEPT_DIR}/${name}.jar`;
  await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: path, to: kept }, agentOpts(c));
  return kept;
}

/** SHA-512 of one file (null when it does not exist or cannot be hashed). */
export async function sha512Of(d: ExtensionDeps, c: FileCtx, path: string): Promise<string | null> {
  const r = await d.gateway.send(c.nodeId, "fs.hash", { workloadId: c.serverId, paths: [path], algorithms: ["sha512"], maxBytesPerFile: 2 * 1024 ** 3, maxTotalBytes: 16 * 1024 ** 3 }, agentOpts(c));
  const f = r.files[0];
  return f?.ok ? (f.sha512 ?? null) : null;
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

type Undo = { kind: "delete"; path: string } | { kind: "restore"; kept: string; path: string };

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
}

export async function writeHistory(
  d: ExtensionDeps,
  serverId: string,
  entries: readonly PendingEntry[],
  o: { actor: HistoryActorFields; jobId: string | null; status: "succeeded" | "failed"; error?: string | null },
): Promise<void> {
  if (!entries.length) return;
  const now = d.clock.now();
  await d.db.insert(extensionHistory).values(
    entries.map((e, i) => ({
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
      // A failed change put the kept file back: nothing is kept for it.
      keptPath: o.status === "succeeded" ? e.keptPath : null,
      keptSha512: o.status === "succeeded" ? e.keptSha512 : null,
      keptUntil: o.status === "succeeded" && e.keptPath ? new Date(now + KEPT_RETENTION_MS) : null,
    })),
  );
}

/**
 * Applies planned Modrinth files in dependency order: an existing file at the destination is moved
 * to the keep area first, the new file is fetched (SHA-512 verified), then the files it `replaces` are
 * kept. Any failure undoes everything done so far (fetched files removed, kept files restored) and
 * records the history entries as failed.
 */
export async function applyPlannedFiles(
  d: ExtensionDeps,
  c: FileCtx,
  files: readonly ModrinthPlannedFile[],
  o: { actor: HistoryActorFields; jobId: string | null; action?: (f: ModrinthPlannedFile, replaced: ExtensionRow | null) => ExtensionHistoryAction },
): Promise<PendingEntry[]> {
  const rows = await d.db.select().from(installedExtensions).where(eq(installedExtensions.serverId, c.serverId));
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const undo: Undo[] = [];
  const entries: PendingEntry[] = [];
  try {
    for (const f of files) {
      const id = randomUUID();
      const replacedPaths = [...new Set([...(byPath.has(f.destPath) || (await exists(d, c, f.destPath)) ? [f.destPath] : []), ...f.replaces])];
      const primary = replacedPaths[0] ?? null;
      const primaryRow = primary ? (byPath.get(primary) ?? null) : null;
      let keptPrimary: string | null = null;
      if (primary === f.destPath) {
        keptPrimary = await keepFile(d, c, f.destPath, id);
        undo.push({ kind: "restore", kept: keptPrimary, path: f.destPath });
      }
      await c.log?.("info", `Downloading ${f.filename} (${f.projectTitle ?? f.projectId} ${f.versionNumber})`);
      await fetchModrinthFile(d, c, f);
      undo.push({ kind: "delete", path: f.destPath });
      const extra: PendingEntry[] = [];
      for (const [i, path] of replacedPaths.entries()) {
        if (path === f.destPath) continue;
        if (!(await exists(d, c, path))) continue;
        const name = i === 0 ? id : randomUUID();
        const kept = await keepFile(d, c, path, name);
        undo.push({ kind: "restore", kept, path });
        if (i === 0) keptPrimary = kept;
        else {
          const r = byPath.get(path);
          extra.push({ id: name, action: "remove", extensionId: r?.id ?? null, extensionName: r ? displayName(r) : path, path, from: r ? snapshotOf(r) : bareSnapshot(path), to: null, keptPath: kept, keptSha512: r?.sha512 ?? null });
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
        keptPath: keptPrimary,
        keptSha512: primaryRow?.sha512 ?? null,
      });
      entries.push(...extra);
    }
  } catch (err) {
    for (const u of undo.reverse()) {
      try {
        if (u.kind === "delete") await deleteFile(d, c, u.path);
        else {
          await deleteFile(d, c, u.path);
          await d.gateway.send(c.nodeId, "fs.rename", { workloadId: c.serverId, from: u.kept, to: u.path }, agentOpts(c));
        }
      } catch (e) {
        await c.log?.("error", `Undo failed for ${u.path}: ${(e as Error).message}`);
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    await writeHistory(d, c.serverId, entries, { actor: o.actor, jobId: o.jobId, status: "failed", error: message });
    throw jobAgentError(err, "install");
  }
  return entries;
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
