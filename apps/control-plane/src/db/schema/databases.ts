import { DatabaseTlsMode } from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { enumCheck, nullableEnumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";
import { nodes } from "./infrastructure.js";
import { servers } from "./servers.js";

/**
 * MySQL/MariaDB database hosts (Phase 5, api.md "Databases"). The admin password is encrypted with the
 * secret box (`SecretBox.encryptToString`, AAD `database-host:<id>`) and never returned by the API.
 */
export const databaseHosts = pgTable(
  "database_hosts",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull().unique("database_hosts_name_unique"),
    host: text("host").notNull(),
    port: integer("port").notNull().default(3306),
    /** Address shown to server users; null = `host`. */
    publicHost: text("public_host"),
    username: text("username").notNull(),
    passwordEnc: text("password_enc").notNull(),
    /** Servers on this node prefer the host. */
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** null = unlimited. */
    maxDatabases: integer("max_databases"),
    tlsMode: text("tls_mode").notNull().default("preferred"),
    tlsCaCertificate: text("tls_ca_certificate"),
    notes: text("notes").notNull().default(""),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    enumCheck("database_hosts_tls_mode_check", t.tlsMode, DatabaseTlsMode.options),
    // A pinned CA exactly when the host is verified against it.
    check("database_hosts_tls_ca_check", sql`(${t.tlsMode} = 'verify_ca') = (${t.tlsCaCertificate} IS NOT NULL)`),
    check("database_hosts_port_check", sql`${t.port} BETWEEN 1 AND 65535`),
    check("database_hosts_max_databases_check", sql`${t.maxDatabases} IS NULL OR ${t.maxDatabases} >= 0`),
    index("database_hosts_node_idx").on(t.nodeId),
  ],
);

/**
 * One MySQL database + account per row (`s<shortId>_<name>` / `u<shortId>_<random>`), created on the host by
 * the control plane. The password is encrypted (AAD `server-database:<id>`). Deleting a host with
 * databases is refused (FK RESTRICT); server deletion drops the databases on the host first (best effort)
 * and the rows cascade.
 */
export const serverDatabases = pgTable(
  "server_databases",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    hostId: uuid("host_id")
      .notNull()
      .references(() => databaseHosts.id, { onDelete: "restrict" }),
    databaseName: text("database_name").notNull(),
    username: text("username").notNull(),
    /** MySQL account host pattern ("connections from"). */
    remote: text("remote").notNull().default("%"),
    passwordEnc: text("password_enc").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    passwordRotatedAt: tsz("password_rotated_at"),
    /**
     * Host operation in flight on this database (creating / rotating / deleting). Claimed and released in
     * short transactions — no transaction or row lock is held while the host is contacted — so a second
     * operation on the same database gets 409 `busy`. A claim older than the stale limit (process crash) may
     * be taken over; `operation_token` makes the release conditional on still holding the claim.
     */
    operation: text("operation"),
    operationToken: uuid("operation_token"),
    operationStartedAt: tsz("operation_started_at"),
    /**
     * What is known about the host side: `reserved` (row only; the names are not yet verified free on the host),
     * `provisioning` (names verified free — whatever exists under them now is ours), `ready`,
     * `password_unknown` (a rotation's outcome could not be determined), `cleanup_pending` (drop by name and
     * remove the row; done by the maintenance sweep once a late statement can no longer land).
     */
    state: text("state").notNull().default("ready"),
    stateChangedAt: tsz("state_changed_at").notNull().defaultNow(),
  },
  (t) => [
    enumCheck("server_databases_state_check", t.state, ["reserved", "provisioning", "ready", "password_unknown", "cleanup_pending"]),
    index("server_databases_cleanup_idx").on(t.stateChangedAt).where(sql`${t.state} = 'cleanup_pending' OR ${t.operation} IS NOT NULL`),
    nullableEnumCheck("server_databases_operation_check", t.operation, ["creating", "rotating", "deleting"]),
    check("server_databases_operation_claim_check", sql`(${t.operation} IS NULL) = (${t.operationToken} IS NULL) AND (${t.operation} IS NULL) = (${t.operationStartedAt} IS NULL)`),
    unique("server_databases_host_database_unique").on(t.hostId, t.databaseName),
    unique("server_databases_host_username_unique").on(t.hostId, t.username),
    index("server_databases_server_idx").on(t.serverId),
    // Defence in depth: the names that reach SQL identifiers are also constrained by the database.
    check("server_databases_database_name_check", sql`${t.databaseName} ~ '^s[0-9a-f]{8}_[a-z0-9_]{1,48}$'`),
    check("server_databases_username_check", sql`${t.username} ~ '^u[0-9a-f]{8}_[a-z0-9]{10}$'`),
    check("server_databases_remote_check", sql`${t.remote} ~ '^[a-z0-9.%:/-]{1,60}$'`),
  ],
);
