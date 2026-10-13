-- Control plane Phase 4b review fixes.
-- #3: plugin/mod changes hold the server operation lock (`active_operation = 'extensions'`, no state change).
ALTER TABLE "servers" DROP CONSTRAINT "servers_active_operation_check";--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_active_operation_check" CHECK ("servers"."active_operation" IS NULL OR "servers"."active_operation" IN ('provision', 'reinstall', 'start', 'stop', 'restart', 'kill', 'update', 'backup', 'restore', 'migrate', 'delete', 'extensions'));--> statement-breakpoint
-- #7: extension history named the acting user by e-mail address (visible to every servers.extensions.view
-- holder). Rows of existing users get the username; any other e-mail-like user/schedule name is cleared.
UPDATE "extension_history" h SET "actor_name" = left(u."username", 128)
FROM "users" u
WHERE h."actor_type" = 'user' AND h."actor_id" = u."id";--> statement-breakpoint
UPDATE "extension_history" SET "actor_name" = NULL WHERE "actor_type" IN ('user', 'schedule') AND "actor_name" LIKE '%@%';
