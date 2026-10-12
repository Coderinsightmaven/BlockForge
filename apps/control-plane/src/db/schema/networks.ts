import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";
import { enumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";
import { secrets } from "./secrets.js";
import { servers } from "./servers.js";

export const FORWARDING_MODES = ["modern", "legacy", "none", "bungeeguard"] as const;
export const NETWORK_MEMBER_ROLES = ["proxy", "lobby", "survival", "creative", "minigame", "limbo", "event", "other"] as const;
export const NETWORK_REVISION_STATUSES = ["draft", "validated", "applied", "failed", "rolled_back"] as const;

export const networks = pgTable(
  "networks",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique("networks_slug_unique"),
    description: text("description").notNull().default(""),
    forwardingMode: text("forwarding_mode").notNull(),
    forwardingSecretId: uuid("forwarding_secret_id").references(() => secrets.id, { onDelete: "restrict" }),
    maintenance: boolean("maintenance").notNull().default(false),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [enumCheck("networks_forwarding_mode_check", t.forwardingMode, FORWARDING_MODES)],
);

/** Ordered default/fallback (`try`) list. */
export const networkTryServers = pgTable(
  "network_try_servers",
  {
    networkId: uuid("network_id")
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ name: "network_try_servers_pk", columns: [t.networkId, t.serverId] }),
    unique("network_try_servers_position_unique").on(t.networkId, t.position),
  ],
);

export const networkMembers = pgTable(
  "network_members",
  {
    networkId: uuid("network_id")
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    backendName: text("backend_name").notNull(),
    priority: integer("priority").notNull().default(0),
    internalAddress: text("internal_address"),
    internalPort: integer("internal_port"),
  },
  (t) => [
    primaryKey({ name: "network_members_pk", columns: [t.networkId, t.serverId] }),
    unique("network_members_backend_unique").on(t.networkId, t.backendName),
    // A server belongs to at most one network in v1 (RBAC scope resolution relies on this).
    unique("network_members_server_unique").on(t.serverId),
    enumCheck("network_members_role_check", t.role, NETWORK_MEMBER_ROLES),
  ],
);

export const forcedHosts = pgTable(
  "forced_hosts",
  {
    id: uuid("id").primaryKey(),
    networkId: uuid("network_id")
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("forced_hosts_unique").on(t.networkId, t.hostname),
    check("forced_hosts_lowercase_check", sql`${t.hostname} = lower(${t.hostname})`),
  ],
);

export const forcedHostTargets = pgTable(
  "forced_host_targets",
  {
    forcedHostId: uuid("forced_host_id")
      .notNull()
      .references(() => forcedHosts.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ name: "forced_host_targets_pk", columns: [t.forcedHostId, t.serverId] }),
    unique("forced_host_targets_position_unique").on(t.forcedHostId, t.position),
  ],
);

export const networkConfigRevisions = pgTable(
  "network_config_revisions",
  {
    id: uuid("id").primaryKey(),
    networkId: uuid("network_id")
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    plan: jsonb("plan").notNull(),
    rendered: jsonb("rendered"),
    status: text("status").notNull().default("draft"),
    validation: jsonb("validation"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    appliedAt: tsz("applied_at"),
  },
  (t) => [
    unique("network_config_revisions_unique").on(t.networkId, t.revision),
    enumCheck("network_config_revisions_status_check", t.status, NETWORK_REVISION_STATUSES),
    index("network_config_revisions_network_idx").on(t.networkId),
  ],
);
