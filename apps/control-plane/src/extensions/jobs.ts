import { randomUUID } from "node:crypto";
import { ModrinthInstallPlan, type ModrinthPlannedFile } from "@blockforge/contracts";
import { checkModrinthUpdates, fromContractPlanRequest, planModrinthInstall, primaryJarFile, toContractInstallPlan, type InstalledExtensionRef } from "@blockforge/minecraft";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { extensionHistory, installedExtensions, servers } from "../db/schema/index.js";
import { JobError, type JobDefinition, type StepContext } from "../jobs/types.js";
import {
  agentOpts,
  EXTENSION_JOBS,
  jobAgentError,
  releaseExtensionLock,
  restartRequired,
  rollbackOf,
  snapshotOf,
  targetOf,
  type ExtensionDeps,
  type ExtensionRow,
} from "./model.js";
import { applyPlannedFiles, deleteFile, exists, fetchModrinthFile, keepFile, sha512Of, stampInstalled, writeHistory, type FileCtx, type HistoryActorFields, type PendingEntry } from "./ops.js";
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
  const finalizeLock = async (f: { input: { serverId: string }; jobId: string; status: string; error: { message: string } | null }) => {
    try {
      if (f.status !== "succeeded") {
        const [s] = await d.db.select({ id: servers.id }).from(servers).where(eq(servers.id, f.input.serverId));
        if (s) await publishExtensions(d, f.input.serverId, null);
      }
    } finally {
      await releaseExtensionLock(d.db, f.input.serverId, f.jobId);
    }
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
          const entries = await applyPlannedFiles(d, fileCtx(ctx, s.id, s.nodeId), ctx.input.plan.files, { actor: ctx.input.actor as HistoryActorFields, jobId: ctx.jobId });
          await writeHistory(d, s.id, entries, { actor: ctx.input.actor as HistoryActorFields, jobId: ctx.jobId, status: "succeeded" });
          ctx.state.entries = entries;
          await ctx.log("info", `Installed ${ctx.input.plan.files.length} file(s)${restartRequired(s.state) ? "; they take effect at the next restart" : ""}`);
        },
      },
      {
        key: "rescan",
        label: "Rescan plugins/mods",
        run: async (ctx) => {
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
          const plans = (ctx.state.plans as Array<{ extensionId: string; files: ModrinthPlannedFile[] }>) ?? [];
          const results = (ctx.state.results as UpdateResult[]) ?? [];
          const applied: { files: ModrinthPlannedFile[]; entries: PendingEntry[] }[] = [];
          for (const p of plans) {
            try {
              const entries = await applyPlannedFiles(d, fileCtx(ctx, s.id, s.nodeId), p.files, { actor: ctx.input.actor as HistoryActorFields, jobId: ctx.jobId });
              await writeHistory(d, s.id, entries, { actor: ctx.input.actor as HistoryActorFields, jobId: ctx.jobId, status: "succeeded" });
              applied.push({ files: p.files, entries });
              results.push({ extensionId: p.extensionId, status: "updated", versionId: p.files.find((f) => f.reason === "requested")?.versionId ?? null, error: null });
            } catch (err) {
              results.push({ extensionId: p.extensionId, status: "failed", versionId: null, error: (err as Error).message.slice(0, 1024) });
              await ctx.log("warn", `Update of ${p.extensionId} failed: ${(err as Error).message}`);
            }
          }
          ctx.state.results = results;
          ctx.state.applied = applied;
          if (results.length && results.every((r) => r.status === "failed")) {
            ctx.state.allFailed = true;
          }
        },
      },
      {
        key: "rescan",
        label: "Rescan plugins/mods",
        run: async (ctx) => {
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
          const newer = await d.db.select().from(extensionHistory).where(and(eq(extensionHistory.serverId, s.id), eq(extensionHistory.status, "succeeded")));
          const avail = rollbackOf(entry, newer.filter((n) => n.at > entry.at), d.clock.now());
          if (!avail.available) throw new JobError("ROLLBACK_UNAVAILABLE", `the change can no longer be rolled back (${avail.reason})`);
          const rows = await d.db.select().from(installedExtensions).where(eq(installedExtensions.serverId, s.id));
          const id = randomUUID();
          const actor = ctx.input.actor as HistoryActorFields;
          const current = entry.to ? (rows.find((r) => r.path === entry.to!.path) ?? null) : null;
          const pending: PendingEntry = {
            id,
            action: "rollback",
            extensionId: current?.id ?? entry.extensionId,
            extensionName: entry.extensionName,
            path: entry.from?.path ?? entry.path,
            from: current ? snapshotOf(current) : (entry.to ?? null),
            to: entry.from ?? null,
            keptPath: null,
            keptSha512: current?.sha512 ?? entry.to?.sha512 ?? null,
          };
          let keptCurrent: string | null = null;
          let restoredFetched = false;
          let movedBack = false;
          try {
            // The current file (the change being undone) goes to the keep area.
            if (entry.to && (await exists(d, c, entry.to.path))) {
              keptCurrent = await keepFile(d, c, entry.to.path, id);
              pending.keptPath = keptCurrent;
            }
            if (entry.from) {
              const from = entry.from;
              if (from.source === "modrinth" && from.projectId && from.versionId && from.sha512) {
                let version;
                try {
                  version = await d.upstreams.modrinth.getVersion(from.versionId);
                } catch (err) {
                  throw d.upstreams.jobError(err, "modrinth");
                }
                const picked = primaryJarFile(version, d.upstreams.modrinth.cdnHosts);
                if ("problem" in picked) throw new JobError("ROLLBACK_UNAVAILABLE", `the old version has no installable file (${picked.problem})`);
                if (picked.sha512 !== from.sha512) throw new JobError("ROLLBACK_UNAVAILABLE", "Modrinth no longer serves the exact file that was installed");
                await ctx.log("info", `Downloading ${from.versionNumber ?? from.versionId} from Modrinth`);
                await fetchModrinthFile(d, c, { url: picked.url, destPath: from.path, sha512: from.sha512, sizeBytes: picked.file.size });
                restoredFetched = true;
              } else {
                if (!entry.keptPath || !entry.keptSha512) throw new JobError("ROLLBACK_UNAVAILABLE", "the previous file is no longer kept (file_unavailable)");
                if ((await sha512Of(d, c, entry.keptPath)) !== entry.keptSha512) throw new JobError("ROLLBACK_UNAVAILABLE", "the kept file is missing or changed (file_unavailable)");
                if (await exists(d, c, from.path)) throw new JobError("CONFLICT", `${from.path} exists; remove it first`);
                await d.gateway.send(c.nodeId, "fs.rename", { workloadId: s.id, from: entry.keptPath, to: from.path }, agentOpts(c));
                movedBack = true;
                await d.db.update(extensionHistory).set({ keptPath: null, keptSha512: null, keptUntil: null }).where(eq(extensionHistory.id, entry.id));
              }
            }
          } catch (err) {
            try {
              if (restoredFetched && entry.from) await deleteFile(d, c, entry.from.path);
              if (movedBack && entry.from && entry.keptPath) await d.gateway.send(c.nodeId, "fs.rename", { workloadId: s.id, from: entry.from.path, to: entry.keptPath }, agentOpts(c));
              if (keptCurrent && entry.to) await d.gateway.send(c.nodeId, "fs.rename", { workloadId: s.id, from: keptCurrent, to: entry.to.path }, agentOpts(c));
            } catch (e) {
              await ctx.log("error", `Undo failed: ${(e as Error).message}`);
            }
            await writeHistory(d, s.id, [pending], { actor, jobId: ctx.jobId, status: "failed", error: (err as Error).message });
            throw jobAgentError(err, "rollback");
          }
          await writeHistory(d, s.id, [pending], { actor, jobId: ctx.jobId, status: "succeeded" });
          ctx.state.restoredPath = entry.from?.path ?? null;
          ctx.state.restored = entry.from ?? null;
          ctx.state.entryId = id;
          await ctx.log("info", entry.from ? `Restored ${entry.from.path}` : `Removed ${entry.to?.path ?? entry.path}`);
        },
      },
      {
        key: "rescan",
        label: "Rescan plugins/mods",
        run: async (ctx) => {
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
