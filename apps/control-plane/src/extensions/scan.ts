import { randomUUID } from "node:crypto";
import type { ExtensionCompatibility, ExtensionMetadataView, FileEntry, ModrinthRef } from "@blockforge/contracts";
import {
  EXTENSION_METADATA_ENTRIES,
  MAX_METADATA_BYTES,
  identifyModrinthFiles,
  parseJarMetadata,
  selectExtensionFiles,
  toContractJarInfo,
  toContractModrinthRef,
  toContractSkippedEntries,
} from "@blockforge/minecraft";
import { and, eq, inArray } from "drizzle-orm";
import { AgentCommandError } from "../agents/gateway.js";
import { extensionScans, installedExtensions, servers } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { JobLogLevel } from "../jobs/types.js";
import { JobError } from "../jobs/types.js";
import { agentOpts, ensureScanRow, jobAgentError, missingCapabilities, scanStatusOf, targetOf, type ExtensionDeps, type ExtensionRow, type SendOpts } from "./model.js";

const HASH_BATCH = 512;
const READ_BATCH = 256;
const MAX_FILE_BYTES = 2 * 1024 ** 3;

export interface ScanOptions extends SendOpts {
  full: boolean;
  log?: (level: JobLogLevel, message: string) => Promise<void>;
}

type HashOk = { sizeBytes: number; mtime: number; sha1: string | null; sha512: string | null };
type JarInfo = { metadata: ExtensionMetadataView[]; compatibility: ExtensionCompatibility };

const unreadable = (message: string): JarInfo => ({
  metadata: [],
  compatibility: { loadable: false, metadataIndex: null, problems: [{ code: "METADATA_INVALID", level: "error", message }] },
});

/**
 * Runs `fn` over `paths` in batches; entries answered `BUDGET_EXCEEDED` are retried in the next
 * command (the agent always processes the first path of a command, so this always progresses).
 * The agent answers one result per path in request order (`path` echoed verbatim); any other answer
 * fails the scan instead of attributing digests to the wrong files (L2).
 */
export async function batched<R extends { path: string; ok: boolean; error?: string }>(paths: readonly string[], size: number, fn: (batch: string[]) => Promise<R[]>): Promise<Map<string, R>> {
  const out = new Map<string, R>();
  let pending = [...paths];
  while (pending.length) {
    const batch = pending.slice(0, size);
    const results = await fn(batch);
    if (results.length !== batch.length || results.some((r, i) => r.path !== batch[i])) {
      throw new JobError("AGENT_PROTOCOL", `the agent answered ${results.length} result(s) for ${batch.length} path(s) or out of order; the scan was stopped`);
    }
    const retry: string[] = [];
    results.forEach((r, i) => {
      const path = batch[i]!;
      if (!r.ok && r.error === "BUDGET_EXCEEDED") retry.push(path);
      else out.set(path, r);
    });
    if (retry.length === batch.length) break; // the agent refused progress — give up on these for now
    pending = [...retry, ...pending.slice(size)];
  }
  return out;
}

/**
 * Incremental scan of a server's `plugins/` / `mods/` (api.md "Scans"): `fs.list` →
 * `selectExtensionFiles` → `fs.hash` + `jar.readEntries` only for new files and files whose size or
 * mtime changed (`full` re-reads all) → Modrinth identification by SHA-512 for hashes not yet looked
 * up → upsert rows, keep ids across renames (same SHA-512), delete vanished rows. Returns the ids that
 * changed (null = more than 256).
 */
export async function runScan(d: ExtensionDeps, serverId: string, o: ScanOptions): Promise<string[] | null> {
  const [srv] = await d.db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!srv) return [];
  const target = targetOf(srv);
  const now = new Date(d.clock.now());
  await ensureScanRow(d.db, serverId);
  if (!target) {
    await d.db.update(extensionScans).set({ status: "completed", scannedAt: now, error: null, skipped: [], truncated: false }).where(eq(extensionScans.serverId, serverId));
    return [];
  }
  const missing = missingCapabilities(d.gateway, srv.nodeId);
  if (missing.length) throw new JobError("AGENT_OUTDATED", `the node's agent does not support ${missing.join(", ")}; update the agent`);
  const send = <T extends "fs.list" | "fs.hash" | "jar.readEntries">(type: T, payload: Parameters<typeof d.gateway.send<T>>[2]) =>
    d.gateway.send(srv.nodeId, type, payload, agentOpts({ ...o, timeoutMs: o.timeoutMs ?? 300_000 }));

  let listing: FileEntry[] = [];
  try {
    listing = (await send("fs.list", { workloadId: serverId, path: target.installDir })).entries;
  } catch (err) {
    if (!(err instanceof AgentCommandError && err.code === "NOT_FOUND")) throw jobAgentError(err, "fs.list");
  }
  const selected = selectExtensionFiles(target.installDir, listing.map((e) => ({ name: e.name, type: e.type, size: e.size })));
  const listedMtime = new Map(listing.map((e) => [`${target.installDir}/${e.name}`, e.modifiedAt]));
  const existing = await d.db.select().from(installedExtensions).where(eq(installedExtensions.serverId, serverId));
  const byPath = new Map(existing.map((r) => [r.path, r]));

  const changed = selected.files.filter((f) => {
    const r = byPath.get(f.path);
    return o.full || !r || r.sizeBytes !== f.sizeBytes || r.mtime.getTime() !== listedMtime.get(f.path) || !r.sha512 || !r.compatibility;
  });
  const changedPaths = changed.map((f) => f.path);
  if (changedPaths.length) await o.log?.("info", `Reading ${changedPaths.length} new or changed file(s)`);

  // Hashes (sha1 + sha512) and metadata entries of new/changed files.
  const hashes = new Map<string, HashOk | { error: string }>();
  try {
    const res = await batched(changedPaths, HASH_BATCH, async (batch) =>
      (await send("fs.hash", { workloadId: serverId, paths: batch, algorithms: ["sha1", "sha512"], maxBytesPerFile: MAX_FILE_BYTES, maxTotalBytes: 16 * 1024 ** 3 })).files,
    );
    for (const [path, r] of res) hashes.set(path, r.ok ? { sizeBytes: r.sizeBytes, mtime: r.mtime, sha1: r.sha1 ?? null, sha512: r.sha512 ?? null } : { error: r.error });
  } catch (err) {
    throw jobAgentError(err, "fs.hash");
  }
  const jars = new Map<string, JarInfo | null>();
  const readable = changedPaths.filter((p) => {
    const h = hashes.get(p);
    return h && !("error" in h);
  });
  try {
    const res = await batched(readable, READ_BATCH, async (batch) =>
      (
        await send("jar.readEntries", {
          workloadId: serverId,
          paths: batch,
          entries: [...EXTENSION_METADATA_ENTRIES],
          maxEntryBytes: MAX_METADATA_BYTES,
          maxJarBytes: MAX_FILE_BYTES,
          maxTotalBytes: 4 * 1024 * 1024,
          hash: [],
        })
      ).jars,
    );
    for (const [path, r] of res) {
      if (r.ok) {
        const entries: Record<string, string> = {};
        for (const e of r.entries) entries[e.name] = e.content;
        jars.set(path, toContractJarInfo(parseJarMetadata(entries), target.software));
      } else if (r.error === "NOT_A_ZIP") jars.set(path, unreadable("Not a readable jar (zip) file: the server cannot load it"));
      else if (r.error === "AMBIGUOUS_ENTRY") jars.set(path, unreadable("A metadata file occurs more than once in the jar (the loader and BlockForge could read different copies)"));
      else jars.set(path, null);
    }
  } catch (err) {
    throw jobAgentError(err, "jar.readEntries");
  }

  // Files whose content changed keep the row of a vanished file with the same SHA-512 (renamed outside BlockForge).
  const listedPaths = new Set(selected.files.map((f) => f.path));
  const vanished = existing.filter((r) => !listedPaths.has(r.path));
  const renamedFrom = new Map<string, ExtensionRow>();
  for (const f of changed) {
    if (byPath.has(f.path)) continue;
    const h = hashes.get(f.path);
    const sha = h && !("error" in h) ? h.sha512 : null;
    if (!sha) continue;
    const i = vanished.findIndex((r) => r.sha512 === sha && ![...renamedFrom.values()].includes(r));
    if (i >= 0) renamedFrom.set(f.path, vanished[i]!);
  }

  // Modrinth identification for hashes not looked up yet.
  const toIdentify = selected.files
    .map((f) => {
      const h = hashes.get(f.path);
      const row = byPath.get(f.path) ?? renamedFrom.get(f.path);
      const sha512 = h && !("error" in h) ? h.sha512 : (row?.sha512 ?? null);
      const sha1 = h && !("error" in h) ? h.sha1 : (row?.sha1 ?? null);
      return { path: f.path, sha512, sha1, attempted: row?.identifiedSha512 ?? null };
    })
    .filter((f) => f.sha512 && f.sha512 !== f.attempted);
  const identified = new Map<string, ModrinthRef | null>();
  if (toIdentify.length) {
    try {
      for (const r of await identifyModrinthFiles(d.upstreams.modrinth, toIdentify.map((f) => ({ path: f.path, sha512: f.sha512, sha1: f.sha1 })))) {
        identified.set(r.path, r.modrinth ? toContractModrinthRef(r.modrinth) : null);
      }
    } catch (err) {
      await o.log?.("warn", "Modrinth identification is unavailable right now; it is retried on the next scan");
      d.logger.warn({ err: (err as Error).message, serverId }, "modrinth identification failed");
    }
  }

  const changedIds = new Set<string>();
  const keptIds = new Set<string>();
  await withTransaction(d.db, async (tx) => {
    for (const f of selected.files) {
      const row = byPath.get(f.path) ?? renamedFrom.get(f.path);
      const h = hashes.get(f.path);
      const hashOk = h && !("error" in h) ? h : null;
      const isChanged = changedPaths.includes(f.path);
      const set: Partial<typeof installedExtensions.$inferInsert> = {
        path: f.path,
        filename: f.name,
        enabled: f.enabled,
        sizeBytes: hashOk?.sizeBytes ?? f.sizeBytes,
        mtime: new Date(hashOk?.mtime ?? listedMtime.get(f.path) ?? now.getTime()),
        lastSeenAt: now,
      };
      if (isChanged) {
        set.sha512 = hashOk?.sha512 ?? null;
        set.sha1 = hashOk?.sha1 ?? null;
        const info = jars.get(f.path);
        set.metadata = info?.metadata ?? [];
        set.compatibility = info?.compatibility ?? null;
      }
      // `source` is provenance (contracts `ExtensionSource`): a scan never labels a file `modrinth`/`upload`. A
      // file found on disk stays `unknown` even when a SHA-512 lookup identifies it (that goes into `modrinth`),
      // and a BlockForge-installed/uploaded file whose content changed outside BlockForge (file manager, SFTP,
      // a plugin's own updater) becomes `unknown` with no install facts. Install/update/rollback jobs stamp
      // their files after the rescan (`stampInstalled`, rollback's rescan step).
      const contentChanged = !!row && isChanged && set.sha512 !== row.sha512;
      if (contentChanged && row.source !== "unknown") {
        set.source = "unknown";
        set.installedAt = null;
        set.installedBy = null;
      }
      if (identified.has(f.path)) {
        const ref = identified.get(f.path) ?? null;
        set.modrinth = ref;
        set.modrinthProjectId = ref?.projectId ?? null;
        set.identifiedSha512 = (set.sha512 ?? row?.sha512) || null;
      } else if (contentChanged) {
        // New content, not identified (Modrinth unavailable): the old identity no longer applies.
        set.modrinth = null;
        set.modrinthProjectId = null;
        set.identifiedSha512 = null;
      }
      if (row) {
        await tx.update(installedExtensions).set(set).where(eq(installedExtensions.id, row.id));
        keptIds.add(row.id);
        if (isChanged || row.path !== f.path) changedIds.add(row.id);
      } else {
        const id = randomUUID();
        await tx.insert(installedExtensions).values({
          id,
          serverId,
          kind: target.kind,
          source: "unknown",
          path: f.path,
          filename: f.name,
          enabled: f.enabled,
          sizeBytes: set.sizeBytes!,
          mtime: set.mtime!,
          sha512: set.sha512 ?? null,
          sha1: set.sha1 ?? null,
          metadata: set.metadata ?? [],
          compatibility: set.compatibility ?? null,
          modrinth: set.modrinth ?? null,
          modrinthProjectId: set.modrinthProjectId ?? null,
          identifiedSha512: set.identifiedSha512 ?? null,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        changedIds.add(id);
      }
    }
    const gone = existing.filter((r) => !keptIds.has(r.id)).map((r) => r.id);
    if (gone.length) await tx.delete(installedExtensions).where(and(eq(installedExtensions.serverId, serverId), inArray(installedExtensions.id, gone)));
    for (const id of gone) changedIds.add(id);
    await tx
      .update(extensionScans)
      .set({
        status: "completed",
        scannedAt: now,
        error: null,
        skipped: toContractSkippedEntries(selected.skipped),
        truncated: selected.skipped.some((s) => s.reason === "too-many"),
      })
      .where(eq(extensionScans.serverId, serverId));
  });
  const ids = [...changedIds];
  return ids.length > 256 ? null : ids;
}

/** Marks a scan as running / failed and publishes the status. */
export async function setScanStatus(d: ExtensionDeps, serverId: string, status: "running" | "failed", opts: { jobId: string | null; error?: string | null }): Promise<void> {
  await ensureScanRow(d.db, serverId);
  const now = new Date(d.clock.now());
  await d.db
    .update(extensionScans)
    .set(status === "running" ? { status, jobId: opts.jobId, startedAt: now, error: null } : { status, jobId: opts.jobId, error: (opts.error ?? "scan failed").slice(0, 1024) })
    .where(eq(extensionScans.serverId, serverId));
  await publishExtensions(d, serverId, null);
}

/** `extensions.updated` to subscribers holding `servers.extensions.view`. */
export async function publishExtensions(d: ExtensionDeps, serverId: string, changed: string[] | null): Promise<void> {
  const [row] = await d.db.select().from(extensionScans).where(eq(extensionScans.serverId, serverId));
  await d.events.publish(serverId, "extensions.updated", { serverId, scan: scanStatusOf(row), changed }, "servers.extensions.view");
}
