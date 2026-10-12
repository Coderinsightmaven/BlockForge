import type { CommandPayload, ServerState, WorkloadStatus } from "@blockforge/contracts";
import { and, eq, ne } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import type { ConsoleBuffers } from "../agents/console-buffer.js";
import { AgentCommandError, type AgentGateway } from "../agents/gateway.js";
import type { WorkloadOwnership } from "../agents/workload-ownership.js";
import type { AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { alertIncidents, allocations, resourceReservations, servers } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { EventBus } from "../events/bus.js";
import { JobError, SKIP_STEP, type FinalizeContext, type JobDefinition, type StepContext } from "../jobs/types.js";
import type { Clock } from "../lib/clock.js";
import type { LatestCache } from "../metrics/latest.js";
import {
  applyEggConfigFiles,
  buildWorkloadSpec,
  eggEnvironment,
  isMinecraftTemplate,
  loadRuntimeContext,
  minecraftProvisioning,
  readFileIfExists,
  waitForReady,
  writeMinecraftFiles,
  type ServerRuntimeContext,
} from "./runtime.js";
import type { ServerStateService } from "./state.js";

export const SERVER_JOBS = {
  provision: "server.provision",
  reinstall: "server.reinstall",
  start: "server.start",
  stop: "server.stop",
  restart: "server.restart",
  kill: "server.kill",
  delete: "server.delete",
} as const;

export interface ServerJobDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  gateway: AgentGateway;
  latest: LatestCache;
  consoles: ConsoleBuffers;
  ownership: WorkloadOwnership;
  state: ServerStateService;
  bus: EventBus;
  audit: AuditService;
  readyTimeoutMs?: number;
  slpWaitMs?: number;
  installTimeoutMs?: number;
}

const ProvisionInput = z.object({ serverId: z.uuid(), eulaAcceptedBy: z.string().max(254).nullable().default(null) });
const ServerInput = z.object({ serverId: z.uuid() });
const StopInput = ServerInput.extend({ timeoutMs: z.number().int().min(1000).max(600_000).default(60_000) });
const DeleteInput = ServerInput.extend({ deleteData: z.boolean().default(false) });

type Ctx<I> = StepContext<I>;
const send = (deps: ServerJobDeps) => deps.gateway;

/** Agent command failures are retryable when the agent says so or the node was unreachable. */
function wrap(err: unknown, what: string): never {
  if (err instanceof AgentCommandError) throw new JobError(err.code, `${what}: ${err.message}`, err.retryable);
  throw err;
}

async function requireNode(deps: ServerJobDeps, rt: ServerRuntimeContext): Promise<void> {
  if (!deps.gateway.isReady(rt.server.nodeId)) throw new JobError("NODE_UNAVAILABLE", "the server's node is not connected", true);
}

/** Velocity binds its default port until BlockForge has set `bind` in the velocity.toml it generated. */
async function velocityBindPending(deps: ServerJobDeps, ctx: Ctx<{ serverId: string }>, rt: ServerRuntimeContext): Promise<boolean> {
  if (rt.server.software !== "velocity") return false;
  const cfg = await readFileIfExists(deps.gateway, rt.server.nodeId, rt.server.id, "velocity.toml", { jobId: ctx.jobId, signal: ctx.signal }).catch((err: unknown) =>
    wrap(err, "reading velocity.toml"),
  );
  if (!cfg) return true;
  const w = await writeMinecraftFiles(deps.gateway, rt, { jobId: ctx.jobId, signal: ctx.signal, acceptedBy: null, includeEula: false });
  if (w.written.length) await ctx.log("info", `Velocity bind set to the primary allocation (${w.written.join(", ")})`);
  return false;
}

async function ensureWorkload(deps: ServerJobDeps, ctx: Ctx<{ serverId: string }>, rt: ServerRuntimeContext): Promise<void> {
  await requireNode(deps, rt);
  const pending = await velocityBindPending(deps, ctx, rt);
  const spec = buildWorkloadSpec(rt, { velocityBindPending: pending });
  if (pending) await ctx.log("warn", "Velocity has not written velocity.toml yet; the primary port is mapped to its default port until the next start");
  try {
    const r = await send(deps).send(rt.server.nodeId, "workload.ensure", spec, { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 180_000 });
    await ctx.log("info", `Container ${r.created ? "created" : r.changed ? "updated" : "unchanged"} (${spec.image})`);
  } catch (err) {
    wrap(err, "workload.ensure");
  }
}

/** Mirrors install-container output into the job log while `fn` runs. */
async function withInstallLog<T>(deps: ServerJobDeps, ctx: Ctx<{ serverId: string }>, fn: () => Promise<T>): Promise<T> {
  const onLines = (serverId: string, lines: { line: string; stream: string }[]) => {
    if (serverId !== ctx.input.serverId) return;
    for (const l of lines) void ctx.log(l.stream === "stderr" ? "warn" : "info", `[install] ${l.line}`);
  };
  deps.gateway.on("installLines", onLines);
  try {
    return await fn();
  } finally {
    deps.gateway.off("installLines", onLines);
  }
}

async function downloadArtifacts(deps: ServerJobDeps, ctx: Ctx<{ serverId: string }>, rt: ServerRuntimeContext): Promise<void | typeof SKIP_STEP> {
  if (!isMinecraftTemplate(rt.template.kind) || !rt.server.artifactPlan) return SKIP_STEP;
  const prov = minecraftProvisioning(rt);
  for (const w of prov.warnings) await ctx.log("warn", w);
  for (const d of prov.downloads) {
    await ctx.setMessage(`Downloading ${d.destPath}`);
    try {
      const r = await send(deps).send(rt.server.nodeId, "artifact.fetch", d, { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 15 * 60_000 });
      await ctx.log("info", `${d.destPath}: ${r.bytes} bytes${r.cached ? " (artifact cache hit)" : ""}, sha256 ${r.sha256}`);
    } catch (err) {
      wrap(err, `download of ${d.destPath}`);
    }
  }
}

async function runInstall(deps: ServerJobDeps, ctx: Ctx<{ serverId: string }>, rt: ServerRuntimeContext): Promise<void | typeof SKIP_STEP> {
  const s = rt.server;
  let payload: CommandPayload<"workload.install">;
  let expects: string[] = [];
  let cleanup: string[] = [];
  if (isMinecraftTemplate(rt.template.kind)) {
    const install = minecraftProvisioning(rt).install;
    if (!install) return SKIP_STEP;
    payload = install.payload;
    expects = install.expects;
    cleanup = install.cleanup;
  } else {
    const install = rt.template.install;
    if (!install) return SKIP_STEP;
    payload = {
      workloadId: s.id,
      image: install.image,
      entrypoint: install.entrypoint,
      script: install.script,
      env: eggEnvironment(rt),
      memoryLimitBytes: s.memoryLimitBytes,
      cpuLimitMillicores: s.cpuLimitMillicores,
      timeoutMs: deps.installTimeoutMs ?? 30 * 60_000,
    };
  }
  await ctx.log("info", `Running the install container (${payload.image})`);
  const timeoutMs = payload.timeoutMs ?? 30 * 60_000;
  const result = await withInstallLog(deps, ctx, async () => {
    try {
      return await send(deps).send(s.nodeId, "workload.install", payload, { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 900_000, resultTimeoutMs: timeoutMs + 60_000 });
    } catch (err) {
      return wrap(err, "workload.install");
    }
  });
  if (result.timedOut || result.exitCode !== 0) {
    for (const l of result.logTail.slice(-20)) await ctx.log("error", `[install] ${l}`);
    throw new JobError("INSTALL_FAILED", result.timedOut ? "the install script timed out" : `the install script exited with code ${result.exitCode}`);
  }
  await ctx.log("info", `Install finished in ${Math.round(result.durationMs / 1000)} s`);
  for (const path of expects) {
    try {
      await send(deps).send(s.nodeId, "fs.stat", { workloadId: s.id, path }, { jobId: ctx.jobId, signal: ctx.signal });
    } catch (err) {
      if (err instanceof AgentCommandError && err.code === "NOT_FOUND") throw new JobError("INSTALL_INCOMPLETE", `the installer did not produce ${path}`);
      wrap(err, "fs.stat");
    }
  }
  for (const path of cleanup) {
    await send(deps)
      .send(s.nodeId, "fs.delete", { workloadId: s.id, path, recursive: false }, { jobId: ctx.jobId, signal: ctx.signal })
      .catch(() => undefined);
  }
  const plan = s.artifactPlan;
  if (plan && plan.launch.kind === "jar-candidates") {
    let chosen: string | null = null;
    for (const c of plan.launch.candidates) {
      const ok = await send(deps)
        .send(s.nodeId, "fs.stat", { workloadId: s.id, path: c }, { jobId: ctx.jobId, signal: ctx.signal })
        .then(() => true, () => false);
      if (ok) {
        chosen = c;
        break;
      }
    }
    if (!chosen) throw new JobError("INSTALL_INCOMPLETE", `none of ${plan.launch.candidates.join(", ")} exists after installation`);
    const resolved = { ...plan, launch: { kind: "jar" as const, jar: chosen, programArgs: plan.launch.programArgs } };
    await deps.db.update(servers).set({ artifactPlan: resolved }).where(eq(servers.id, s.id));
    await ctx.log("info", `Launch jar: ${chosen}`);
    await ensureWorkload(deps, ctx, { ...rt, server: { ...rt.server, artifactPlan: resolved } });
  }
}

async function configure(deps: ServerJobDeps, ctx: Ctx<{ serverId: string; eulaAcceptedBy?: string | null }>, rt: ServerRuntimeContext, firstInstall: boolean): Promise<void | typeof SKIP_STEP> {
  if (isMinecraftTemplate(rt.template.kind)) {
    if (!firstInstall) return SKIP_STEP;
    const eula = rt.server.kind === "game" && Boolean(ctx.input.eulaAcceptedBy);
    const r = await writeMinecraftFiles(deps.gateway, rt, { jobId: ctx.jobId, signal: ctx.signal, acceptedBy: ctx.input.eulaAcceptedBy ?? null, includeEula: eula }).catch((err: unknown) =>
      wrap(err, "writing server configuration"),
    );
    for (const w of r.warnings) await ctx.log("warn", w);
    ctx.state.gameRules = r.gameRules;
    if (!r.written.length) return SKIP_STEP;
    await ctx.log("info", `Written: ${r.written.join(", ")}${eula ? " (Mojang EULA accepted at creation)" : ""}`);
    return;
  }
  const r = await applyEggConfigFiles(deps.gateway, rt, { jobId: ctx.jobId, signal: ctx.signal }).catch((err: unknown) => wrap(err, "applying config files"));
  for (const w of r.warnings) await ctx.log("warn", w);
  if (!r.written.length && !rt.template.configFiles.length) return SKIP_STEP;
  await ctx.log("info", r.written.length ? `Config files updated: ${r.written.join(", ")}` : "Config files already up to date");
}

async function startWorkload(deps: ServerJobDeps, ctx: Ctx<{ serverId: string }>, rt: ServerRuntimeContext): Promise<void> {
  await requireNode(deps, rt);
  await deps.state.transition(rt.server.id, "starting", {}, { reason: "start" });
  ctx.state.startedAt = deps.clock.now();
  try {
    const st = await send(deps).send(rt.server.nodeId, "workload.start", { workloadId: rt.server.id }, { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 120_000 });
    if (st.state !== "running" && st.state !== "restarting") throw new JobError("START_FAILED", `the container is ${st.state} after start`);
  } catch (err) {
    wrap(err, "workload.start");
  }
  await ctx.log("info", "Container started; waiting for the server to become ready");
}

async function awaitReady(deps: ServerJobDeps, ctx: Ctx<{ serverId: string }>, rt: ServerRuntimeContext): Promise<void> {
  const since = Number(ctx.state.startedAt ?? deps.clock.now());
  const r = await waitForReady(
    { gateway: deps.gateway, latest: deps.latest, consoleTail: (id) => deps.consoles.tail(id, 5000).lines },
    rt,
    { since, timeoutMs: deps.readyTimeoutMs ?? 15 * 60_000, signal: ctx.signal, ...(deps.slpWaitMs !== undefined ? { slpWaitMs: deps.slpWaitMs } : {}) },
  );
  if (isMinecraftTemplate(rt.template.kind) && rt.server.software !== "velocity" && !r.slp) {
    await ctx.log("warn", "The server reported ready but no Server List Ping answer arrived (status may be disabled)");
  }
  await deps.state.transition(rt.server.id, "running", { lastStartedAt: new Date(deps.clock.now()) }, { reason: "ready" });
  await ctx.log("info", "Server is running");
  const rules = Array.isArray(ctx.state.gameRules) ? (ctx.state.gameRules as string[]) : [];
  for (const line of rules) {
    await send(deps)
      .send(rt.server.nodeId, "workload.console", { workloadId: rt.server.id, line }, { jobId: ctx.jobId, signal: ctx.signal })
      .then(() => ctx.log("info", `Applied: ${line}`), (err: unknown) => ctx.log("warn", `Could not apply "${line}": ${(err as Error).message}`));
  }
  ctx.state.gameRules = [];
}

async function stopWorkload(deps: ServerJobDeps, ctx: Ctx<{ serverId: string }>, rt: ServerRuntimeContext, timeoutMs: number): Promise<void> {
  await requireNode(deps, rt);
  try {
    await send(deps).send(rt.server.nodeId, "workload.stop", { workloadId: rt.server.id, timeoutMs }, { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: timeoutMs + 30_000 });
  } catch (err) {
    if (err instanceof AgentCommandError && err.code === "NOT_FOUND") return;
    wrap(err, "workload.stop");
  }
}

/**
 * Brings the recorded state in line with the agent's view after a failed or cancelled operation.
 */
export async function settleFromRuntime(deps: ServerJobDeps, serverId: string, fallback: ServerState): Promise<void> {
  const [row] = await deps.db.select({ nodeId: servers.nodeId, state: servers.state }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!row) return;
  if (!deps.gateway.isReady(row.nodeId)) {
    await deps.state.transition(serverId, "unreachable", {}, { reason: "node not connected" });
    return;
  }
  let st: WorkloadStatus | undefined;
  try {
    st = (await deps.gateway.send(row.nodeId, "workload.status", { workloadId: serverId }, { timeoutMs: 15_000 })).workloads[0];
  } catch {
    st = undefined;
  }
  const to: ServerState = !st ? fallback : st.state === "running" ? "running" : st.state === "restarting" ? "crashed" : (st.exitCode ?? 0) !== 0 ? "crashed" : "stopped";
  if (!(await deps.state.transition(serverId, to, {}, { reason: "settle" }))) await deps.state.transition(serverId, fallback, {}, { reason: "settle" });
}

async function convertHold(deps: ServerJobDeps, serverId: string): Promise<void> {
  await deps.db
    .update(resourceReservations)
    .set({ kind: "server", expiresAt: null })
    .where(and(eq(resourceReservations.serverId, serverId), eq(resourceReservations.kind, "hold")));
}

export function serverJobDefinitions(deps: ServerJobDeps): JobDefinition<never>[] {
  const load = (id: string) => loadRuntimeContext(deps.db, id);

  const provision: JobDefinition<z.infer<typeof ProvisionInput>> = {
    type: SERVER_JOBS.provision,
    input: ProvisionInput,
    cancelPermission: "servers.delete",
    retryLimit: 2,
    retryDelaySeconds: 5,
    // Downloads (≤15 min each) + installer (≤45 min) + first start.
    expireInSeconds: 7200,
    steps: [
      { key: "ensure", label: "Create the container", run: async (ctx) => ensureWorkload(deps, ctx, await load(ctx.input.serverId)) },
      { key: "download", label: "Download server files", run: async (ctx) => downloadArtifacts(deps, ctx, await load(ctx.input.serverId)) },
      { key: "install", label: "Run the installer", run: async (ctx) => runInstall(deps, ctx, await load(ctx.input.serverId)) },
      { key: "configure", label: "Write configuration", run: async (ctx) => configure(deps, ctx, await load(ctx.input.serverId), true) },
      {
        key: "start",
        label: "Start the server",
        run: async (ctx) => {
          const rt = await load(ctx.input.serverId);
          if (rt.server.startup === "manual") return SKIP_STEP;
          await startWorkload(deps, ctx, rt);
        },
      },
      {
        key: "ready",
        label: "Wait until the server is ready",
        run: async (ctx) => {
          if (ctx.state.startedAt === undefined) return SKIP_STEP;
          await awaitReady(deps, ctx, await load(ctx.input.serverId));
        },
      },
    ],
    async finalize(f: FinalizeContext<z.infer<typeof ProvisionInput>>) {
      const id = f.input.serverId;
      await convertHold(deps, id);
      if (f.status === "succeeded") {
        await deps.db.update(servers).set({ installedAt: new Date(deps.clock.now()) }).where(eq(servers.id, id));
        if (f.state.startedAt === undefined) await deps.state.transition(id, "stopped", {}, { reason: "provisioned" });
        await deps.bus.publish({ type: "server.installed", subjectType: "server", subjectId: id, data: { jobId: f.jobId } });
        await deps.bus.publish({ type: "server.provision.completed", subjectType: "server", subjectId: id, data: { jobId: f.jobId } });
      } else {
        const crashed = f.error?.code === "CRASHED";
        const [row] = await deps.db.select({ state: servers.state }).from(servers).where(eq(servers.id, id));
        if (row?.state === "starting") {
          await deps.db.update(servers).set({ installedAt: new Date(deps.clock.now()) }).where(eq(servers.id, id));
          await deps.state.transition(id, crashed ? "crashed" : "stopped", crashed ? { lastCrashAt: new Date(deps.clock.now()) } : {}, { reason: "provision start failed" });
          if (crashed) await deps.bus.publish({ type: "server.crashed", subjectType: "server", subjectId: id, data: { during: "provision" } });
        } else {
          await deps.state.transition(id, "provision_failed", {}, { reason: f.error?.message ?? f.status });
        }
        if (f.error?.code === "INSTALL_FAILED" || f.error?.code === "INSTALL_INCOMPLETE") {
          await deps.bus.publish({ type: "server.install.failed", subjectType: "server", subjectId: id, data: { jobId: f.jobId, message: f.error.message } });
        }
        await deps.bus.publish({ type: "server.provision.failed", subjectType: "server", subjectId: id, data: { jobId: f.jobId, error: f.error } });
      }
      await deps.state.end(id, f.jobId);
    },
  };

  const reinstall: JobDefinition<z.infer<typeof ServerInput>> = {
    type: SERVER_JOBS.reinstall,
    input: ServerInput,
    cancelPermission: "servers.reinstall",
    retryLimit: 2,
    // Downloads (≤15 min each) + installer (≤45 min).
    expireInSeconds: 7200,
    steps: [
      { key: "ensure", label: "Update the container", run: async (ctx) => ensureWorkload(deps, ctx, await load(ctx.input.serverId)) },
      { key: "download", label: "Download server files", run: async (ctx) => downloadArtifacts(deps, ctx, await load(ctx.input.serverId)) },
      { key: "install", label: "Run the installer", run: async (ctx) => runInstall(deps, ctx, await load(ctx.input.serverId)) },
      { key: "configure", label: "Write configuration", run: async (ctx) => configure(deps, ctx, await load(ctx.input.serverId), true) },
    ],
    async finalize(f) {
      const id = f.input.serverId;
      if (f.status === "succeeded") {
        await deps.db.update(servers).set({ installedAt: new Date(deps.clock.now()) }).where(eq(servers.id, id));
        await deps.state.transition(id, "stopped", {}, { reason: "reinstalled" });
        await deps.bus.publish({ type: "server.installed", subjectType: "server", subjectId: id, data: { jobId: f.jobId, reinstall: true } });
      } else {
        await deps.state.transition(id, "provision_failed", {}, { reason: f.error?.message ?? f.status });
        await deps.bus.publish({ type: "server.install.failed", subjectType: "server", subjectId: id, data: { jobId: f.jobId, message: f.error?.message ?? f.status } });
      }
      await deps.state.end(id, f.jobId);
    },
  };

  const prepareStart = async (ctx: Ctx<{ serverId: string }>) => {
    const rt = await load(ctx.input.serverId);
    await ensureWorkload(deps, ctx, rt);
    if (!isMinecraftTemplate(rt.template.kind)) await configure(deps, ctx, rt, false);
  };

  const failSettle = (fallback: ServerState) => async (f: FinalizeContext<{ serverId: string }>) => {
    if (f.status !== "succeeded") {
      if (f.error?.code === "CRASHED") {
        await deps.state.transition(f.input.serverId, "crashed", { lastCrashAt: new Date(deps.clock.now()) }, { reason: "crashed during start" });
        await deps.bus.publish({ type: "server.crashed", subjectType: "server", subjectId: f.input.serverId, data: { during: "start" } });
      } else await settleFromRuntime(deps, f.input.serverId, fallback);
    }
    await deps.state.end(f.input.serverId, f.jobId);
  };

  const start: JobDefinition<z.infer<typeof ServerInput>> = {
    type: SERVER_JOBS.start,
    input: ServerInput,
    cancelPermission: "servers.control",
    retryLimit: 0,
    steps: [
      { key: "prepare", label: "Prepare the container", run: prepareStart },
      { key: "start", label: "Start the server", run: async (ctx) => startWorkload(deps, ctx, await load(ctx.input.serverId)) },
      { key: "ready", label: "Wait until the server is ready", run: async (ctx) => awaitReady(deps, ctx, await load(ctx.input.serverId)) },
    ],
    finalize: failSettle("stopped"),
  };

  const stop: JobDefinition<z.infer<typeof StopInput>> = {
    type: SERVER_JOBS.stop,
    input: StopInput,
    cancelPermission: "servers.control",
    retryLimit: 0,
    steps: [
      {
        key: "stop",
        label: "Stop the server",
        run: async (ctx) => {
          await stopWorkload(deps, ctx, await load(ctx.input.serverId), ctx.input.timeoutMs);
          await deps.state.transition(ctx.input.serverId, "stopped", {}, { reason: "stopped" });
        },
      },
    ],
    finalize: failSettle("stopped"),
  };

  const restart: JobDefinition<z.infer<typeof StopInput>> = {
    type: SERVER_JOBS.restart,
    input: StopInput,
    cancelPermission: "servers.control",
    retryLimit: 0,
    steps: [
      {
        key: "stop",
        label: "Stop the server",
        run: async (ctx) => {
          const rt = await load(ctx.input.serverId);
          if (rt.server.state !== "stopping") return SKIP_STEP;
          await stopWorkload(deps, ctx, rt, ctx.input.timeoutMs);
          await deps.state.transition(ctx.input.serverId, "stopped", {}, { reason: "restart" });
        },
      },
      { key: "prepare", label: "Prepare the container", run: prepareStart },
      { key: "start", label: "Start the server", run: async (ctx) => startWorkload(deps, ctx, await load(ctx.input.serverId)) },
      { key: "ready", label: "Wait until the server is ready", run: async (ctx) => awaitReady(deps, ctx, await load(ctx.input.serverId)) },
    ],
    finalize: failSettle("stopped"),
  };

  const kill: JobDefinition<z.infer<typeof ServerInput>> = {
    type: SERVER_JOBS.kill,
    input: ServerInput,
    cancelPermission: "servers.control",
    retryLimit: 0,
    steps: [
      {
        key: "kill",
        label: "Kill the server process",
        run: async (ctx) => {
          const rt = await load(ctx.input.serverId);
          await requireNode(deps, rt);
          await send(deps)
            .send(rt.server.nodeId, "workload.kill", { workloadId: rt.server.id }, { jobId: ctx.jobId, signal: ctx.signal })
            .catch((err: unknown) => wrap(err, "workload.kill"));
          await deps.state.transition(ctx.input.serverId, "stopped", {}, { reason: "killed" });
        },
      },
    ],
    finalize: failSettle("stopped"),
  };

  const del: JobDefinition<z.infer<typeof DeleteInput>> = {
    type: SERVER_JOBS.delete,
    input: DeleteInput,
    cancelPermission: "servers.delete",
    retryLimit: 3,
    retryDelaySeconds: 10,
    steps: [
      {
        key: "remove",
        label: "Remove the container",
        run: async (ctx) => {
          const rt = await load(ctx.input.serverId);
          await requireNode(deps, rt);
          try {
            await send(deps).send(rt.server.nodeId, "workload.remove", { workloadId: rt.server.id, deleteData: ctx.input.deleteData }, { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 300_000 });
          } catch (err) {
            if (!(err instanceof AgentCommandError && err.code === "NOT_FOUND")) wrap(err, "workload.remove");
          }
          await ctx.log("info", ctx.input.deleteData ? "Container and data removed" : "Container removed (data kept on the node)");
        },
      },
      {
        key: "cleanup",
        label: "Release allocations and delete records",
        run: async (ctx) => {
          const id = ctx.input.serverId;
          const [row] = await deps.db.select({ name: servers.name, nodeId: servers.nodeId }).from(servers).where(eq(servers.id, id));
          await withTransaction(deps.db, async (tx, after) => {
            await tx.update(allocations).set({ serverId: null, isPrimary: false, notes: null }).where(eq(allocations.serverId, id));
            await tx
              .update(alertIncidents)
              .set({ status: "resolved", resolvedAt: new Date(deps.clock.now()) })
              .where(and(eq(alertIncidents.subjectType, "server"), eq(alertIncidents.subjectId, id), ne(alertIncidents.status, "resolved")));
            await tx.update(servers).set({ activeJobId: null }).where(eq(servers.id, id));
            await tx.delete(servers).where(eq(servers.id, id));
            await deps.bus.publish({ type: "server.deleted", subjectType: "server", subjectId: id, data: { name: row?.name ?? null, jobId: ctx.jobId } }, { tx, after });
          });
          deps.ownership.invalidate(id);
          deps.consoles.remove(id);
          deps.latest.removeWorkload(id);
          deps.state.notify(id);
          await deps.audit.record({ actorType: "system", actorId: null, actorName: "job", action: "server.deleted", targetType: "server", targetId: id, outcome: "success", details: { jobId: ctx.jobId, name: row?.name ?? null } });
        },
      },
    ],
    async finalize(f) {
      if (f.status !== "succeeded") {
        const [row] = await deps.db.select({ id: servers.id }).from(servers).where(eq(servers.id, f.input.serverId));
        if (row) {
          await settleFromRuntime(deps, f.input.serverId, "stopped");
          await deps.state.end(f.input.serverId, f.jobId);
        }
      }
    },
  };

  return [provision, reinstall, start, stop, restart, kill, del] as unknown as JobDefinition<never>[];
}
