import type {
  ExtensionFileSnapshot,
  ExtensionHistoryEntry,
  ExtensionKind,
  ExtensionScanStatus,
  InstalledExtension,
  ServerSoftware,
  ServerState,
} from "@blockforge/contracts";
import { extensionDirFor } from "@blockforge/minecraft";
import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { AgentCommandError, type AgentGateway } from "../agents/gateway.js";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { BrowserTransfers } from "../files/browser-transfers.js";
import type { TransferBroker } from "../agents/transfers.js";
import type { Db, DbOrTx } from "../db/client.js";
import type { extensionHistory, installedExtensions, servers } from "../db/schema/index.js";
import { extensionScans, jobs, users } from "../db/schema/index.js";
import type { JobRunner } from "../jobs/runner.js";
import { JobError } from "../jobs/types.js";
import type { Clock } from "../lib/clock.js";
import { conflict, invalidState, unprocessable } from "../lib/errors.js";
import type { ServerEventPublisher } from "../realtime/server-events.js";
import type { ServerAccessService } from "../servers/access.js";
import type { SettingsService } from "../settings/service.js";
import type { Upstreams } from "./upstream.js";

export type ExtensionRow = typeof installedExtensions.$inferSelect;
export type HistoryRow = typeof extensionHistory.$inferSelect;
export type ScanRow = typeof extensionScans.$inferSelect;
type ServerRow = typeof servers.$inferSelect;

export const EXTENSION_JOBS = {
  scan: "server.extensions.scan",
  install: "server.extensions.install",
  update: "server.extensions.update",
  rollback: "server.extensions.rollback",
} as const;
export const EXTENSION_JOB_TYPES: readonly string[] = Object.values(EXTENSION_JOBS);

/** Keep area for removed/replaced jars and the upload staging area (data root, outside plugins/mods). */
export const KEPT_DIR = ".blockforge/extensions/kept";
export const UPLOAD_DIR = ".blockforge/extensions/uploads";
export const KEPT_RETENTION_MS = 30 * 86_400_000;
export const KEPT_PER_SERVER = 20;
export const HISTORY_RETENTION_MS = 365 * 86_400_000;
export const UPLOAD_TTL_MS = 3600_000;

export interface ExtensionDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  gateway: AgentGateway;
  audit: AuditService;
  upstreams: Upstreams;
  settings: SettingsService;
  events: ServerEventPublisher;
  jobs: JobRunner;
  access: ServerAccessService;
  browser: BrowserTransfers;
  transfers: TransferBroker;
}

/** Where a server keeps its extensions (null: vanilla / non-Minecraft / unknown software). */
export interface ExtensionTarget {
  software: ServerSoftware;
  minecraftVersion: string | null;
  installDir: "plugins" | "mods";
  kind: ExtensionKind;
}

export function targetOf(server: Pick<ServerRow, "software" | "minecraftVersion">): ExtensionTarget | null {
  const software = server.software as ServerSoftware | null;
  if (!software) return null;
  const installDir = extensionDirFor(software);
  if (!installDir) return null;
  return { software, minecraftVersion: server.minecraftVersion ?? null, installDir, kind: installDir === "plugins" ? "plugin" : "mod" };
}

export function requireTarget(server: Pick<ServerRow, "software" | "minecraftVersion">): ExtensionTarget {
  const t = targetOf(server);
  if (!t) throw unprocessable("This server's software loads no plugins or mods", { reason: "unsupported_software" });
  return t;
}

/** Plugins/mods load at start: any change needs a restart unless the server is stopped/crashed. */
export const restartRequired = (state: string) => state !== "stopped" && state !== "crashed";

/** States in which no extension change may run (the files are being replaced or the server is going away). */
const BLOCKED_STATES: readonly ServerState[] = ["provisioning", "restoring", "migrating", "deleting"];
const BLOCKED_OPERATIONS = ["provision", "reinstall", "restore", "migrate", "delete"];

export function assertExtensionsAllowed(server: Pick<ServerRow, "state" | "activeOperation">): void {
  if (BLOCKED_STATES.includes(server.state as ServerState) || (server.activeOperation && BLOCKED_OPERATIONS.includes(server.activeOperation))) {
    throw invalidState(`Extensions cannot be changed while the server is ${server.activeOperation ?? server.state}`, { state: server.state, activeOperation: server.activeOperation });
  }
}

/** Agent commands the extension features need (advertised in the agent's `hello` capabilities). */
export const EXTENSION_CAPABILITIES = ["fs.hash", "jar.readEntries"] as const;

/**
 * A connected agent that predates `fs.hash` / `jar.readEntries` gets a clear refusal instead of a
 * command timeout (a disconnected node fails later with NODE_UNAVAILABLE).
 */
export function missingCapabilities(gateway: AgentGateway, nodeId: string): string[] {
  const s = gateway.session(nodeId);
  if (!s?.ready) return [];
  return EXTENSION_CAPABILITIES.filter((c) => !s.capabilities.includes(c));
}

export function assertAgentSupportsExtensions(gateway: AgentGateway, nodeId: string): void {
  const missing = missingCapabilities(gateway, nodeId);
  if (missing.length) {
    throw invalidState("The node's agent is too old for plugin/mod management; update the agent", { reason: "agent_outdated", missingCapabilities: missing });
  }
}

export const jobRunning = () => conflict("Another extension job is running for this server", { reason: "extension_job_running" });

/** Ensures the scan/lock row exists. */
export async function ensureScanRow(db: DbOrTx, serverId: string): Promise<void> {
  await db.insert(extensionScans).values({ serverId }).onConflictDoNothing();
}

/**
 * Takes the per-server extension job lock for `jobId` (inside the enqueue transaction). A lock held
 * by a job that already ended (crash) is taken over.
 */
export async function acquireExtensionLock(db: DbOrTx, serverId: string, jobId: string): Promise<void> {
  await ensureScanRow(db, serverId);
  const [row] = await db.select().from(extensionScans).where(eq(extensionScans.serverId, serverId)).for("update");
  if (row?.activeJobId && row.activeJobId !== jobId) {
    const [j] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, row.activeJobId));
    if (j && (j.status === "queued" || j.status === "running")) throw jobRunning();
  }
  await db.update(extensionScans).set({ activeJobId: jobId }).where(eq(extensionScans.serverId, serverId));
}

/** Refuses synchronous changes while an extension job holds the lock. */
export async function assertNoExtensionJob(db: DbOrTx, serverId: string): Promise<void> {
  const [row] = await db.select({ activeJobId: extensionScans.activeJobId }).from(extensionScans).where(eq(extensionScans.serverId, serverId));
  if (!row?.activeJobId) return;
  const [j] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, row.activeJobId));
  if (j && (j.status === "queued" || j.status === "running")) throw jobRunning();
}

export async function releaseExtensionLock(db: DbOrTx, serverId: string, jobId: string): Promise<void> {
  await db.update(extensionScans).set({ activeJobId: null }).where(and(eq(extensionScans.serverId, serverId), eq(extensionScans.activeJobId, jobId)));
}

export function scanStatusOf(row: ScanRow | undefined | null): ExtensionScanStatus {
  if (!row) return { status: "never", scannedAt: null, jobId: null, error: null };
  return { status: row.status as ExtensionScanStatus["status"], scannedAt: row.scannedAt?.getTime() ?? null, jobId: row.jobId, error: row.error ? row.error.slice(0, 1024) : null };
}

/** Display name: selected metadata name, Modrinth title, or the file name (all untrusted text). */
export function displayName(row: Pick<ExtensionRow, "metadata" | "compatibility" | "modrinth" | "filename">): string {
  const i = row.compatibility?.metadataIndex;
  const m = i !== null && i !== undefined ? row.metadata[i] : row.metadata[0];
  return (m?.name || row.modrinth?.title || row.filename).slice(0, 256);
}

export function snapshotOf(row: Pick<ExtensionRow, "source" | "path" | "modrinth" | "metadata" | "compatibility" | "sha512" | "sizeBytes">): ExtensionFileSnapshot {
  const i = row.compatibility?.metadataIndex;
  const m = i !== null && i !== undefined ? row.metadata[i] : row.metadata[0];
  return {
    source: row.source as ExtensionFileSnapshot["source"],
    path: row.path,
    projectId: row.modrinth?.projectId ?? null,
    versionId: row.modrinth?.versionId ?? null,
    versionNumber: (row.modrinth?.versionNumber ?? m?.version ?? null)?.slice(0, 256) ?? null,
    sha512: row.sha512,
    sizeBytes: row.sizeBytes,
  };
}

export function toDto(row: ExtensionRow, installedByName: string | null): InstalledExtension {
  return {
    id: row.id,
    serverId: row.serverId,
    kind: row.kind as ExtensionKind,
    path: row.path,
    filename: row.filename.slice(0, 255),
    enabled: row.enabled,
    sizeBytes: row.sizeBytes,
    sha512: row.sha512,
    mtime: row.mtime.getTime(),
    source: row.source as InstalledExtension["source"],
    metadata: row.metadata,
    compatibility: row.compatibility ?? null,
    modrinth: row.modrinth ?? null,
    installedAt: row.installedAt?.getTime() ?? null,
    installedBy: row.installedBy ? { id: row.installedBy, name: (installedByName ?? "unknown").slice(0, 128) } : null,
    firstSeenAt: row.firstSeenAt.getTime(),
  };
}

export async function toDtos(db: DbOrTx, rows: readonly ExtensionRow[]): Promise<InstalledExtension[]> {
  const ids = [...new Set(rows.map((r) => r.installedBy).filter((x): x is string => !!x))];
  const names = new Map(ids.length ? (await db.select({ id: users.id, name: users.username }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
  return rows.map((r) => toDto(r, r.installedBy ? (names.get(r.installedBy) ?? null) : null));
}

export function historyActor(actor: AuditActor, opts: { scheduleId?: string | null } = {}): Pick<HistoryRow, "actorType" | "actorId" | "actorName"> {
  if (opts.scheduleId) return { actorType: "schedule", actorId: opts.scheduleId, actorName: actor.actorName?.slice(0, 128) ?? null };
  if (actor.actorType === "user") return { actorType: "user", actorId: actor.actorId, actorName: actor.actorName?.slice(0, 128) ?? null };
  if (actor.actorType === "api_token") return { actorType: "api_token", actorId: actor.userId ?? null, actorName: actor.actorName?.slice(0, 128) ?? null };
  return { actorType: "system", actorId: null, actorName: actor.actorName?.slice(0, 128) ?? null };
}

/** Rollback availability of one entry (contracts `ExtensionHistoryEntry.rollback`). */
export function rollbackOf(e: HistoryRow, newer: readonly HistoryRow[], now: number): ExtensionHistoryEntry["rollback"] {
  if (e.status === "failed") return { available: false, reason: "failed_entry" };
  if (e.action === "enable" || e.action === "disable") return { available: false, reason: "not_supported" };
  const superseded = newer.some((n) => n.status === "succeeded" && (n.path === e.path || (e.extensionId !== null && n.extensionId === e.extensionId) || n.from?.path === e.path || n.to?.path === e.path));
  if (superseded) return { available: false, reason: "superseded" };
  if (e.from && !refetchable(e.from) && (!e.keptPath || !e.keptSha512 || (e.keptUntil && e.keptUntil.getTime() <= now))) {
    return { available: false, reason: "file_unavailable" };
  }
  return { available: true, reason: null };
}

/** A snapshot that can be re-fetched from Modrinth (version id + SHA-512). */
export const refetchable = (s: ExtensionFileSnapshot) => s.source === "modrinth" && !!s.projectId && !!s.versionId && !!s.sha512;

export function historyDto(e: HistoryRow, newer: readonly HistoryRow[], now: number): ExtensionHistoryEntry {
  return {
    id: e.id,
    serverId: e.serverId,
    action: e.action as ExtensionHistoryEntry["action"],
    extensionId: e.extensionId,
    extensionName: e.extensionName.slice(0, 256),
    path: e.path,
    from: e.from ?? null,
    to: e.to ?? null,
    actor: { type: e.actorType as ExtensionHistoryEntry["actor"]["type"], id: e.actorId, name: e.actorName },
    at: e.at.getTime(),
    jobId: e.jobId,
    status: e.status as "succeeded" | "failed",
    error: e.error ? e.error.slice(0, 1024) : null,
    rollback: rollbackOf(e, newer, now),
  };
}

// --- Agent helpers ------------------------------------------------------------------------------

export type SendOpts = { jobId?: string | null; signal?: AbortSignal; userId?: string | null; timeoutMs?: number };

export function agentOpts(o: SendOpts): { jobId?: string; signal?: AbortSignal; userId?: string; timeoutMs: number } {
  return { ...(o.jobId ? { jobId: o.jobId } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.userId ? { userId: o.userId } : {}), timeoutMs: o.timeoutMs ?? 60_000 };
}

/** `fs.mkdir` that tolerates an existing directory. */
export async function ensureDir(gateway: AgentGateway, nodeId: string, serverId: string, path: string, o: SendOpts = {}): Promise<void> {
  try {
    await gateway.send(nodeId, "fs.mkdir", { workloadId: serverId, path }, agentOpts(o));
  } catch (err) {
    if (err instanceof AgentCommandError && (err.code === "CONFLICT" || err.code === "ALREADY_EXISTS")) return;
    throw err;
  }
}

/** Agent failures inside extension jobs. */
export function jobAgentError(err: unknown, what: string): unknown {
  if (err instanceof AgentCommandError) return new JobError(err.code, `${what}: ${err.message}`, err.retryable);
  return err;
}
