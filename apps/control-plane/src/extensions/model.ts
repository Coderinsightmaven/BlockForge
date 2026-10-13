import type {
  ExtensionFileSnapshot,
  ExtensionHistoryEntry,
  ExtensionKind,
  ExtensionScanStatus,
  InstalledExtension,
  ServerSoftware,
  ServerState,
} from "@blockforge/contracts";
import { extensionDirFor, extensionPeerKeys, flagDuplicateExtensions } from "@blockforge/minecraft";
import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { AgentCommandError, type AgentGateway } from "../agents/gateway.js";
import { actorUserId, type AuditActor, type AuditService } from "../audit/service.js";
import type { BrowserTransfers } from "../files/browser-transfers.js";
import type { TransferBroker } from "../agents/transfers.js";
import type { Db, DbOrTx } from "../db/client.js";
import type { extensionHistory, installedExtensions, servers } from "../db/schema/index.js";
import { extensionScans, jobs, servers as serversTable, users } from "../db/schema/index.js";
import type { JobRunner } from "../jobs/runner.js";
import { JobError } from "../jobs/types.js";
import type { Clock } from "../lib/clock.js";
import { AppError, conflict, invalidState, unprocessable } from "../lib/errors.js";
import type { ServerEventPublisher } from "../realtime/server-events.js";
import type { ServerAccessService } from "../servers/access.js";
import type { ServerStateService } from "../servers/state.js";
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
/** Rollback downloads land here first and are renamed into place without overwriting anything. */
export const FETCH_DIR = ".blockforge/extensions/fetch";

export const keptPathOf = (name: string) => `${KEPT_DIR}/${name}.jar`;

/** A normalised path strictly inside the keep area (`.blockforge/extensions/kept/<file>`), else null. */
export function keptAreaPath(path: string): string | null {
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  const norm = parts.join("/");
  const prefix = `${KEPT_DIR}/`;
  if (!norm.startsWith(prefix) || norm.length === prefix.length || norm.slice(prefix.length).includes("/")) return null;
  return norm;
}
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
  /** Server operation locks (`servers.active_operation`): file-changing extension work holds `extensions`. */
  state: ServerStateService;
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
export const EXTENSION_CAPABILITIES = ["fs.hash", "jar.readEntries", "artifact.fetch"] as const;

/**
 * A connected agent that predates `fs.hash` / `jar.readEntries` (or lacks `artifact.fetch`) gets a clear refusal instead of a
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
 * by a job that already ended (crash) is taken over. Refused while other extension work holds the
 * server's `extensions` operation lock (a synchronous change, or another job).
 */
export async function acquireExtensionLock(db: DbOrTx, serverId: string, jobId: string): Promise<void> {
  await ensureScanRow(db, serverId);
  const [row] = await db.select().from(extensionScans).where(eq(extensionScans.serverId, serverId)).for("update");
  if (row?.activeJobId && row.activeJobId !== jobId) {
    const [j] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, row.activeJobId));
    if (j && (j.status === "queued" || j.status === "running")) throw jobRunning();
  }
  const [srv] = await db.select({ op: serversTable.activeOperation, job: serversTable.activeJobId }).from(serversTable).where(eq(serversTable.id, serverId));
  if (srv?.op === "extensions" && srv.job !== jobId) {
    const [j] = srv.job ? await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, srv.job)) : [];
    if (!srv.job || (j && (j.status === "queued" || j.status === "running"))) throw jobRunning();
  }
  await db.update(extensionScans).set({ activeJobId: jobId }).where(eq(extensionScans.serverId, serverId));
}

/** Refuses synchronous changes while an extension job holds the lock (`lock`: row-locked, inside a transaction). */
export async function assertNoExtensionJob(db: DbOrTx, serverId: string, opts: { lock?: boolean } = {}): Promise<void> {
  const q = db.select({ activeJobId: extensionScans.activeJobId }).from(extensionScans).where(eq(extensionScans.serverId, serverId));
  const [row] = opts.lock ? await q.for("update") : await q;
  if (!row?.activeJobId) return;
  const [j] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, row.activeJobId));
  if (j && (j.status === "queued" || j.status === "running")) throw jobRunning();
}

/**
 * Takes the server's `extensions` operation lock (`servers.active_operation`, the lock backup, restore,
 * reinstall and delete take) inside `tx`, before anything else is written, and returns the holder token
 * (a job then `attachJob`s itself in the same transaction). Another extension change holding it is
 * reported as `extension_job_running`; any other operation as the usual 409 INVALID_STATE.
 */
export async function lockExtensions(d: Pick<ExtensionDeps, "state">, tx: DbOrTx, serverId: string): Promise<string> {
  try {
    return await d.state.lock(tx, serverId, "extensions");
  } catch (err) {
    if (err instanceof AppError && (err.details as { activeOperation?: unknown } | undefined)?.activeOperation === "extensions") throw jobRunning();
    throw err;
  }
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

export function toDto(row: ExtensionRow, installedByName: string | null, compatibility: InstalledExtension["compatibility"] = row.compatibility ?? null): InstalledExtension {
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
    compatibility,
    modrinth: row.modrinth ?? null,
    installedAt: row.installedAt?.getTime() ?? null,
    installedBy: row.installedBy ? { id: row.installedBy, name: (installedByName ?? "unknown").slice(0, 128) } : null,
    firstSeenAt: row.firstSeenAt.getTime(),
  };
}

/**
 * DTOs of `rows`. `siblings` = every row of the server (required): `DUPLICATE_ID` problems depend on
 * the other jars of the install dir, so they are added here, at read time, and never stored.
 */
export async function toDtos(db: DbOrTx, rows: readonly ExtensionRow[], siblings: readonly ExtensionRow[]): Promise<InstalledExtension[]> {
  const ids = [...new Set(rows.map((r) => r.installedBy).filter((x): x is string => !!x))];
  const names = new Map(ids.length ? (await db.select({ id: users.id, name: users.username }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
  const duplicates = flagDuplicateExtensions(siblings);
  return rows.map((r) => toDto(r, r.installedBy ? (names.get(r.installedBy) ?? null) : null, duplicates.get(r.path) ?? r.compatibility ?? null));
}

/**
 * `changed` plus every row of `current` that shares a (directory, plugin name / mod id) key with a `touched` row
 * (the changed rows before and after the change): their `DUPLICATE_ID` problems may have appeared or gone, and
 * `extensions.updated` makes clients re-read exactly the listed ids.
 */
export function withDuplicatePeers(
  changed: readonly string[],
  touched: readonly Pick<ExtensionRow, "path" | "metadata">[],
  current: readonly Pick<ExtensionRow, "id" | "path" | "metadata">[],
): string[] {
  const keys = new Set(touched.flatMap((r) => extensionPeerKeys(r)));
  const out = new Set(changed);
  if (keys.size) for (const r of current) if (extensionPeerKeys(r).some((k) => keys.has(k))) out.add(r.id);
  return [...out];
}

/**
 * History actor. The name shown to `servers.extensions.view` holders is the username (like ban
 * sources), never the session's e-mail address (the audit log's actor name for users).
 */
export async function historyActor(db: DbOrTx, actor: AuditActor, opts: { scheduleId?: string | null } = {}): Promise<Pick<HistoryRow, "actorType" | "actorId" | "actorName">> {
  const userId = actorUserId(actor);
  const [u] = userId ? await db.select({ username: users.username }).from(users).where(eq(users.id, userId)) : [];
  const username = u ? u.username.slice(0, 128) : null;
  if (opts.scheduleId) return { actorType: "schedule", actorId: opts.scheduleId, actorName: username };
  if (actor.actorType === "user") return { actorType: "user", actorId: actor.actorId, actorName: username };
  // `<key prefix> (<username>)`: no e-mail address either.
  if (actor.actorType === "api_token") return { actorType: "api_token", actorId: actor.userId ?? null, actorName: actor.actorName?.slice(0, 128) ?? username };
  return { actorType: "system", actorId: null, actorName: actor.actorName?.slice(0, 128) ?? null };
}

/** Rollback availability of one entry (contracts `ExtensionHistoryEntry.rollback`). */
export function rollbackOf(e: HistoryRow, newer: readonly HistoryRow[], now: number): ExtensionHistoryEntry["rollback"] {
  if (e.status === "failed") return { available: false, reason: "failed_entry" };
  if (e.action === "enable" || e.action === "disable") return { available: false, reason: "not_supported" };
  const superseded = newer.some((n) => n.status === "succeeded" && (n.path === e.path || (e.extensionId !== null && n.extensionId === e.extensionId) || n.from?.path === e.path || n.to?.path === e.path));
  if (superseded) return { available: false, reason: "superseded" };
  if (e.from && !refetchable(e.from) && !keptUsable(e, now)) {
    return { available: false, reason: "file_unavailable" };
  }
  return { available: true, reason: null };
}

/** The entry's kept file (the `from` state) is recorded with a digest and not expired. */
export const keptUsable = (e: Pick<HistoryRow, "keptPath" | "keptSha512" | "keptUntil">, now: number) =>
  !!e.keptPath && !!e.keptSha512 && !(e.keptUntil && e.keptUntil.getTime() <= now);

/**
 * A snapshot that can be re-fetched from Modrinth (version id + SHA-512): installed from Modrinth, or a file
 * found on disk / uploaded that a SHA-512 lookup identified (`source` is provenance only). The rollback job
 * re-downloads only a file whose SHA-512 equals the snapshot's.
 */
export const refetchable = (s: ExtensionFileSnapshot) => !!s.projectId && !!s.versionId && !!s.sha512;

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
