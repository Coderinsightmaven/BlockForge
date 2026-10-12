import type { ArtifactPlan, CommandPayload, ConfigFileRule, PortBinding, ServerSoftware, Template, WorkloadStatus } from "@blockforge/contracts";
import type { ResolvedArtifact } from "@blockforge/minecraft";
import { applyConfigFileRule, buildEggEnvironment, createDoneMatcher, memoryMiB, type PlaceholderContext } from "@blockforge/eggs";
import {
  buildLaunchSpec,
  buildMinecraftProvisioning,
  detectLogEvents,
  detectReadiness,
  type JvmPreset,
  type LaunchSpec,
  type MinecraftProvisioning,
} from "@blockforge/minecraft";
import { asc, eq } from "drizzle-orm";
import { AgentCommandError, type AgentGateway } from "../agents/gateway.js";
import type { ConsoleLine } from "../agents/console-buffer.js";
import type { Db } from "../db/client.js";
import { allocations, servers, serverVariables, templates, templateVariables } from "../db/schema/index.js";
import type { LatestCache } from "../metrics/latest.js";
import { JobError } from "../jobs/types.js";

export type ServerRow = typeof servers.$inferSelect;
export type AllocationRow = typeof allocations.$inferSelect;
type TemplateRow = typeof templates.$inferSelect;

/** Everything needed to build a workload for a server. */
export interface ServerRuntimeContext {
  server: ServerRow;
  template: TemplateRow & { variables: Template["variables"] };
  allocations: AllocationRow[];
  /** User-set egg variable values (defaults not included). */
  values: Record<string, string>;
}

/** Port Velocity binds in its default config (before BlockForge has set `bind`). */
export const VELOCITY_DEFAULT_PORT = 25565;
const MAX_PORT_BINDINGS = 16;

export async function loadRuntimeContext(db: Db, serverId: string): Promise<ServerRuntimeContext> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) throw new JobError("NOT_FOUND", "server no longer exists");
  const [template] = await db.select().from(templates).where(eq(templates.id, server.templateId)).limit(1);
  if (!template) throw new JobError("NOT_FOUND", "template no longer exists");
  const vars = await db
    .select()
    .from(templateVariables)
    .where(eq(templateVariables.templateId, template.id))
    .orderBy(asc(templateVariables.sortOrder));
  const allocs = await db.select().from(allocations).where(eq(allocations.serverId, serverId)).orderBy(asc(allocations.port));
  const values = Object.fromEntries((await db.select().from(serverVariables).where(eq(serverVariables.serverId, serverId))).map((v) => [v.envName, v.value]));
  return {
    server,
    template: {
      ...template,
      variables: vars.map((v) => ({
        envName: v.envName,
        name: v.name,
        description: v.description,
        defaultValue: v.defaultValue,
        userViewable: v.userViewable,
        userEditable: v.userEditable,
        rules: v.rules,
        sortOrder: v.sortOrder,
      })),
    },
    allocations: allocs,
    values,
  };
}

export function primaryAllocation(ctx: Pick<ServerRuntimeContext, "allocations">): AllocationRow {
  const p = ctx.allocations.find((a) => a.isPrimary);
  if (!p) throw new JobError("NO_ALLOCATION", "the server has no primary allocation");
  return p;
}

export function isMinecraftTemplate(kind: string): boolean {
  return kind === "minecraft" || kind === "velocity";
}

/** Port bindings: every allocation, TCP and UDP, container port = host port (≤ 8 allocations). */
export function portBindings(ctx: ServerRuntimeContext): PortBinding[] {
  const out: PortBinding[] = [];
  const ordered = [...ctx.allocations].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.port - b.port);
  for (const a of ordered) {
    for (const protocol of ["tcp", "udp"] as const) {
      if (out.length >= MAX_PORT_BINDINGS) return out;
      out.push({ containerPort: a.port, hostPort: a.port, hostIp: a.ip, protocol });
    }
  }
  return out;
}

export interface MinecraftProvisionOptions {
  currentFiles?: { "server.properties"?: string | null; "velocity.toml"?: string | null };
  acceptedBy?: string | null;
  /**
   * Velocity has not written its default velocity.toml yet: it binds its default port, so the
   * primary allocation is published to that container port until `bind` has been set.
   */
  velocityBindPending?: boolean;
}

/**
 * Built-in templates: everything comes from `@blockforge/minecraft` (`buildMinecraftProvisioning`):
 * downloads, installer payload, WorkloadSpec, server.properties / eula.txt / velocity.toml edits and
 * game-rule commands. The EULA acceptance was recorded when the server was created.
 */
export function minecraftProvisioning(ctx: ServerRuntimeContext, opts: MinecraftProvisionOptions = {}): MinecraftProvisioning {
  const s = ctx.server;
  if (!s.artifactPlan) throw new JobError("NO_PLAN", "the server has no resolved artifact plan");
  const plan = s.artifactPlan;
  const primary = primaryAllocation(ctx);
  const additional = ctx.allocations.filter((a) => !a.isPrimary).slice(0, 7);
  const prov = buildMinecraftProvisioning({
    serverId: s.id,
    artifact: plan as ResolvedArtifact,
    memoryLimitBytes: s.memoryLimitBytes,
    heapMaxBytes: s.heapMaxBytes,
    cpuLimitMillicores: s.cpuLimitMillicores,
    jvmPreset: (s.jvmPreset ?? "default") as JvmPreset,
    jvmArgs: s.jvmArgs,
    javaMajor: s.javaMajor,
    primary: { ip: primary.ip, port: primary.port },
    additional: additional.map((a) => ({ ip: a.ip, port: a.port })),
    timezone: s.timezone,
    restartPolicy: s.restartPolicy,
    gameplay: s.gameplay ?? {},
    acceptEula: true,
    ...(opts.acceptedBy ? { acceptedBy: opts.acceptedBy } : {}),
    ...(opts.currentFiles ? { currentFiles: opts.currentFiles } : {}),
    launchJar: plan.launch.kind === "jar-candidates" ? (plan.launch.candidates[0] ?? null) : null,
    labels: { "blockforge.server": s.id },
  });
  if (opts.velocityBindPending && s.software === "velocity") {
    prov.workload.ports = prov.workload.ports.map((p) => (p.hostPort === primary.port && p.hostIp === primary.ip ? { ...p, containerPort: VELOCITY_DEFAULT_PORT } : p));
  }
  return prov;
}

/** Launch command for built-in templates (validated by `@blockforge/minecraft`); used for create-time validation. */
export function minecraftLaunch(server: ServerRow, plan: ArtifactPlan): LaunchSpec {
  return buildLaunchSpec({
    software: server.software as ServerSoftware,
    artifact: plan,
    javaMajor: server.javaMajor,
    memoryLimitBytes: server.memoryLimitBytes,
    heapMaxBytes: server.heapMaxBytes,
    jvmPreset: (server.jvmPreset ?? "default") as JvmPreset,
    extraJvmArgs: server.jvmArgs,
    launchJar: plan.launch.kind === "jar-candidates" ? (plan.launch.candidates[0] ?? null) : null,
    timezone: server.timezone,
  });
}

export function eggEnvironment(ctx: ServerRuntimeContext): Record<string, string> {
  const primary = primaryAllocation(ctx);
  return buildEggEnvironment({
    template: { startup: ctx.template.startup, variables: ctx.template.variables },
    values: ctx.values,
    memoryLimitBytes: ctx.server.memoryLimitBytes,
    primary: { ip: primary.ip, port: primary.port },
    serverId: ctx.server.id,
    location: ctx.server.location,
    allocationLimit: ctx.server.allocationLimit,
    timezone: ctx.server.timezone,
  });
}

export type WorkloadSpecInput = CommandPayload<"workload.ensure">;

export function buildWorkloadSpec(ctx: ServerRuntimeContext, opts: MinecraftProvisionOptions = {}): WorkloadSpecInput {
  if (isMinecraftTemplate(ctx.template.kind)) return minecraftProvisioning(ctx, opts).workload;
  const s = ctx.server;
  // The agent gates SLP status and port discovery on `kind` (the game, not the runtime), and the JVM
  // probe works through any yolk entrypoint (JAVA_TOOL_OPTIONS).
  const game = minecraftGame(ctx);
  return {
    workloadId: s.id,
    kind: game === "java" ? "minecraft" : game === "proxy" ? "velocity" : "generic",
    image: s.dockerImage,
    entrypoint: "image",
    command: [],
    env: eggEnvironment(ctx),
    dataMountPath: ctx.template.runtime.dataMountPath,
    readOnlyRootfs: ctx.template.runtime.readOnlyRootfs,
    memoryLimitBytes: s.memoryLimitBytes,
    cpuLimitMillicores: s.cpuLimitMillicores,
    pidsLimit: 4096,
    ports: portBindings(ctx),
    networks: [],
    stop: ctx.template.stop,
    stopTimeoutMs: 60_000,
    restartPolicy: s.restartPolicy,
    jvmProbe: game !== null,
    labels: { "blockforge.server": s.id, "blockforge.template": ctx.template.key },
  };
}

/** `eula.txt` as written for eggs with the `eula` feature (acceptance recorded at creation). */
export function eggEulaFile(acceptedAt: Date, acceptedBy: string): string {
  return `#accepted via BlockForge ${acceptedAt.toISOString()} by ${acceptedBy.replace(/[\r\n]/g, " ")}\neula=true\n`;
}

/**
 * Writes eula.txt for an egg server whose template has the `eula` feature and whose EULA was accepted
 * at creation. Returns false when not applicable.
 */
export async function writeEggEula(gateway: AgentGateway, ctx: ServerRuntimeContext, opts: { jobId?: string | null; signal?: AbortSignal }): Promise<boolean> {
  const s = ctx.server;
  if (isMinecraftTemplate(ctx.template.kind) || !ctx.template.features.includes("eula") || !s.eulaAcceptedAt || !s.eulaAcceptedBy) return false;
  await gateway.send(
    s.nodeId,
    "fs.write",
    { workloadId: s.id, path: "eula.txt", content: eggEulaFile(s.eulaAcceptedAt, s.eulaAcceptedBy), encoding: "utf8", createParents: false },
    { timeoutMs: 30_000, ...opts },
  );
  return true;
}

/** Reads a workload file; null when it does not exist. */
export async function readFileIfExists(
  gateway: AgentGateway,
  nodeId: string,
  serverId: string,
  path: string,
  opts: { jobId?: string | null; signal?: AbortSignal },
): Promise<{ content: string; sha256: string } | null> {
  try {
    const r = await gateway.send(nodeId, "fs.read", { workloadId: serverId, path, maxBytes: 5 * 1024 * 1024 }, { timeoutMs: 30_000, ...opts });
    if (r.encoding !== "utf8") throw new JobError("NOT_TEXT", `${path} is not a text file`);
    return { content: r.content, sha256: r.sha256 };
  } catch (err) {
    if (err instanceof AgentCommandError && err.code === "NOT_FOUND") return null;
    throw err;
  }
}

export interface ConfigApplyResult {
  written: string[];
  warnings: string[];
}

/**
 * Applies the egg template's config-file rules (before every start, like Wings). Files are read,
 * edited by `@blockforge/eggs` and written back with `ifMatchSha256`, so a concurrent edit is never
 * overwritten silently.
 */
export async function applyEggConfigFiles(
  gateway: AgentGateway,
  ctx: ServerRuntimeContext,
  opts: { jobId?: string | null; signal?: AbortSignal; dockerInterface?: string | null },
): Promise<ConfigApplyResult> {
  const rules: ConfigFileRule[] = ctx.template.configFiles;
  if (!rules.length) return { written: [], warnings: [] };
  const primary = primaryAllocation(ctx);
  const env = eggEnvironment(ctx);
  const pctx: PlaceholderContext = {
    serverId: ctx.server.id,
    serverName: ctx.server.name,
    primary: { ip: primary.ip, port: primary.port },
    memoryMiB: memoryMiB(ctx.server.memoryLimitBytes),
    env,
    dockerInterface: opts.dockerInterface ?? null,
  };
  const out: ConfigApplyResult = { written: [], warnings: [] };
  for (const rule of rules) {
    const current = await readFileIfExists(gateway, ctx.server.nodeId, ctx.server.id, rule.path, opts);
    const r = applyConfigFileRule(rule, current?.content ?? null, pctx);
    out.warnings.push(...r.warnings.map((w) => `${rule.path}: ${w}`));
    if (!r.changed) continue;
    await gateway.send(
      ctx.server.nodeId,
      "fs.write",
      { workloadId: ctx.server.id, path: rule.path, content: r.content, encoding: "utf8", ifMatchSha256: current ? current.sha256 : null, createParents: true },
      { timeoutMs: 30_000, ...opts },
    );
    out.written.push(rule.path);
  }
  return out;
}

/**
 * Writes the managed Minecraft files (server.properties keys, eula.txt; Velocity `bind`) computed by
 * `buildMinecraftProvisioning`, each with `ifMatchSha256` against what was read. Returns the
 * game-rule commands to run once the server is ready and whether Velocity's bind is still pending.
 */
export async function writeMinecraftFiles(
  gateway: AgentGateway,
  ctx: ServerRuntimeContext,
  opts: { jobId?: string | null; signal?: AbortSignal; acceptedBy: string | null; includeEula: boolean },
): Promise<{ gameRules: string[]; warnings: string[]; written: string[]; velocityBindPending: boolean }> {
  const s = ctx.server;
  const isProxy = s.software === "velocity";
  const name = isProxy ? "velocity.toml" : "server.properties";
  const current = await readFileIfExists(gateway, s.nodeId, s.id, name, opts);
  const prov = minecraftProvisioning(ctx, { currentFiles: { [name]: current?.content ?? null }, acceptedBy: opts.acceptedBy });
  const written: string[] = [];
  for (const f of prov.files) {
    if (f.path === "eula.txt" && !opts.includeEula) continue;
    const ifMatch = f.path === name ? (current ? current.sha256 : null) : undefined;
    await gateway.send(
      s.nodeId,
      "fs.write",
      { workloadId: s.id, path: f.path, content: f.content, encoding: "utf8", ...(ifMatch !== undefined ? { ifMatchSha256: ifMatch } : {}), createParents: false },
      { timeoutMs: 30_000, ...opts },
    );
    written.push(f.path);
  }
  return { gameRules: prov.gamerules, warnings: prov.warnings, written, velocityBindPending: isProxy && current === null };
}

export interface ReadinessOptions {
  /** Console lines with ts before this are ignored (output of a previous run). */
  since: number;
  timeoutMs: number;
  signal: AbortSignal;
  /** How long to wait for an SLP sample after the log said "Done" (Minecraft only). */
  slpWaitMs?: number;
}

/**
 * Waits for a started workload to become ready: built-in templates by the Minecraft readiness log
 * line (`Done (…)!`) plus a Server List Ping sample from the agent; eggs by their `startupDone`
 * patterns (immediately when the egg defines none). Fails fast when the workload exits.
 */
/** Minecraft-family game of a server: built-in templates by kind, eggs by the template's `game`. */
export function minecraftGame(ctx: ServerRuntimeContext): "java" | "proxy" | null {
  if (ctx.template.kind === "minecraft") return "java";
  if (ctx.template.kind === "velocity") return "proxy";
  if (ctx.template.game === "minecraft-java") return "java";
  if (ctx.template.game === "minecraft-proxy") return "proxy";
  return null;
}

/** Whether a Server List Ping answer is expected once the server is ready (Java game servers). */
export function slpExpected(ctx: ServerRuntimeContext): boolean {
  return minecraftGame(ctx) === "java" && ctx.server.software !== "velocity";
}

export interface ExitStatus {
  exitCode: number | null;
  oomKilled: boolean;
}

/** A workload exit during start-up, with the reason when the console shows a known blocker. */
export class StartupExitError extends JobError {
  constructor(
    code: string,
    message: string,
    readonly exit: ExitStatus,
  ) {
    super(code, message);
    this.name = "StartupExitError";
  }
}

/** Job error codes that mean "the server process exited during start-up" (→ `crashed`). */
export const STARTUP_EXIT_CODES: ReadonlySet<string> = new Set(["CRASHED", "OOM_KILLED", "EULA_NOT_ACCEPTED", "PORT_BIND_FAILED", "JAVA_VERSION_MISMATCH"]);

/**
 * Explains an exit during start-up. Minecraft servers often exit cleanly (code 0) on a blocker the
 * log parsers recognise (EULA not accepted, port bind failure, Java too old); console lines are only
 * classified, never echoed into the message.
 */
export function diagnoseStartupExit(ctx: ServerRuntimeContext, st: WorkloadStatus, lines: readonly ConsoleLine[], since: number): StartupExitError {
  const exit: ExitStatus = { exitCode: st.exitCode ?? null, oomKilled: Boolean(st.oomKilled) };
  const code = st.exitCode !== undefined ? ` (exit code ${st.exitCode})` : "";
  if (exit.oomKilled) {
    return new StartupExitError("OOM_KILLED", `the server was killed by the out-of-memory killer during start-up (memory limit ${memoryMiB(ctx.server.memoryLimitBytes)} MiB)`, exit);
  }
  if (minecraftGame(ctx)) {
    for (const l of lines) {
      if (l.ts < since || l.stream === "system") continue;
      for (const e of detectLogEvents(l.line)) {
        if (e.type === "eula_required") {
          return new StartupExitError("EULA_NOT_ACCEPTED", `the server stopped because the Minecraft EULA has not been accepted in eula.txt${code}`, exit);
        }
        if (e.type === "port_bind_failed") {
          const p = primaryAllocationOrNull(ctx);
          return new StartupExitError(
            "PORT_BIND_FAILED",
            `the server could not bind its port${p ? ` ${p.port}` : ""}: it is in use by another process or the server's configuration does not match its allocation${code}`,
            exit,
          );
        }
        if (e.type === "java_version_mismatch") {
          const have = e.supportedJava !== null ? `Java ${e.supportedJava}` : "an older Java";
          return new StartupExitError("JAVA_VERSION_MISMATCH", `the server needs Java ${e.requiredJava} or newer but the image provides ${have}; choose a newer Java image${code}`, exit);
        }
      }
    }
  }
  return new StartupExitError("CRASHED", `the server exited during start-up${code}`, exit);
}

function primaryAllocationOrNull(ctx: ServerRuntimeContext): AllocationRow | null {
  try {
    return primaryAllocation(ctx);
  } catch {
    return null;
  }
}

/** Grace period after an exit for the last console lines to arrive before the exit is diagnosed. */
const EXIT_DIAGNOSIS_GRACE_MS = 750;

/**
 * Waits for a started workload to become ready: Minecraft servers (built-in or eggs whose game is
 * Minecraft) by the Minecraft readiness log line (eggs also by their done strings), other eggs by
 * their done strings; then, for Java game servers, for a Server List Ping sample. An exit fails with
 * a {@link StartupExitError}.
 */
export async function waitForReady(
  deps: { gateway: AgentGateway; latest: LatestCache; consoleTail: (serverId: string) => ConsoleLine[] },
  ctx: ServerRuntimeContext,
  opts: ReadinessOptions,
): Promise<{ slp: boolean }> {
  const serverId = ctx.server.id;
  const game = minecraftGame(ctx);
  const builtin = isMinecraftTemplate(ctx.template.kind);
  const done = builtin || ctx.template.startupDone.length === 0 ? null : createDoneMatcher(ctx.template.startupDone);
  const matcher = (line: string) => (game !== null && detectReadiness(line) !== null) || (done !== null && done(line));
  if (game === null && done === null) return { slp: false };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let exiting = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      deps.gateway.off("consoleLines", onLines);
      deps.gateway.off("workloadState", onState);
      opts.signal.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const check = (lines: readonly ConsoleLine[]) => {
      if (!exiting && lines.some((l) => l.ts >= opts.since && l.stream !== "system" && matcher(l.line))) finish();
    };
    const onLines = (id: string, lines: ConsoleLine[]) => {
      if (id === serverId) check(lines);
    };
    const onState = (_nodeId: string, st: WorkloadStatus) => {
      if (st.workloadId !== serverId || exiting) return;
      if (st.state === "exited" || st.state === "dead" || st.state === "missing") {
        exiting = true;
        clearTimeout(timer);
        grace = setTimeout(() => finish(diagnoseStartupExit(ctx, st, deps.consoleTail(serverId), opts.since)), EXIT_DIAGNOSIS_GRACE_MS);
        grace.unref();
      }
    };
    const onAbort = () => finish(opts.signal.reason instanceof Error ? opts.signal.reason : new JobError("CANCELLED", "cancelled"));
    const timer = setTimeout(() => finish(new JobError("READY_TIMEOUT", `the server did not report ready within ${Math.round(opts.timeoutMs / 1000)} s`, true)), opts.timeoutMs);
    timer.unref();
    deps.gateway.on("consoleLines", onLines);
    deps.gateway.on("workloadState", onState);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    check(deps.consoleTail(serverId));
    // An exit reported before the listeners were attached (between the start and ready steps).
    void deps.gateway
      .send(ctx.server.nodeId, "workload.status", { workloadId: serverId }, { timeoutMs: 15_000, signal: opts.signal })
      .then((r) => {
        const st = r.workloads.find((w) => w.workloadId === serverId);
        if (st) onState(ctx.server.nodeId, st);
      })
      .catch(() => undefined);
  });
  if (!slpExpected(ctx)) return { slp: false };
  const deadline = Date.now() + (opts.slpWaitMs ?? 30_000);
  while (Date.now() < deadline) {
    if (opts.signal.aborted) break;
    if (deps.latest.getWorkload(serverId)?.minecraft) return { slp: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { slp: false };
}
