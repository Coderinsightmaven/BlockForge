import { NodeConnection, NodeStatus, ScopeType, type NodeFacts } from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { enumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";

export const CREDENTIAL_STATUSES = ["pending", "active", "rotated", "revoked"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull().unique("nodes_name_unique"),
    slug: text("slug").notNull().unique("nodes_slug_unique"),
    status: text("status").notNull(),
    /** Derived by the agent gateway's state machine; cached here for queries and restarts. */
    connection: text("connection").notNull().default("offline"),
    location: text("location"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    publicAddress: text("public_address"),
    privateAddress: text("private_address"),
    schedulingEnabled: boolean("scheduling_enabled").notNull().default(true),
    /** Admin overrides; null = derived from facts (nodes/capacity.ts). */
    cpuAllocatableMillicores: integer("cpu_allocatable_millicores"),
    memoryAllocatableBytes: bigint("memory_allocatable_bytes", { mode: "number" }),
    storageAllocatableBytes: bigint("storage_allocatable_bytes", { mode: "number" }),
    overcommitMemoryRatio: numeric("overcommit_memory_ratio", { precision: 4, scale: 2 }).notNull().default("1.00"),
    facts: jsonb("facts").$type<NodeFacts>(),
    agentVersion: text("agent_version"),
    lastHeartbeatAt: tsz("last_heartbeat_at"),
    lastConnectedAt: tsz("last_connected_at"),
    lastDisconnectedAt: tsz("last_disconnected_at"),
    /** True when the last session ended with a clean close (offline after NODE_OFFLINE_AFTER_MS). */
    lastDisconnectClean: boolean("last_disconnect_clean").notNull().default(false),
    lastSeenIp: text("last_seen_ip"),
    clockSkewMs: integer("clock_skew_ms"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    enumCheck("nodes_status_check", t.status, NodeStatus.options),
    enumCheck("nodes_connection_check", t.connection, NodeConnection.options),
    check("nodes_overcommit_check", sql`${t.overcommitMemoryRatio} >= 1 AND ${t.overcommitMemoryRatio} <= 4`),
  ],
);

export const nodeCredentials = pgTable(
  "node_credentials",
  {
    id: uuid("id").primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** Raw Ed25519 public key, base64url. */
    publicKey: text("public_key").notNull(),
    status: text("status").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    /** Only for `pending` (staged rotation, agent-protocol.md §3.1). */
    expiresAt: tsz("expires_at"),
    activatedAt: tsz("activated_at"),
    revokedAt: tsz("revoked_at"),
  },
  (t) => [
    enumCheck("node_credentials_status_check", t.status, CREDENTIAL_STATUSES),
    uniqueIndex("node_credentials_one_active").on(t.nodeId).where(sql`${t.status} = 'active'`),
    uniqueIndex("node_credentials_one_pending").on(t.nodeId).where(sql`${t.status} = 'pending'`),
    index("node_credentials_node_idx").on(t.nodeId),
    check("node_credentials_pending_expiry", sql`${t.status} <> 'pending' OR ${t.expiresAt} IS NOT NULL`),
  ],
);

/** Durable, replica-shared replay cache for agent tokens. */
export const agentAuthJti = pgTable(
  "agent_auth_jti",
  {
    jti: text("jti").primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    expiresAt: tsz("expires_at").notNull(),
  },
  (t) => [index("agent_auth_jti_expires_idx").on(t.expiresAt)],
);

export const enrollmentTokens = pgTable(
  "enrollment_tokens",
  {
    id: uuid("id").primaryKey(),
    tokenId: text("token_id").notNull().unique("enrollment_tokens_token_id_unique"),
    /** sha256(hex) of the secret part; the secret itself is shown once at creation. */
    secretHash: text("secret_hash").notNull(),
    label: text("label").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    expiresAt: tsz("expires_at").notNull(),
    usedAt: tsz("used_at"),
    usedByNodeId: uuid("used_by_node_id").references(() => nodes.id, { onDelete: "set null" }),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    location: text("location"),
  },
  (t) => [check("enrollment_tokens_token_id_format", sql`${t.tokenId} ~ '^[0-9a-f]{16}$'`)],
);

export const maintenanceWindows = pgTable(
  "maintenance_windows",
  {
    id: uuid("id").primaryKey(),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    startsAt: tsz("starts_at").notNull(),
    endsAt: tsz("ends_at").notNull(),
    reason: text("reason").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [
    enumCheck("maintenance_windows_scope_type_check", t.scopeType, ScopeType.options),
    check("maintenance_windows_range_check", sql`${t.endsAt} > ${t.startsAt}`),
    index("maintenance_windows_scope_idx").on(t.scopeType, t.scopeId),
  ],
);
