import { DesiredState, ServerKind, ServerOperation, ServerSoftware, ServerState, type RestartPolicy } from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { enumCheck, nullableEnumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";
import { nodes } from "./infrastructure.js";
import { jobs } from "./operations.js";

export const servers = pgTable(
  "servers",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique("servers_slug_unique"),
    kind: text("kind").notNull(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "restrict" }),
    software: text("software").notNull(),
    minecraftVersion: text("minecraft_version").notNull(),
    buildId: text("build_id"),
    javaMajor: integer("java_major"),
    state: text("state").notNull(),
    desiredState: text("desired_state").notNull(),
    activeOperation: text("active_operation"),
    activeJobId: uuid("active_job_id").references(() => jobs.id, { onDelete: "set null" }),
    memoryLimitBytes: bigint("memory_limit_bytes", { mode: "number" }).notNull(),
    heapMaxBytes: bigint("heap_max_bytes", { mode: "number" }).notNull(),
    cpuLimitMillicores: integer("cpu_limit_millicores"),
    storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }),
    port: integer("port").notNull(),
    hostIp: text("host_ip").notNull().default("0.0.0.0"),
    queryPort: integer("query_port"),
    rconEnabled: boolean("rcon_enabled").notNull().default(false),
    jvmArgs: text("jvm_args").array().notNull().default(sql`'{}'::text[]`),
    startup: text("startup").notNull().default("auto"),
    restartPolicy: jsonb("restart_policy").$type<RestartPolicy>().notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    location: text("location"),
    lastStartedAt: tsz("last_started_at"),
    lastCrashAt: tsz("last_crash_at"),
    lastExitCode: integer("last_exit_code"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    enumCheck("servers_kind_check", t.kind, ServerKind.options),
    enumCheck("servers_software_check", t.software, ServerSoftware.options),
    enumCheck("servers_state_check", t.state, ServerState.options),
    enumCheck("servers_desired_state_check", t.desiredState, DesiredState.options),
    nullableEnumCheck("servers_active_operation_check", t.activeOperation, ServerOperation.options),
    enumCheck("servers_startup_check", t.startup, ["manual", "auto"]),
    check("servers_port_check", sql`${t.port} BETWEEN 1 AND 65535`),
    check("servers_heap_check", sql`${t.heapMaxBytes} < ${t.memoryLimitBytes}`),
    index("servers_node_idx").on(t.nodeId),
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

export const installedExtensions = pgTable(
  "installed_extensions",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    projectId: text("project_id"),
    versionId: text("version_id"),
    name: text("name").notNull(),
    filename: text("filename").notNull(),
    sha256: text("sha256").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: tsz("installed_at").notNull().defaultNow(),
    installedBy: uuid("installed_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    enumCheck("installed_extensions_kind_check", t.kind, ["plugin", "mod", "datapack"]),
    enumCheck("installed_extensions_source_check", t.source, ["modrinth", "upload", "url"]),
    index("installed_extensions_server_idx").on(t.serverId),
  ],
);

export const extensionHistory = pgTable(
  "extension_history",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    fromVersion: text("from_version"),
    toVersion: text("to_version"),
    actor: uuid("actor").references(() => users.id, { onDelete: "set null" }),
    at: tsz("at").notNull().defaultNow(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  },
  (t) => [
    enumCheck("extension_history_action_check", t.action, ["install", "update", "remove", "rollback", "enable", "disable"]),
    index("extension_history_server_idx").on(t.serverId),
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
