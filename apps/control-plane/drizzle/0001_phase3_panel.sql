-- Phase 3 (panel core). Servers could not be created before this migration, so the new NOT NULL
-- ownership/template columns need no backfill; refuse to run (instead of guessing) if rows exist.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "servers") THEN
    RAISE EXCEPTION 'servers rows exist; migration 0001 requires an empty servers table';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "user_ssh_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_type" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "user_ssh_keys_fingerprint_unique" UNIQUE("user_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "template_variables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"template_id" uuid NOT NULL,
	"env_name" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"default_value" text DEFAULT '' NOT NULL,
	"user_viewable" boolean DEFAULT true NOT NULL,
	"user_editable" boolean DEFAULT false NOT NULL,
	"rules" text DEFAULT 'nullable|string' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "template_variables_env_unique" UNIQUE("template_id","env_name"),
	CONSTRAINT "template_variables_env_format" CHECK ("template_variables"."env_name" ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$')
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"kind" text NOT NULL,
	"game" text NOT NULL,
	"author" text,
	"source" text NOT NULL,
	"source_format" text,
	"docker_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"startup" text DEFAULT '' NOT NULL,
	"config_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"startup_done" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop" jsonb NOT NULL,
	"install" jsonb,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"file_denylist" text[] DEFAULT '{}'::text[] NOT NULL,
	"runtime" jsonb NOT NULL,
	"raw_import" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_key_unique" UNIQUE("key"),
	CONSTRAINT "templates_kind_check" CHECK ("templates"."kind" IN ('minecraft', 'velocity', 'egg')),
	CONSTRAINT "templates_game_check" CHECK ("templates"."game" IN ('minecraft-java', 'minecraft-proxy', 'other')),
	CONSTRAINT "templates_source_check" CHECK ("templates"."source" IN ('builtin', 'import')),
	CONSTRAINT "templates_source_format_check" CHECK ("templates"."source_format" IS NULL OR "templates"."source_format" IN ('PTDL_v1', 'PTDL_v2', 'PLCN_v1', 'PLCN_v2', 'PLCN_v3')),
	CONSTRAINT "templates_key_format" CHECK ("templates"."key" ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$')
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"ip" "inet" NOT NULL,
	"port" integer NOT NULL,
	"alias" text,
	"notes" text,
	"server_id" uuid,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocations_node_ip_port_unique" UNIQUE("node_id","ip","port"),
	CONSTRAINT "allocations_port_check" CHECK ("allocations"."port" BETWEEN 1 AND 65535)
);
--> statement-breakpoint
CREATE TABLE "server_subusers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_subusers_unique" UNIQUE("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "server_variables" (
	"server_id" uuid NOT NULL,
	"env_name" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "server_variables_pk" PRIMARY KEY("server_id","env_name")
);
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_check";--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "servers" DROP CONSTRAINT "servers_port_check";--> statement-breakpoint
ALTER TABLE "servers" DROP CONSTRAINT "servers_software_check";--> statement-breakpoint
ALTER TABLE "servers" DROP CONSTRAINT "servers_active_operation_check";--> statement-breakpoint
ALTER TABLE "servers" DROP CONSTRAINT "servers_heap_check";--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "software" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "minecraft_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "heap_max_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
-- Backfill: email local part (lowercase, invalid characters -> "-", leading separators removed,
-- padded to 3, max 28) plus "-2", "-3", ... on collision, oldest accounts first. Mirrors
-- usernameBase()/uniqueUsername() in src/users/username.ts.
DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n int;
BEGIN
  FOR r IN SELECT "id", "email" FROM "users" WHERE "username" IS NULL ORDER BY "created_at", "id" LOOP
    base := left(regexp_replace(regexp_replace(lower(split_part(r."email"::text, '@', 1)), '[^a-z0-9_-]+', '-', 'g'), '^[-_]+', ''), 28);
    IF base = '' THEN base := 'user'; END IF;
    IF length(base) < 3 THEN base := base || repeat('0', 3 - length(base)); END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "users" WHERE "username" = candidate) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;
    UPDATE "users" SET "username" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "owner_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "template_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "docker_image" text NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "allocation_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "backup_limit" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "jvm_preset" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "gameplay" jsonb;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "artifact_plan" jsonb;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "installed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_ssh_keys" ADD CONSTRAINT "user_ssh_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_variables" ADD CONSTRAINT "template_variables_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_subusers" ADD CONSTRAINT "server_subusers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_subusers" ADD CONSTRAINT "server_subusers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_subusers" ADD CONSTRAINT "server_subusers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_variables" ADD CONSTRAINT "server_variables_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_ssh_keys_user_idx" ON "user_ssh_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "template_variables_template_idx" ON "template_variables" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_one_primary" ON "allocations" USING btree ("server_id") WHERE "allocations"."is_primary" AND "allocations"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "allocations_node_idx" ON "allocations" USING btree ("node_id","server_id");--> statement-breakpoint
CREATE INDEX "allocations_server_idx" ON "allocations" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_subusers_user_idx" ON "server_subusers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "servers_owner_idx" ON "servers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "servers_template_idx" ON "servers" USING btree ("template_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_check" CHECK ("role_permissions"."permission" IN ('settings.manage', 'users.view', 'users.manage', 'roles.manage', 'audit.view', 'secrets.read', 'secrets.manage', 'monitoring.view', 'jobs.view', 'alerts.view', 'alerts.manage', 'nodes.view', 'nodes.manage', 'nodes.enroll', 'allocations.manage', 'templates.view', 'templates.manage', 'networks.view', 'networks.create', 'networks.manage', 'servers.view', 'servers.create', 'servers.admin', 'servers.delete', 'servers.control', 'servers.console.view', 'servers.console.send', 'servers.config.view', 'servers.config.edit', 'servers.files.read', 'servers.files.write', 'servers.extensions.manage', 'servers.players.view', 'servers.players.manage', 'servers.backups.view', 'servers.backups.create', 'servers.backups.restore', 'servers.backups.delete', 'servers.backups.download', 'servers.files.sftp', 'servers.startup.view', 'servers.startup.edit', 'servers.startup.image', 'servers.allocations.view', 'servers.allocations.manage', 'servers.subusers.view', 'servers.subusers.manage', 'servers.settings.edit', 'servers.reinstall', 'servers.activity.view', 'schedules.view', 'schedules.manage'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_format" CHECK ("users"."username" ~ '^[a-z0-9][a-z0-9_-]{2,31}$');--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK ("events"."type" IN ('node.enrolled', 'node.approved', 'node.revoked', 'node.connection.changed', 'server.created', 'server.provision.requested', 'server.provision.completed', 'server.provision.failed', 'server.state.changed', 'server.crashed', 'server.config.changed', 'server.installed', 'server.install.failed', 'server.suspended', 'server.unsuspended', 'server.deleted', 'network.configuration.validated', 'network.configuration.applied', 'backup.completed', 'backup.failed', 'migration.completed', 'alert.fired', 'alert.resolved', 'job.updated'));--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_jvm_preset_check" CHECK ("servers"."jvm_preset" IS NULL OR "servers"."jvm_preset" IN ('default', 'aikar', 'none'));--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_limits_check" CHECK ("servers"."allocation_limit" >= 0 AND "servers"."backup_limit" >= 0);--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_software_check" CHECK ("servers"."software" IS NULL OR "servers"."software" IN ('vanilla', 'paper', 'purpur', 'folia', 'spigot', 'fabric', 'forge', 'neoforge', 'velocity'));--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_active_operation_check" CHECK ("servers"."active_operation" IS NULL OR "servers"."active_operation" IN ('provision', 'reinstall', 'start', 'stop', 'restart', 'kill', 'update', 'backup', 'restore', 'migrate', 'delete'));--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_heap_check" CHECK ("servers"."heap_max_bytes" IS NULL OR "servers"."heap_max_bytes" < "servers"."memory_limit_bytes");--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN "port";--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN "host_ip";
