import {
  DesiredState,
  ServerKind,
  ServerOperation,
  ServerSoftware,
  ServerState,
  type ArtifactPlan,
  type GameplaySettings,
  type RestartPolicy,
} from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, inet, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { enumCheck, nullableEnumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";
import { nodes } from "./infrastructure.js";
import { jobs } from "./operations.js";
import { templates } from "./templates.js";

export const servers = pgTable(
  "servers",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique("servers_slug_unique"),
    description: text("description").notNull().default(""),
    kind: text("kind").notNull(),
    /** Owner deletion requires transferring their servers first. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "restrict" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "restrict" }),
    /** Minecraft fields: null for egg-based servers. */
    software: text("software"),
    minecraftVersion: text("minecraft_version"),
    buildId: text("build_id"),
    javaMajor: integer("java_major"),
    state: text("state").notNull(),
    desiredState: text("desired_state").notNull(),
    activeOperation: text("active_operation"),
    activeJobId: uuid("active_job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** Holder token of a synchronous (job-less) operation lock; null for job-held locks. */
    operationToken: uuid("operation_token"),
    /** When the current operation lock was taken (stale synchronous holds are released after 30 min). */
    operationStartedAt: tsz("operation_started_at"),
    memoryLimitBytes: bigint("memory_limit_bytes", { mode: "number" }).notNull(),
    heapMaxBytes: bigint("heap_max_bytes", { mode: "number" }),
    cpuLimitMillicores: integer("cpu_limit_millicores"),
    storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }),
    queryPort: integer("query_port"),
    dockerImage: text("docker_image").notNull(),
    suspended: boolean("suspended").notNull().default(false),
    /** Additional allocations (besides the primary) the server's users may assign. */
    allocationLimit: integer("allocation_limit").notNull().default(0),
    backupLimit: integer("backup_limit").notNull().default(3),
    /** Max MySQL databases (Phase 5); 0 disables databases for non-administrators. */
    databaseLimit: integer("database_limit").notNull().default(0),
    jvmPreset: text("jvm_preset"),
    /** Gameplay settings chosen at creation (re-applied by reinstall). */
    gameplay: jsonb("gameplay").$type<GameplaySettings>(),
    /** Resolved artifact plan of the installed build (launch command is rebuilt from it). */
    artifactPlan: jsonb("artifact_plan").$type<ArtifactPlan>(),
    installedAt: tsz("installed_at"),
    rconEnabled: boolean("rcon_enabled").notNull().default(false),
    jvmArgs: text("jvm_args").array().notNull().default(sql`'{}'::text[]`),
    startup: text("startup").notNull().default("auto"),
    restartPolicy: jsonb("restart_policy").$type<RestartPolicy>().notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    location: text("location"),
    lastStartedAt: tsz("last_started_at"),
    lastCrashAt: tsz("last_crash_at"),
    lastExitCode: integer("last_exit_code"),
    /** The last exit was an OOM kill (recorded with lastExitCode on every crash/exit transition). */
    lastOomKilled: boolean("last_oom_killed").notNull().default(false),
    /** Mojang EULA acceptance at creation (Minecraft templates and eggs with the `eula` feature). */
    eulaAcceptedAt: tsz("eula_accepted_at"),
    eulaAcceptedBy: text("eula_accepted_by"),
    /** `save-off` was sent and `save-on` not yet acknowledged (retried on reconnect / startup). */
    saveOnPending: boolean("save_on_pending").notNull().default(false),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    enumCheck("servers_kind_check", t.kind, ServerKind.options),
    nullableEnumCheck("servers_software_check", t.software, ServerSoftware.options),
    nullableEnumCheck("servers_jvm_preset_check", t.jvmPreset, ["default", "aikar", "none"]),
    check("servers_limits_check", sql`${t.allocationLimit} >= 0 AND ${t.backupLimit} >= 0`),
    check("servers_database_limit_check", sql`${t.databaseLimit} >= 0`),
    enumCheck("servers_state_check", t.state, ServerState.options),
    enumCheck("servers_desired_state_check", t.desiredState, DesiredState.options),
    nullableEnumCheck("servers_active_operation_check", t.activeOperation, ServerOperation.options),
    enumCheck("servers_startup_check", t.startup, ["manual", "auto"]),
    check("servers_heap_check", sql`${t.heapMaxBytes} IS NULL OR ${t.heapMaxBytes} < ${t.memoryLimitBytes}`),
    index("servers_node_idx").on(t.nodeId),
    index("servers_owner_idx").on(t.ownerId),
    index("servers_template_idx").on(t.templateId),
    index("servers_state_idx").on(t.state),
  ],
);

export const CONFIG_REVISION_SOURCES = ["generated", "user", "rollback", "observed"] as const;
export const CONFIG_REVISION_HEALTH = ["unknown", "healthy", "failed"] as const;

export const serverConfigRevisions = pgTable(
  "server_config_revisions",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    content: text("content").notNull(),
    sha256: text("sha256").notNull(),
    source: text("source").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    appliedAt: tsz("applied_at"),
    health: text("health").notNull().default("unknown"),
  },
  (t) => [
    unique("server_config_revisions_unique").on(t.serverId, t.filePath, t.sha256),
    enumCheck("server_config_revisions_source_check", t.source, CONFIG_REVISION_SOURCES),
    enumCheck("server_config_revisions_health_check", t.health, CONFIG_REVISION_HEALTH),
  ],
);

export const softwareBuilds = pgTable(
  "software_builds",
  {
    id: uuid("id").primaryKey(),
    software: text("software").notNull(),
    minecraftVersion: text("minecraft_version").notNull(),
    build: text("build").notNull(),
    channel: text("channel").notNull(),
    downloadUrl: text("download_url").notNull(),
    checksumAlgorithm: text("checksum_algorithm"),
    checksum: text("checksum"),
    javaMajor: integer("java_major"),
    releasedAt: tsz("released_at"),
    metadata: jsonb("metadata").notNull().default({}),
    fetchedAt: tsz("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    unique("software_builds_unique").on(t.software, t.minecraftVersion, t.build),
    enumCheck("software_builds_software_check", t.software, ServerSoftware.options),
    nullableEnumCheck("software_builds_checksum_algorithm_check", t.checksumAlgorithm, ["sha1", "sha256", "sha512"]),
  ],
);

export const worlds = pgTable(
  "worlds",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    dimensionDirs: text("dimension_dirs").array().notNull().default(sql`'{}'::text[]`),
    seed: text("seed"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    measuredAt: tsz("measured_at"),
  },
  (t) => [unique("worlds_server_name_unique").on(t.serverId, t.name)],
);

export const resourceReservations = pgTable(
  "resource_reservations",
  {
    id: uuid("id").primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "restrict" }),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    cpuMillicores: integer("cpu_millicores").notNull().default(0),
    memoryBytes: bigint("memory_bytes", { mode: "number" }).notNull().default(0),
    storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
    expiresAt: tsz("expires_at"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [
    enumCheck("resource_reservations_kind_check", t.kind, ["server", "hold"]),
    check("resource_reservations_server_check", sql`${t.kind} <> 'server' OR ${t.serverId} IS NOT NULL`),
    check(
      "resource_reservations_nonneg_check",
      sql`${t.cpuMillicores} >= 0 AND ${t.memoryBytes} >= 0 AND ${t.storageBytes} >= 0`,
    ),
    index("resource_reservations_node_idx").on(t.nodeId),
  ],
);

/**
 * Bindable IP:port pairs per node. A server has one primary allocation plus up to `allocation_limit`
 * additional ones. Releasing is explicit (delete job / unassign), which also clears `is_primary`.
 */
export const allocations = pgTable(
  "allocations",
  {
    id: uuid("id").primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    ip: inet("ip").notNull(),
    port: integer("port").notNull(),
    alias: text("alias"),
    notes: text("notes"),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("allocations_node_ip_port_unique").on(t.nodeId, t.ip, t.port),
    uniqueIndex("allocations_one_primary").on(t.serverId).where(sql`${t.isPrimary} AND ${t.serverId} IS NOT NULL`),
    check("allocations_port_check", sql`${t.port} BETWEEN 1 AND 65535`),
    index("allocations_node_idx").on(t.nodeId, t.serverId),
    index("allocations_server_idx").on(t.serverId),
  ],
);

/** Values of egg variables per server (template defaults are not copied). */
export const serverVariables = pgTable(
  "server_variables",
  {
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    envName: text("env_name").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ name: "server_variables_pk", columns: [t.serverId, t.envName] })],
);

/** Pterodactyl-style subusers with a granular server-scoped permission set. */
export const serverSubusers = pgTable(
  "server_subusers",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("server_subusers_unique").on(t.serverId, t.userId), index("server_subusers_user_idx").on(t.userId)],
);
