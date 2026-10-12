-- Phase 4b (plugins & mods, players): the Phase 0 placeholder tables installed_extensions /
-- extension_history (never used) are recreated in their real shape; extension scans (+ the per-server
-- extension job lock), staged uploads and player sessions are new. role_permissions gains
-- servers.extensions.view (built-in role sync needs it).
ALTER TABLE "extension_history" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installed_extensions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "extension_history" CASCADE;--> statement-breakpoint
DROP TABLE "installed_extensions" CASCADE;--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_check";--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_check" CHECK ("role_permissions"."permission" IN ('settings.manage', 'users.view', 'users.manage', 'roles.manage', 'audit.view', 'secrets.read', 'secrets.manage', 'monitoring.view', 'jobs.view', 'alerts.view', 'alerts.manage', 'nodes.view', 'nodes.manage', 'nodes.enroll', 'allocations.manage', 'templates.view', 'templates.manage', 'networks.view', 'networks.create', 'networks.manage', 'servers.view', 'servers.create', 'servers.admin', 'servers.delete', 'servers.control', 'servers.console.view', 'servers.console.send', 'servers.config.view', 'servers.config.edit', 'servers.files.read', 'servers.files.write', 'servers.extensions.view', 'servers.extensions.manage', 'servers.players.view', 'servers.players.manage', 'servers.backups.view', 'servers.backups.create', 'servers.backups.restore', 'servers.backups.delete', 'servers.backups.download', 'servers.files.sftp', 'servers.startup.view', 'servers.startup.edit', 'servers.startup.image', 'servers.allocations.view', 'servers.allocations.manage', 'servers.subusers.view', 'servers.subusers.manage', 'servers.settings.edit', 'servers.reinstall', 'servers.activity.view', 'schedules.view', 'schedules.manage'));--> statement-breakpoint
CREATE TABLE "extension_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"extension_id" uuid,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"extension_name" text NOT NULL,
	"path" text NOT NULL,
	"from" jsonb,
	"to" jsonb,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text,
	"at" timestamp with time zone NOT NULL,
	"job_id" uuid,
	"error" text,
	"kept_path" text,
	"kept_sha512" text,
	"kept_until" timestamp with time zone,
	CONSTRAINT "extension_history_action_check" CHECK ("extension_history"."action" IN ('install', 'update', 'remove', 'rollback', 'enable', 'disable', 'upload')),
	CONSTRAINT "extension_history_status_check" CHECK ("extension_history"."status" IN ('succeeded', 'failed')),
	CONSTRAINT "extension_history_actor_type_check" CHECK ("extension_history"."actor_type" IN ('user', 'api_token', 'schedule', 'system'))
);
--> statement-breakpoint
CREATE TABLE "extension_scans" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'never' NOT NULL,
	"job_id" uuid,
	"started_at" timestamp with time zone,
	"scanned_at" timestamp with time zone,
	"error" text,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"active_job_id" uuid,
	CONSTRAINT "extension_scans_status_check" CHECK ("extension_scans"."status" IN ('never', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "extension_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"staging_path" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "installed_extensions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"path" text NOT NULL,
	"filename" text NOT NULL,
	"enabled" boolean NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mtime" timestamp with time zone NOT NULL,
	"sha512" text,
	"sha1" text,
	"metadata" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compatibility" jsonb,
	"modrinth" jsonb,
	"modrinth_project_id" text,
	"identified_sha512" text,
	"installed_at" timestamp with time zone,
	"installed_by" uuid,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "installed_extensions_server_path_unique" UNIQUE("server_id","path"),
	CONSTRAINT "installed_extensions_kind_check" CHECK ("installed_extensions"."kind" IN ('plugin', 'mod')),
	CONSTRAINT "installed_extensions_source_check" CHECK ("installed_extensions"."source" IN ('modrinth', 'upload', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "player_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"uuid" text,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"leave_reason" text
);
--> statement-breakpoint
ALTER TABLE "extension_history" ADD CONSTRAINT "extension_history_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_history" ADD CONSTRAINT "extension_history_extension_id_installed_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."installed_extensions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_history" ADD CONSTRAINT "extension_history_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_scans" ADD CONSTRAINT "extension_scans_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_scans" ADD CONSTRAINT "extension_scans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_scans" ADD CONSTRAINT "extension_scans_active_job_id_jobs_id_fk" FOREIGN KEY ("active_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_uploads" ADD CONSTRAINT "extension_uploads_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_uploads" ADD CONSTRAINT "extension_uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extensions" ADD CONSTRAINT "installed_extensions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extensions" ADD CONSTRAINT "installed_extensions_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_sessions" ADD CONSTRAINT "player_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_history_server_idx" ON "extension_history" USING btree ("server_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "extension_uploads_pending_idx" ON "extension_uploads" USING btree ("expires_at") WHERE "extension_uploads"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "installed_extensions_project_idx" ON "installed_extensions" USING btree ("server_id","modrinth_project_id");--> statement-breakpoint
CREATE INDEX "player_sessions_server_idx" ON "player_sessions" USING btree ("server_id","joined_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "player_sessions_name_idx" ON "player_sessions" USING btree ("server_id",lower("name"));--> statement-breakpoint
CREATE INDEX "player_sessions_open_idx" ON "player_sessions" USING btree ("server_id") WHERE "player_sessions"."left_at" IS NULL;
