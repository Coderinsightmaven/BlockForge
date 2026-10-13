-- Control plane Phase 4b review fixes.
-- #3: plugin/mod changes hold the server operation lock (`active_operation = 'extensions'`, no state change).
-- Round 2: synchronous holders carry a token and every lock records when it was taken (stale-hold sweep).
-- Idempotent (column adds, constraint drop+add in one statement): a dev database may have applied an earlier copy of this (unmerged) migration.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "operation_token" uuid;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "operation_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" DROP CONSTRAINT IF EXISTS "servers_active_operation_check", ADD CONSTRAINT "servers_active_operation_check" CHECK ("servers"."active_operation" IS NULL OR "servers"."active_operation" IN ('provision', 'reinstall', 'start', 'stop', 'restart', 'kill', 'update', 'backup', 'restore', 'migrate', 'delete', 'extensions'));--> statement-breakpoint
-- #7: extension history named the acting user by e-mail address (visible to every servers.extensions.view
-- holder). Rows of existing users get the username; any other e-mail-like user/schedule name is cleared.
UPDATE "extension_history" h SET "actor_name" = left(u."username", 128)
FROM "users" u
WHERE h."actor_type" = 'user' AND h."actor_id" = u."id";--> statement-breakpoint
UPDATE "extension_history" SET "actor_name" = NULL WHERE "actor_type" IN ('user', 'schedule') AND "actor_name" LIKE '%@%';
