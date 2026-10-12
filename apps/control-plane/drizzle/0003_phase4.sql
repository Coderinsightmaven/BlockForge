-- Phase 4: backups, schedules + runs, personal API keys (permissions, allowed IPs, last used IP; revocation = row delete).
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"storage" text NOT NULL,
	"object_key" text,
	"consistency" text,
	"size_bytes" bigint,
	"sha256" text,
	"ignored" text[] DEFAULT '{}'::text[] NOT NULL,
	"skipped_symlinks" integer,
	"error" text,
	"created_by" uuid,
	"schedule_id" uuid,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "backups_status_check" CHECK ("backups"."status" IN ('pending', 'running', 'uploading', 'completed', 'failed')),
	CONSTRAINT "backups_storage_check" CHECK ("backups"."storage" IN ('local', 's3')),
	CONSTRAINT "backups_consistency_check" CHECK ("backups"."consistency" IS NULL OR "backups"."consistency" IN ('live', 'save-flush', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schedule_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"tasks" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "schedule_runs_trigger_check" CHECK ("schedule_runs"."trigger" IN ('cron', 'manual')),
	CONSTRAINT "schedule_runs_status_check" CHECK ("schedule_runs"."status" IN ('running', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"only_when_online" boolean DEFAULT false NOT NULL,
	"tasks" jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"running_run_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "permissions" text[];--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "allowed_ips" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_used_ip" text;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_server_idx" ON "backups" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_idx" ON "schedule_runs" USING btree ("schedule_id","started_at");--> statement-breakpoint
CREATE INDEX "schedules_server_idx" ON "schedules" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("next_run_at") WHERE "schedules"."enabled";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_prefix_unique" UNIQUE("prefix");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK ("events"."type" IN ('node.enrolled', 'node.approved', 'node.revoked', 'node.connection.changed', 'server.created', 'server.provision.requested', 'server.provision.completed', 'server.provision.failed', 'server.state.changed', 'server.crashed', 'server.config.changed', 'server.installed', 'server.install.failed', 'server.suspended', 'server.unsuspended', 'server.deleted', 'network.configuration.validated', 'network.configuration.applied', 'backup.started', 'backup.completed', 'backup.failed', 'backup.restored', 'schedule.run.completed', 'schedule.run.failed', 'migration.completed', 'alert.fired', 'alert.resolved', 'job.updated'));--> statement-breakpoint
ALTER TABLE "api_tokens" DROP COLUMN "scopes";--> statement-breakpoint
ALTER TABLE "api_tokens" DROP COLUMN "revoked_at";--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_run_status" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_last_run_status_check" CHECK ("schedules"."last_run_status" IS NULL OR "schedules"."last_run_status" IN ('succeeded', 'failed', 'skipped'));
