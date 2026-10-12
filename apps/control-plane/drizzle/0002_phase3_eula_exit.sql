ALTER TABLE "servers" ADD COLUMN "last_oom_killed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "eula_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "eula_accepted_by" text;--> statement-breakpoint
-- Backfill: servers created before acceptance was stored accepted the EULA at creation (recorded in the create audit).
UPDATE "servers" s SET "eula_accepted_at" = a."at", "eula_accepted_by" = COALESCE(u."username", 'unknown')
FROM "audit_events" a LEFT JOIN "users" u ON u."id"::text = a."actor_id"
WHERE a."action" = 'server.create' AND a."target_id" = s."id"::text AND (a."details"->>'eulaAccepted') = 'true';
