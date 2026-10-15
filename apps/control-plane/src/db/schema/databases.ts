import { DatabaseTlsMode } from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { enumCheck, tsz } from "./_helpers.js";
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
  },
  (t) => [
    unique("server_databases_host_database_unique").on(t.hostId, t.databaseName),
    unique("server_databases_host_username_unique").on(t.hostId, t.username),
    index("server_databases_server_idx").on(t.serverId),
    // Defence in depth: the names that reach SQL identifiers are also constrained by the database.
    check("server_databases_database_name_check", sql`${t.databaseName} ~ '^s[0-9a-f]{8}_[a-z0-9_]{1,48}$'`),
    check("server_databases_username_check", sql`${t.username} ~ '^u[0-9a-f]{8}_[a-z0-9]{10}$'`),
    check("server_databases_remote_check", sql`${t.remote} ~ '^[a-z0-9.%:/-]{1,60}$'`),
  ],
);
