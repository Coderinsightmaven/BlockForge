CREATE TABLE "database_hosts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 3306 NOT NULL,
	"public_host" text,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"node_id" uuid,
	"max_databases" integer,
	"tls_mode" text DEFAULT 'preferred' NOT NULL,
	"tls_ca_certificate" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_hosts_name_unique" UNIQUE("name"),
	CONSTRAINT "database_hosts_tls_mode_check" CHECK ("database_hosts"."tls_mode" IN ('disabled', 'preferred', 'required', 'verify_ca')),
	CONSTRAINT "database_hosts_tls_ca_check" CHECK (("database_hosts"."tls_mode" = 'verify_ca') = ("database_hosts"."tls_ca_certificate" IS NOT NULL)),
	CONSTRAINT "database_hosts_port_check" CHECK ("database_hosts"."port" BETWEEN 1 AND 65535),
	CONSTRAINT "database_hosts_max_databases_check" CHECK ("database_hosts"."max_databases" IS NULL OR "database_hosts"."max_databases" >= 0)
);
--> statement-breakpoint
CREATE TABLE "server_databases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"database_name" text NOT NULL,
	"username" text NOT NULL,
	"remote" text DEFAULT '%' NOT NULL,
	"password_enc" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"password_rotated_at" timestamp with time zone,
	"operation" text,
	"operation_token" uuid,
	"operation_started_at" timestamp with time zone,
	"state" text DEFAULT 'ready' NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_databases_host_database_unique" UNIQUE("host_id","database_name"),
	CONSTRAINT "server_databases_host_username_unique" UNIQUE("host_id","username"),
	CONSTRAINT "server_databases_state_check" CHECK ("server_databases"."state" IN ('reserved', 'provisioning', 'ready', 'password_unknown', 'cleanup_pending')),
	CONSTRAINT "server_databases_operation_check" CHECK ("server_databases"."operation" IS NULL OR "server_databases"."operation" IN ('creating', 'rotating', 'deleting')),
	CONSTRAINT "server_databases_operation_claim_check" CHECK (("server_databases"."operation" IS NULL) = ("server_databases"."operation_token" IS NULL) AND ("server_databases"."operation" IS NULL) = ("server_databases"."operation_started_at" IS NULL)),
	CONSTRAINT "server_databases_database_name_check" CHECK ("server_databases"."database_name" ~ '^s[0-9a-f]{8}_[a-z0-9_]{1,48}$'),
	CONSTRAINT "server_databases_username_check" CHECK ("server_databases"."username" ~ '^u[0-9a-f]{8}_[a-z0-9]{10}$'),
	CONSTRAINT "server_databases_remote_check" CHECK ("server_databases"."remote" ~ '^[a-z0-9.%:/-]{1,60}$')
);
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_check";--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "database_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "database_hosts" ADD CONSTRAINT "database_hosts_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_databases" ADD CONSTRAINT "server_databases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_databases" ADD CONSTRAINT "server_databases_host_id_database_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."database_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_databases" ADD CONSTRAINT "server_databases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_hosts_node_idx" ON "database_hosts" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "server_databases_cleanup_idx" ON "server_databases" USING btree ("state_changed_at") WHERE "server_databases"."state" = 'cleanup_pending' OR "server_databases"."operation" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "server_databases_server_idx" ON "server_databases" USING btree ("server_id");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_check" CHECK ("role_permissions"."permission" IN ('settings.manage', 'users.view', 'users.manage', 'roles.manage', 'audit.view', 'secrets.read', 'secrets.manage', 'monitoring.view', 'jobs.view', 'alerts.view', 'alerts.manage', 'nodes.view', 'nodes.manage', 'nodes.enroll', 'allocations.manage', 'database_hosts.manage', 'templates.view', 'templates.manage', 'networks.view', 'networks.create', 'networks.manage', 'servers.view', 'servers.create', 'servers.admin', 'servers.delete', 'servers.control', 'servers.console.view', 'servers.console.send', 'servers.config.view', 'servers.config.edit', 'servers.files.read', 'servers.files.write', 'servers.extensions.view', 'servers.extensions.manage', 'servers.players.view', 'servers.players.manage', 'servers.backups.view', 'servers.backups.create', 'servers.backups.restore', 'servers.backups.delete', 'servers.backups.download', 'servers.databases.view', 'servers.databases.create', 'servers.databases.update', 'servers.databases.delete', 'servers.databases.view_password', 'servers.files.sftp', 'servers.startup.view', 'servers.startup.edit', 'servers.startup.image', 'servers.allocations.view', 'servers.allocations.manage', 'servers.subusers.view', 'servers.subusers.manage', 'servers.settings.edit', 'servers.reinstall', 'servers.activity.view', 'schedules.view', 'schedules.manage'));--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_database_limit_check" CHECK ("servers"."database_limit" >= 0);