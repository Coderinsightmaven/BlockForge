import {
  ExtensionHistoryAction,
  ExtensionKind,
  ExtensionSource,
  type ExtensionCompatibility,
  type ExtensionFileSnapshot,
  type ExtensionMetadataView,
  type ModrinthRef,
} from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { bigint, boolean, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { enumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";
import { jobs } from "./operations.js";
import { servers } from "./servers.js";

/** Skipped entries of the last scan (`ExtensionList.skipped`). */
export type ScanSkipped = Array<{ name: string; reason: "symlink" | "not-a-file" | "empty" | "unsafe-name" | "too-many" }>;

/**
 * One row per jar in `plugins/` or `mods/` (incl. `.jar.disabled`), data-model.md "Phase 4b". jsonb
 * columns hold untrusted text capped as in the contracts.
 */
export const installedExtensions = pgTable(
  "installed_extensions",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    path: text("path").notNull(),
    filename: text("filename").notNull(),
    enabled: boolean("enabled").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mtime: tsz("mtime").notNull(),
    sha512: text("sha512"),
    sha1: text("sha1"),
    metadata: jsonb("metadata").$type<ExtensionMetadataView[]>().notNull().default(sql`'[]'::jsonb`),
    /** Null until the jar has been read. */
    compatibility: jsonb("compatibility").$type<ExtensionCompatibility>(),
    modrinth: jsonb("modrinth").$type<ModrinthRef>(),
    modrinthProjectId: text("modrinth_project_id"),
    /** The SHA-512 a Modrinth identification was last attempted for (unknown files are not re-queried every scan). */
    identifiedSha512: text("identified_sha512"),
    installedAt: tsz("installed_at"),
    installedBy: uuid("installed_by").references(() => users.id, { onDelete: "set null" }),
    firstSeenAt: tsz("first_seen_at").notNull(),
    lastSeenAt: tsz("last_seen_at").notNull(),
  },
  (t) => [
    enumCheck("installed_extensions_kind_check", t.kind, ExtensionKind.options),
    enumCheck("installed_extensions_source_check", t.source, ExtensionSource.options),
    unique("installed_extensions_server_path_unique").on(t.serverId, t.path),
    index("installed_extensions_project_idx").on(t.serverId, t.modrinthProjectId),
  ],
);

/**
 * Scan status per server, and the per-server extension job lock (`active_job_id`: one extension job
 * at a time). Separate from `servers` so scans do not bump `servers.version`.
 */
export const extensionScans = pgTable(
  "extension_scans",
  {
    serverId: uuid("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("never"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    startedAt: tsz("started_at"),
    scannedAt: tsz("scanned_at"),
    error: text("error"),
    skipped: jsonb("skipped").$type<ScanSkipped>().notNull().default(sql`'[]'::jsonb`),
    truncated: boolean("truncated").notNull().default(false),
    /** The running extension job (install, updates, scan, rollback); null = free. */
    activeJobId: uuid("active_job_id").references(() => jobs.id, { onDelete: "set null" }),
  },
  (t) => [enumCheck("extension_scans_status_check", t.status, ["never", "running", "completed", "failed"])],
);

export const extensionHistory = pgTable(
  "extension_history",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    extensionId: uuid("extension_id").references(() => installedExtensions.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    status: text("status").notNull(),
    extensionName: text("extension_name").notNull(),
    path: text("path").notNull(),
    from: jsonb("from").$type<ExtensionFileSnapshot>(),
    to: jsonb("to").$type<ExtensionFileSnapshot>(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name"),
    at: tsz("at").notNull(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    error: text("error"),
    /** The replaced/removed jar in `.blockforge/extensions/kept/<id>.jar` (cleared when pruned). */
    keptPath: text("kept_path"),
    keptSha512: text("kept_sha512"),
    keptUntil: tsz("kept_until"),
  },
  (t) => [
    enumCheck("extension_history_action_check", t.action, ExtensionHistoryAction.options),
    enumCheck("extension_history_status_check", t.status, ["succeeded", "failed"]),
    enumCheck("extension_history_actor_type_check", t.actorType, ["user", "api_token", "schedule", "system"]),
    index("extension_history_server_idx").on(t.serverId, t.at.desc()),
  ],
);

/** Staged uploads (`.blockforge/extensions/uploads/<id>.jar.part`); unfinished ones expire after 1 h. */
export const extensionUploads = pgTable(
  "extension_uploads",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    stagingPath: text("staging_path").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull(),
    expiresAt: tsz("expires_at").notNull(),
    completedAt: tsz("completed_at"),
    /** Idempotent completion: the extension created and the warnings returned. */
    result: jsonb("result").$type<{ extensionId: string; warnings: unknown[]; compatibility: ExtensionCompatibility }>(),
  },
  (t) => [index("extension_uploads_pending_idx").on(t.expiresAt).where(sql`${t.completedAt} IS NULL`)],
);

/** Play sessions from the server's own join/leave console lines (retention 90 days). */
export const playerSessions = pgTable(
  "player_sessions",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    uuid: text("uuid"),
    joinedAt: tsz("joined_at").notNull(),
    leftAt: tsz("left_at"),
    leaveReason: text("leave_reason"),
  },
  (t) => [
    index("player_sessions_server_idx").on(t.serverId, t.joinedAt.desc()),
    index("player_sessions_name_idx").on(t.serverId, sql`lower(${t.name})`),
    index("player_sessions_open_idx").on(t.serverId).where(sql`${t.leftAt} IS NULL`),
  ],
);


