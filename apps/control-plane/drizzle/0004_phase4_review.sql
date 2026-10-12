-- Phase 4a review fixes: S3 storage references + multipart upload ids on backups, schedule run snapshots and
-- leases, durable save-on retries, shared API key rate counters.
CREATE TABLE "api_key_usage" (
	"key_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_key_usage_pk" PRIMARY KEY("key_id","window_start")
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "save_on_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "storage_ref" jsonb;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "upload_id" text;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "definition" jsonb;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_key_id_api_tokens_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- H1: tokens from before 0003 may have been revoked (`revoked_at`) or scoped (`scopes`) — both columns were
-- dropped by 0003, so such rows cannot be told apart from active all-permission keys. Personal API keys only
-- exist since 0003 (generated 2026-10-12T18:45:06.507Z); every older row and every row not in the
-- `bfk_<16 hex>` format is deleted (revoked).
DELETE FROM "api_tokens" WHERE "created_at" < '2026-10-12T18:45:06.507Z'::timestamptz OR "prefix" !~ '^bfk_[0-9a-f]{16}$';--> statement-breakpoint
-- H4: the S3 secret is versioned by id; the current settings point at it ...
UPDATE "settings" s SET "value" = s."value" || jsonb_build_object('secretId', sec."id")
FROM "secrets" sec
WHERE s."key" = 'backups.storage' AND s."value"->>'type' = 's3' AND NOT (s."value" ? 'secretId')
  AND sec."scope_type" = 'global' AND sec."scope_id" IS NULL AND sec."name" = 'backups.s3.secretAccessKey';--> statement-breakpoint
-- ... and existing S3 backups keep the location they were written to.
UPDATE "backups" b SET "storage_ref" = (s."value" - 'type')
FROM "settings" s
WHERE b."storage" = 's3' AND b."storage_ref" IS NULL AND s."key" = 'backups.storage' AND s."value"->>'type' = 's3' AND s."value" ? 'secretId';
