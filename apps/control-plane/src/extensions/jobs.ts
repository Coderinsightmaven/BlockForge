import { ModrinthInstallPlan, type ModrinthPlannedFile } from "@blockforge/contracts";
import { checkModrinthUpdates, fromContractPlanRequest, planModrinthInstall, primaryJarFile, toContractInstallPlan, type InstalledExtensionRef } from "@blockforge/minecraft";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../db/client.js";
import { extensionHistory, installedExtensions, servers } from "../db/schema/index.js";
import { JobError, type JobDefinition, type StepContext } from "../jobs/types.js";
import {
  ensureDir,
  EXTENSION_JOBS,
  FETCH_DIR,
  releaseExtensionLock,
  restartRequired,
  refetchable,
  rollbackOf,
  snapshotOf,
  targetOf,
  type ExtensionDeps,
  type ExtensionRow,
} from "./model.js";
import {
  applyPlannedFiles,
  exists,
  fetchModrinthFile,
  emptyUndoLog,
  failWithUndo,
  keepJournaled,
  KeptFileChangedError,
  placeVerified,
  pushUndo,
  recordedCleanupTokens,
  restoreKept,
  sha512Of,
  stableId,
  stampInstalled,
  writeHistory,
  type ApplyJournal,
  type FileCtx,
  type HistoryActorFields,
  type JournalEntry,
  type KeepRecord,
  type Kept,
  type PendingEntry,
  type UndoLog,
  type UndoStore,
  UnverifiedKeptError,
  upsertEntry,
} from "./ops.js";
import { publishExtensions, runScan, setScanStatus } from "./scan.js";

const Actor = z.object({ actorType: z.enum(["user", "api_token", "schedule", "system"]), actorId: z.uuid().nullable(), actorName: z.string().max(128).nullable() });
const ScanInput = z.object({ serverId: z.uuid(), full: z.boolean().default(false) });
const InstallInput = z.object({ serverId: z.uuid(), plan: ModrinthInstallPlan, actor: Actor, userId: z.uuid().nullable() });
const UpdateInput = z.object({ serverId: z.uuid(), extensionIds: z.array(z.uuid()).min(1).max(64), allowPrerelease: z.boolean(), actor: Actor, userId: z.uuid().nullable() });
const RollbackInput = z.object({ serverId: z.uuid(), entryId: z.uuid(), actor: Actor, userId: z.uuid().nullable() });

type UpdateResult = { extensionId: string; status: "updated" | "up_to_date" | "failed"; versionId: string | null; error: string | null };

export const installedRefs = (rows: readonly ExtensionRow[]): InstalledExtensionRef[] =>
  rows.map((r) => ({ path: r.path, sha1: r.sha1, sha512: r.sha512, projectId: r.modrinth?.projectId ?? null, versionId: r.modrinth?.versionId ?? null }));

async function serverOf(d: ExtensionDeps, serverId: string) {
  const [s] = await d.db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!s) throw new JobError("NOT_FOUND", "the server no longer exists");
  return s;
}

function fileCtx<I>(ctx: StepContext<I>, serverId: string, nodeId: string): FileCtx {
  return { serverId, nodeId, jobId: ctx.jobId, signal: ctx.signal, log: (l, m) => ctx.log(l, m) };
}

/**
 * Completes a step: `set` and the removal of `clear` are applied to the state inside the completing
 * transaction (with `fn`'s writes); if that commit fails, the in-memory state is put back (the runner
 * persists it), so the journal and undo record are never lost apart from the step's completion.
 */
async function completeStep<I>(ctx: StepContext<I>, clear: string[], set: Record<string, unknown>, fn?: (tx: Tx) => Promise<void>): Promise<void> {
  const saved = Object.fromEntries([...clear, ...Object.keys(set)].map((k) => [k, ctx.state[k]]));
  try {
    await ctx.checkpoint(
      async (tx) => {
        for (const k of clear) delete ctx.state[k];
        Object.assign(ctx.state, set);
        if (fn) await fn(tx);
      },
      { completeStep: true },
    );
  } catch (err) {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete ctx.state[k];
      else ctx.state[k] = v;
    }
    throw err;
  }
}

/** Undo record `key` in `ctx.state.undo`, checkpointed on every change (an interrupted undo is resumed). */
function undoStoreOf<I>(ctx: StepContext<I>, key: string): UndoStore {
  const all = ((ctx.state.undo as Record<string, UndoLog> | undefined) ?? {}) as Record<string, UndoLog>;
  ctx.state.undo = all;
  const log = (all[key] ??= emptyUndoLog());
  return { log, save: () => ctx.checkpoint() };
}

/** Apply progress in `ctx.state.journal`, checkpointed before/after every file operation (resumable). */
function journalOf<I>(ctx: StepContext<I>): ApplyJournal {
  const all = ((ctx.state.journal as Record<string, JournalEntry> | undefined) ?? {}) as Record<string, JournalEntry>;
  ctx.state.journal = all;
  return {
    get: (id) => all[id],
    set: async (id, e) => {
      all[id] = e;
      await ctx.checkpoint();
    },
  };
}

/** Rescan after a change (the job keeps the lock); a failing rescan does not undo the change. */
async function rescan<I>(d: ExtensionDeps, ctx: StepContext<I>, serverId: string): Promise<string[] | null> {
  try {
    return await runScan(d, serverId, { full: false, jobId: ctx.jobId, signal: ctx.signal, log: (l, m) => ctx.log(l, m) });
  } catch (err) {
    await ctx.log("warn", `The files were changed, but the rescan failed: ${(err as Error).message}`);
    await setScanStatus(d, serverId, "failed", { jobId: ctx.jobId, error: (err as Error).message });
    return null;
  }
}

export function extensionJobDefinitions(d: ExtensionDeps): JobDefinition<never>[] {
  const finalizeLock = async (f: { input: { serverId: string }; jobId: string; status: string; error: { message: string } | null; state: Record<string, unknown> }) => {
    // A cleanup hold the job recorded and did not release (crash, failure mid-undo) is released here.
    for (const token of recordedCleanupTokens(f.state)) {
      try {
        await d.state.unlock(f.input.serverId, token);
      } catch (err) {
        d.logger.error({ err, jobId: f.jobId }, "releasing a cleanup hold failed");
      }
    }
    try {
      if (f.status !== "succeeded") {
        const [s] = await d.db.select({ id: servers.id }).from(servers).where(eq(servers.id, f.input.serverId));
        if (s) await publishExtensions(d, f.input.serverId, null);
      }
    } finally {
      // Each lock is released on its own: a failing release never pins the other (the maintenance sweep
      // and lock takeover handle a lock whose release failed, since the job is terminal by then).
      try {
        await releaseExtensionLock(d.db, f.input.serverId, f.jobId);
      } catch (err) {
        d.logger.error({ err, jobId: f.jobId }, "releasing the extension job lock failed");
      }
      try {
        // The server's `extensions` operation lock (file-changing jobs; a no-op for scans and after a pre-emption).
        await d.state.end(f.input.serverId, f.jobId);
      } catch (err) {
        d.logger.error({ err, jobId: f.jobId }, "releasing the server operation lock failed");
      }
    }
  };
  /** Rescans only while the job still holds the lock (the files were changed and recorded already). */
  const holdsLockForRescan = async <I extends { serverId: string }>(ctx: StepContext<I>) => {
    if (await d.state.holds(ctx.input.serverId, "extensions", ctx.jobId)) return;
    throw new JobError("LOCK_LOST", "the plugin/mod files were changed (see the history), but the server's operation lock was taken over before the rescan; scan again later");
  };

  const scan: JobDefinition<z.infer<typeof ScanInput>> = {
    type: EXTENSION_JOBS.scan,
    input: ScanInput,
    cancelPermission: "servers.extensions.manage",
    retryLimit: 0,
    expireInSeconds: 3600,
    steps: [
      {
        key: "scan",
        label: "Scan plugins/mods",
        run: async (ctx) => {
          await setScanStatus(d, ctx.input.serverId, "running", { jobId: ctx.jobId });
          try {
            const changed = await runScan(d, ctx.input.serverId, { full: ctx.input.full, jobId: ctx.jobId, signal: ctx.signal, log: (l, m) => ctx.log(l, m) });
            ctx.state.changed = changed?.length ?? null;
            await publishExtensions(d, ctx.input.serverId, changed);
          } catch (err) {
            await setScanStatus(d, ctx.input.serverId, "failed", { jobId: ctx.jobId, error: (err as Error).message });
            throw err;
          }
        },
      },
    ],
    finalize: finalizeLock,
  };

  const install: JobDefinition<z.infer<typeof InstallInput>> = {
    type: EXTENSION_JOBS.install,
    input: InstallInput,
    cancelPermission: "servers.extensions.manage",
    retryLimit: 0,
    expireInSeconds: 3600,
    steps: [
      {
        key: "fetch",
        label: "Download and verify the files",
        run: async (ctx) => {
          const s = await serverOf(d, ctx.input.serverId);
          const actor = ctx.input.actor as HistoryActorFields;
          // The lock is checked inside: a resumed job that lost it must still finish (or skip) its undo.
          const r = await applyPlannedFiles(d, fileCtx(ctx, s.id, s.nodeId), ctx.input.plan.files, {
            actor,
            jobId: ctx.jobId,
            journal: journalOf(ctx),
            undo: undoStoreOf(ctx, "install"),
            holdsLock: () => d.state.holds(s.id, "extensions", ctx.jobId),
          });
          await ctx.log("info", `Installed ${ctx.input.plan.files.length} file(s)${restartRequired(s.state) ? "; they take effect at the next restart" : ""}`);
          // History, state (journal and undo record cleared) and step success in one transaction: a resumed job
          // never applies twice, and a failed commit keeps the undo record.
          await completeStep(ctx, ["journal", "undo"], { entries: r.entries }, r.recorded ? undefined : (tx) => writeHistory(d, s.id, r.entries, { actor, jobId: ctx.jobId, status: "succeeded" }, tx));
        },
      },
      {
        key: "rescan",
        label: "Rescan plugins/mods",
        run: async (ctx) => {
          await holdsLockForRescan(ctx);
          const changed = await rescan(d, ctx, ctx.input.serverId);
          const stamped = await stampInstalled(d, ctx.input.serverId, ctx.input.plan.files, (ctx.state.entries as PendingEntry[]) ?? [], ctx.input.userId);
          await publishExtensions(d, ctx.input.serverId, changed === null ? null : [...new Set([...changed, ...stamped])]);
        },
      },
    ],
    finalize: finalizeLock,
  };

  const update: JobDefinition<z.infer<typeof UpdateInput>> = {
    type: EXTENSION_JOBS.update,
    input: UpdateInput,
    cancelPermission: "servers.extensions.manage",
    retryLimit: 0,
    expireInSeconds: 3600,
    result: (state) => ({ results: (state.results as UpdateResult[] | undefined) ?? [] }),
    steps: [
      {
        key: "plan",
        label: "Plan the updates",
        run: async (ctx) => {
          const s = await serverOf(d, ctx.input.serverId);
          const target = targetOf(s);
          if (!target) throw new JobError("UNSUPPORTED_SOFTWARE", "this server's software loads no plugins or mods");
          const all = await d.db.select().from(installedExtensions).where(eq(installedExtensions.serverId, s.id));
          const rows = all.filter((r) => ctx.input.extensionIds.includes(r.id));
          const results: UpdateResult[] = ctx.input.extensionIds.filter((id) => !rows.some((r) => r.id === id)).map((id) => ({ extensionId: id, status: "failed", versionId: null, error: "the extension no longer exists" }));
          const plans: Array<{ extensionId: string; files: ModrinthPlannedFile[] }> = [];
          let statuses;
          try {
            statuses = await checkModrinthUpdates(d.upstreams.modrinth, target, installedRefs(rows), { allowPrerelease: ctx.input.allowPrerelease });
          } catch (err) {
            throw d.upstreams.jobError(err, "modrinth");
          }
          for (const [i, row] of rows.entries()) {
            const st = statuses[i];
            if (!st?.updateAvailable || !st.latest) {
              results.push({ extensionId: row.id, status: st?.current ? "up_to_date" : "failed", versionId: st?.current?.versionId ?? null, error: st?.current ? null : (st?.problem ?? "not identified on Modrinth") });
              continue;
            }
            try {
              const lib = await planModrinthInstall(
                d.upstreams.modrinth,
                fromContractPlanRequest(
                  { project: st.latest.projectId, versionId: st.latest.versionId, includeOptional: [], allowPrerelease: ctx.input.allowPrerelease, allowIncompatibleVersion: false },
                  { software: target.software, minecraftVersion: target.minecraftVersion, installed: installedRefs(all) },
                ),
              );
              const plan = toContractInstallPlan(lib, { restartRequired: restartRequired(s.state) });
              if (!plan.installable) {
                const errors = plan.warnings.filter((w) => w.level === "error").map((w) => w.message);
                results.push({ extensionId: row.id, status: "failed", versionId: st.latest.versionId, error: errors.join("; ").slice(0, 1024) || "the update is not installable" });
                continue;
              }
              plans.push({ extensionId: row.id, files: plan.files });
            } catch (err) {
              const e = d.upstreams.jobError(err, "modrinth");
              results.push({ extensionId: row.id, status: "failed", versionId: st.latest.versionId, error: (e as Error).message });
            }
          }
          ctx.state.results = results;
          ctx.state.plans = plans;
        },
      },
      {
        key: "apply",
        label: "Install the updates",
        run: async (ctx) => {
          const s = await serverOf(d, ctx.input.serverId);
          const actor = ctx.input.actor as HistoryActorFields;
          const plans = (ctx.state.plans as Array<{ extensionId: string; files: ModrinthPlannedFile[] }>) ?? [];
          // Resumable: results/applied/done are checkpointed after every plan.
          const results = ((ctx.state.results as UpdateResult[]) ?? []) as UpdateResult[];
          const applied = ((ctx.state.applied as { files: ModrinthPlannedFile[]; entries: PendingEntry[] }[]) ?? []) as { files: ModrinthPlannedFile[]; entries: PendingEntry[] }[];
          const done = ((ctx.state.done as number[]) ?? []) as number[];
          Object.assign(ctx.state, { results, applied, done });
          const journal = journalOf(ctx);
          for (const [k, p] of plans.entries()) {
            if (done.includes(k)) continue;
            try {
              const r = await applyPlannedFiles(d, fileCtx(ctx, s.id, s.nodeId), p.files, {
                actor,
                jobId: ctx.jobId,
                key: `update:${k}`,
                journal,
                undo: undoStoreOf(ctx, `update:${k}`),
                holdsLock: () => d.state.holds(s.id, "extensions", ctx.jobId),
              });
              // History and progress commit together; a failed commit leaves the in-memory progress as it was
              // (the runner persists it), so a resumed job re-checks this plan and writes its history once.
              const ok = { extensionId: p.extensionId, status: "updated" as const, versionId: p.files.find((f) => f.reason === "requested")?.versionId ?? null, error: null };
              try {
                await ctx.checkpoint(async (tx) => {
                  applied.push({ files: p.files, entries: r.entries });
                  results.push(ok);
                  done.push(k);
                  if (!r.recorded) await writeHistory(d, s.id, r.entries, { actor, jobId: ctx.jobId, status: "succeeded" }, tx);
                });
              } catch (err) {
                if (done.at(-1) === k) {
                  done.pop();
                  results.pop();
                  applied.pop();
                }
                throw Object.assign(new JobError("COMMIT_FAILED", `recording the update of ${p.extensionId} failed: ${(err as Error).message}`), { commitFailure: true });
              }
            } catch (err) {
              if ((err as { commitFailure?: boolean }).commitFailure) throw err;
              // A pre-emption ends the whole job (the remaining plans are not started).
              if (err instanceof JobError && (err.code === "LOCK_LOST" || err.code === "PREEMPTED_UNDO_SKIPPED")) throw err;
              results.push({ extensionId: p.extensionId, status: "failed", versionId: null, error: (err as Error).message.slice(0, 1024) });
              done.push(k);
              await ctx.checkpoint();
              await ctx.log("warn", `Update of ${p.extensionId} failed: ${(err as Error).message}`);
            }
          }
          delete ctx.state.journal;
          if (results.length && results.every((r) => r.status === "failed")) {
            ctx.state.allFailed = true;
          }
        },
      },
      {
        key: "rescan",
        label: "Rescan plugins/mods",
        run: async (ctx) => {
          await holdsLockForRescan(ctx);
          const changed = await rescan(d, ctx, ctx.input.serverId);
          const stamped: string[] = [];
          for (const a of (ctx.state.applied as { files: ModrinthPlannedFile[]; entries: PendingEntry[] }[]) ?? []) {
            stamped.push(...(await stampInstalled(d, ctx.input.serverId, a.files, a.entries, ctx.input.userId)));
          }
          await publishExtensions(d, ctx.input.serverId, changed === null ? null : [...new Set([...changed, ...stamped])]);
          if (ctx.state.allFailed) throw new JobError("UPDATE_FAILED", "No update could be applied (see the job result)");
        },
      },
    ],
    finalize: finalizeLock,
  };

  const rollback: JobDefinition<z.infer<typeof RollbackInput>> = {
    type: EXTENSION_JOBS.rollback,
    input: RollbackInput,
    cancelPermission: "servers.extensions.manage",
    retryLimit: 0,
    expireInSeconds: 3600,
    steps: [
      {
        key: "rollback",
        label: "Restore the previous state",
        run: async (ctx) => {
          const s = await serverOf(d, ctx.input.serverId);
          const c = fileCtx(ctx, s.id, s.nodeId);
          const [entry] = await d.db.select().from(extensionHistory).where(and(eq(extensionHistory.id, ctx.input.entryId), eq(extensionHistory.serverId, s.id)));
          if (!entry) throw new JobError("NOT_FOUND", "the history entry no longer exists");
          const id = stableId(ctx.jobId, "rollback");
          const actor = ctx.input.actor as HistoryActorFields;
          const fromKeep = !!entry.from && !refetchable(entry.from);
          // What ends up on disk: a file re-fetched from Modrinth was installed from Modrinth by BlockForge (`source`
          // is provenance); a file restored from the keep area keeps its recorded source.
          const restoredSnap = entry.from ? (fromKeep ? entry.from : { ...entry.from, source: "modrinth" as const }) : null;
          const stillHeld = () => d.state.holds(s.id, "extensions", ctx.jobId);
          const store = undoStoreOf(ctx, "rollback");
          const finish = async (p: PendingEntry | null) => {
            ctx.state.restoredPath = entry.from?.path ?? null;
            await ctx.log("info", entry.from ? `Restored ${entry.from.path}` : `Removed ${entry.to?.path ?? entry.path}`);
            // History, the consumed kept file and step success in one transaction (never applied twice; nothing
            // fallible after it); the progress and undo records are cleared in that same commit.
            await completeStep(ctx, ["rb", "undo"], { restored: restoredSnap, entryId: id }, async (tx) => {
              if (p) await writeHistory(d, s.id, [p], { actor, jobId: ctx.jobId, status: "succeeded" }, tx);
              if (fromKeep) await tx.update(extensionHistory).set({ keptPath: null, keptSha512: null, keptUntil: null }).where(eq(extensionHistory.id, entry.id));
            });
          };
          // Idempotency (#5): an interrupted attempt that already recorded its history is not re-run.
          const [prior] = await d.db.select().from(extensionHistory).where(eq(extensionHistory.id, id));
          if (prior) {
            if (prior.status === "failed") throw new JobError(store.log.error?.code ?? "ROLLBACK_FAILED", `rollback: ${prior.error ?? "failed"}`);
            return finish(null);
          }
          const fail = (err?: unknown) => failWithUndo(d, c, store, { err, what: "rollback", stillHeld, actor, jobId: ctx.jobId });
          // A crash interrupted the undo: finish it (fenced), never resume the rollback.
          if (store.log.started) return fail();
          const newer = await d.db.select().from(extensionHistory).where(and(eq(extensionHistory.serverId, s.id), eq(extensionHistory.status, "succeeded")));
          const avail = rollbackOf(entry, newer.filter((n) => n.at > entry.at), d.clock.now());
          if (!avail.available) throw new JobError("ROLLBACK_UNAVAILABLE", `the change can no longer be rolled back (${avail.reason})`);
          const rows = await d.db.select().from(installedExtensions).where(eq(installedExtensions.serverId, s.id));
          const current = entry.to ? (rows.find((r) => r.path === entry.to!.path) ?? null) : null;
          // Progress of an interrupted attempt (checkpointed around every file operation).
          type Progress = { started?: boolean; keep?: KeepRecord; kept?: Kept | null; restored?: boolean };
          const rb = ((ctx.state.rb as Progress | undefined) ?? {}) as Progress;
          const resumed = rb.started === true;
          rb.started = true;
          ctx.state.rb = rb;
          const pending: PendingEntry = {
            id,
            action: "rollback",
            extensionId: current?.id ?? entry.extensionId,
            extensionName: entry.extensionName,
            path: entry.from?.path ?? entry.path,
            from: current ? snapshotOf(current) : (entry.to ?? null),
            to: restoredSnap,
            keptPath: rb.kept?.path ?? null,
            keptSha512: rb.kept?.sha512 ?? null,
          };
          await upsertEntry(store, pending);
          const assertLock = async () => {
            if (!(await stillHeld())) throw new JobError("LOCK_LOST", "the server's operation lock was taken over (e.g. by a stop/restart/kill); the rollback stopped");
          };
          const fetchTemp = `${FETCH_DIR}/${id}.jar`;
          try {
            await assertLock();
            // The current file (the change being undone) goes to the keep area: digest journaled before the move.
            if (entry.to && rb.kept === undefined) {
              try {
                rb.kept = await keepJournaled(d, c, entry.to.path, id, {
                  record: rb.keep,
                  resumed,
                  save: async (r) => {
                    rb.keep = r;
                    await ctx.checkpoint();
                  },
                });
              } catch (err) {
                if (err instanceof UnverifiedKeptError) Object.assign(pending, { keptPath: err.keptPath, keptSha512: null, leftInKeep: true });
                throw err;
              }
              await ctx.checkpoint();
            }
            if (rb.kept && entry.to) {
              pending.keptPath = rb.kept.path;
              pending.keptSha512 = rb.kept.sha512;
              await pushUndo(store, { kind: "restore", kept: rb.kept.path, sha512: rb.kept.sha512, path: entry.to.path, entryId: id });
            }
            if (entry.from && !rb.restored) {
              await assertLock();
              const from = entry.from;
              if (!fromKeep) {
                // Downloaded to a temporary name first, then moved into place without overwriting (verified after
                // the move), so an unrelated file that now has the old name is neither replaced nor later deleted (#2).
                const placed = resumed && !(await exists(d, c, fetchTemp)) && (await sha512Of(d, c, from.path)) === from.sha512;
                if (!placed) {
                  const downloaded = resumed && (await sha512Of(d, c, fetchTemp)) === from.sha512;
                  if (await exists(d, c, from.path)) throw new JobError("CONFLICT", `${from.path} exists; remove or rename it first`);
                  await pushUndo(store, { kind: "delete", path: fetchTemp, sha512: from.sha512! });
                  if (!downloaded) {
                    let version;
                    try {
                      version = await d.upstreams.modrinth.getVersion(from.versionId!);
                    } catch (err) {
                      throw d.upstreams.jobError(err, "modrinth");
                    }
                    const picked = primaryJarFile(version, d.upstreams.modrinth.cdnHosts);
                    if ("problem" in picked) throw new JobError("ROLLBACK_UNAVAILABLE", `the old version has no installable file (${picked.problem})`);
                    if (picked.sha512 !== from.sha512) throw new JobError("ROLLBACK_UNAVAILABLE", "Modrinth no longer serves the exact file that was installed");
                    await ctx.log("info", `Downloading ${from.versionNumber ?? from.versionId} from Modrinth`);
                    await ensureDir(d.gateway, c.nodeId, s.id, FETCH_DIR, c);
                    await fetchModrinthFile(d, c, { url: picked.url, destPath: fetchTemp, sha512: from.sha512!, sizeBytes: picked.file.size });
                  }
                  await assertLock();
                  await placeVerified(d, c, fetchTemp, from.path, from.sha512!);
                }
                await pushUndo(store, { kind: "delete", path: from.path, sha512: from.sha512! });
              } else {
                if (!entry.keptPath || !entry.keptSha512) throw new JobError("ROLLBACK_UNAVAILABLE", "the previous file is no longer kept (file_unavailable)");
                const placed = resumed && !(await exists(d, c, entry.keptPath)) && (await sha512Of(d, c, from.path)) === entry.keptSha512;
                if (!placed) {
                  if (await exists(d, c, from.path)) throw new JobError("CONFLICT", `${from.path} exists; remove it first`);
                  try {
                    await restoreKept(d, c, entry.keptPath, entry.keptSha512, from.path);
                  } catch (err) {
                    if (err instanceof KeptFileChangedError) throw new JobError("ROLLBACK_UNAVAILABLE", `the kept file is missing or changed (file_unavailable): ${err.message}`);
                    throw err;
                  }
                }
                // Undo = back into the keep area (verified: it must still be exactly the restored file).
                await pushUndo(store, { kind: "restore", kept: from.path, sha512: entry.keptSha512, path: entry.keptPath });
              }
              rb.restored = true;
              await ctx.checkpoint();
            }
            await assertLock();
          } catch (err) {
            return fail(err);
          }
          await finish(pending);
        },
      },
      {
        key: "rescan",
        label: "Rescan plugins/mods",
        run: async (ctx) => {
          await holdsLockForRescan(ctx);
          const changed = await rescan(d, ctx, ctx.input.serverId);
          const restored = ctx.state.restored as { source: string; path: string; projectId: string | null; versionId: string | null; versionNumber: string | null; sha512: string | null } | null;
          if (restored) {
            const [row] = await d.db
              .update(installedExtensions)
              .set({ source: restored.source, installedAt: new Date(d.clock.now()), installedBy: ctx.input.userId })
              .where(and(eq(installedExtensions.serverId, ctx.input.serverId), eq(installedExtensions.path, restored.path)))
              .returning({ id: installedExtensions.id });
            if (row) await d.db.update(extensionHistory).set({ extensionId: row.id }).where(inArray(extensionHistory.id, [ctx.state.entryId as string]));
          }
          await publishExtensions(d, ctx.input.serverId, changed);
        },
      },
    ],
    finalize: finalizeLock,
  };

  return [scan, install, update, rollback] as unknown as JobDefinition<never>[];
}
