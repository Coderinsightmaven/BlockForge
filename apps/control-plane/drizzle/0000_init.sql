CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "role_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "role_bindings_unique" UNIQUE NULLS NOT DISTINCT("user_id","role_id","scope_type","scope_id"),
	CONSTRAINT "role_bindings_scope_type_check" CHECK ("role_bindings"."scope_type" IN ('global', 'node', 'network', 'server')),
	CONSTRAINT "role_bindings_scope_id_check" CHECK (("role_bindings"."scope_type" = 'global') = ("role_bindings"."scope_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permissions_pk" PRIMARY KEY("role_id","permission"),
	CONSTRAINT "role_permissions_permission_check" CHECK ("role_permissions"."permission" IN ('settings.manage', 'users.view', 'users.manage', 'roles.manage', 'audit.view', 'secrets.read', 'secrets.manage', 'monitoring.view', 'jobs.view', 'alerts.view', 'alerts.manage', 'nodes.view', 'nodes.manage', 'nodes.enroll', 'networks.view', 'networks.create', 'networks.manage', 'servers.view', 'servers.create', 'servers.delete', 'servers.control', 'servers.console.view', 'servers.console.send', 'servers.config.view', 'servers.config.edit', 'servers.files.read', 'servers.files.write', 'servers.extensions.manage', 'servers.players.view', 'servers.players.manage', 'servers.backups.view', 'servers.backups.create', 'servers.backups.restore', 'schedules.manage'))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"mfa_failed_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone,
	"setup_token_hash" text,
	"token_created_at" timestamp with time zone,
	CONSTRAINT "setup_state_singleton" CHECK ("setup_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_totp_secret_enc" text,
	"mfa_pending_secret_enc" text,
	"mfa_last_time_step" bigint,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"name" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "secrets_scope_name_unique" UNIQUE NULLS NOT DISTINCT("scope_type","scope_id","name"),
	CONSTRAINT "secrets_scope_type_check" CHECK ("secrets"."scope_type" IN ('global', 'node', 'network', 'server'))
);
--> statement-breakpoint
CREATE TABLE "agent_auth_jti" (
	"jti" text PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_node_id" uuid,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"location" text,
	CONSTRAINT "enrollment_tokens_token_id_unique" UNIQUE("token_id"),
	CONSTRAINT "enrollment_tokens_token_id_format" CHECK ("enrollment_tokens"."token_id" ~ '^[0-9a-f]{16}$')
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_windows_scope_type_check" CHECK ("maintenance_windows"."scope_type" IN ('global', 'node', 'network', 'server')),
	CONSTRAINT "maintenance_windows_range_check" CHECK ("maintenance_windows"."ends_at" > "maintenance_windows"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "node_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "node_credentials_status_check" CHECK ("node_credentials"."status" IN ('pending', 'active', 'rotated', 'revoked')),
	CONSTRAINT "node_credentials_pending_expiry" CHECK ("node_credentials"."status" <> 'pending' OR "node_credentials"."expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"connection" text DEFAULT 'offline' NOT NULL,
	"location" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"public_address" text,
	"private_address" text,
	"scheduling_enabled" boolean DEFAULT true NOT NULL,
	"cpu_allocatable_millicores" integer,
	"memory_allocatable_bytes" bigint,
	"storage_allocatable_bytes" bigint,
	"overcommit_memory_ratio" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"facts" jsonb,
	"agent_version" text,
	"last_heartbeat_at" timestamp with time zone,
	"last_connected_at" timestamp with time zone,
	"last_disconnected_at" timestamp with time zone,
	"last_disconnect_clean" boolean DEFAULT false NOT NULL,
	"last_seen_ip" text,
	"clock_skew_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "nodes_name_unique" UNIQUE("name"),
	CONSTRAINT "nodes_slug_unique" UNIQUE("slug"),
	CONSTRAINT "nodes_status_check" CHECK ("nodes"."status" IN ('pending', 'active', 'draining', 'maintenance', 'disabled', 'revoked')),
	CONSTRAINT "nodes_connection_check" CHECK ("nodes"."connection" IN ('online', 'degraded', 'unreachable', 'offline')),
	CONSTRAINT "nodes_overcommit_check" CHECK ("nodes"."overcommit_memory_ratio" >= 1 AND "nodes"."overcommit_memory_ratio" <= 4)
);
--> statement-breakpoint
CREATE TABLE "agent_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload_redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issued_by_user_id" uuid,
	"job_id" uuid,
	"status" text NOT NULL,
	"error" jsonb,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_commands_status_check" CHECK ("agent_commands"."status" IN ('sent', 'succeeded', 'failed', 'expired', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"request_id" text,
	"outcome" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" IN ('user', 'system', 'node', 'api_token')),
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" IN ('success', 'denied', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "events_type_check" CHECK ("events"."type" IN ('node.enrolled', 'node.approved', 'node.revoked', 'node.connection.changed', 'server.created', 'server.provision.requested', 'server.provision.completed', 'server.provision.failed', 'server.state.changed', 'server.crashed', 'server.config.changed', 'server.deleted', 'network.configuration.validated', 'network.configuration.applied', 'backup.completed', 'backup.failed', 'migration.completed', 'alert.fired', 'alert.resolved', 'job.updated'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("user_id","route","key")
);
--> statement-breakpoint
CREATE TABLE "job_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	CONSTRAINT "job_logs_level_check" CHECK ("job_logs"."level" IN ('debug', 'info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE TABLE "job_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_steps_job_key_unique" UNIQUE("job_id","key"),
	CONSTRAINT "job_steps_status_check" CHECK ("job_steps"."status" IN ('pending', 'running', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"requested_by" uuid,
	"idempotency_key" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"boss_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_version" text,
	"to_version" text,
	"actor" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_id" uuid,
	CONSTRAINT "extension_history_action_check" CHECK ("extension_history"."action" IN ('install', 'update', 'remove', 'rollback', 'enable', 'disable'))
);
--> statement-breakpoint
CREATE TABLE "installed_extensions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"project_id" text,
	"version_id" text,
	"name" text NOT NULL,
	"filename" text NOT NULL,
	"sha256" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by" uuid,
	CONSTRAINT "installed_extensions_kind_check" CHECK ("installed_extensions"."kind" IN ('plugin', 'mod', 'datapack')),
	CONSTRAINT "installed_extensions_source_check" CHECK ("installed_extensions"."source" IN ('modrinth', 'upload', 'url'))
);
--> statement-breakpoint
CREATE TABLE "resource_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"server_id" uuid,
	"kind" text NOT NULL,
	"cpu_millicores" integer DEFAULT 0 NOT NULL,
	"memory_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_reservations_kind_check" CHECK ("resource_reservations"."kind" IN ('server', 'hold')),
	CONSTRAINT "resource_reservations_server_check" CHECK ("resource_reservations"."kind" <> 'server' OR "resource_reservations"."server_id" IS NOT NULL),
	CONSTRAINT "resource_reservations_nonneg_check" CHECK ("resource_reservations"."cpu_millicores" >= 0 AND "resource_reservations"."memory_bytes" >= 0 AND "resource_reservations"."storage_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "server_config_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"health" text DEFAULT 'unknown' NOT NULL,
	CONSTRAINT "server_config_revisions_unique" UNIQUE("server_id","file_path","sha256"),
	CONSTRAINT "server_config_revisions_source_check" CHECK ("server_config_revisions"."source" IN ('generated', 'user', 'rollback', 'observed')),
	CONSTRAINT "server_config_revisions_health_check" CHECK ("server_config_revisions"."health" IN ('unknown', 'healthy', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"node_id" uuid NOT NULL,
	"software" text NOT NULL,
	"minecraft_version" text NOT NULL,
	"build_id" text,
	"java_major" integer,
	"state" text NOT NULL,
	"desired_state" text NOT NULL,
	"active_operation" text,
	"active_job_id" uuid,
	"memory_limit_bytes" bigint NOT NULL,
	"heap_max_bytes" bigint NOT NULL,
	"cpu_limit_millicores" integer,
	"storage_quota_bytes" bigint,
	"port" integer NOT NULL,
	"host_ip" text DEFAULT '0.0.0.0' NOT NULL,
	"query_port" integer,
	"rcon_enabled" boolean DEFAULT false NOT NULL,
	"jvm_args" text[] DEFAULT '{}'::text[] NOT NULL,
	"startup" text DEFAULT 'auto' NOT NULL,
	"restart_policy" jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"location" text,
	"last_started_at" timestamp with time zone,
	"last_crash_at" timestamp with time zone,
	"last_exit_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "servers_slug_unique" UNIQUE("slug"),
	CONSTRAINT "servers_kind_check" CHECK ("servers"."kind" IN ('game', 'proxy')),
	CONSTRAINT "servers_software_check" CHECK ("servers"."software" IN ('vanilla', 'paper', 'purpur', 'folia', 'spigot', 'fabric', 'forge', 'neoforge', 'velocity')),
	CONSTRAINT "servers_state_check" CHECK ("servers"."state" IN ('provisioning', 'provision_failed', 'starting', 'running', 'degraded', 'stopping', 'stopped', 'crashed', 'updating', 'backing_up', 'restoring', 'migrating', 'unreachable', 'deleting')),
	CONSTRAINT "servers_desired_state_check" CHECK ("servers"."desired_state" IN ('running', 'stopped')),
	CONSTRAINT "servers_active_operation_check" CHECK ("servers"."active_operation" IS NULL OR "servers"."active_operation" IN ('provision', 'start', 'stop', 'restart', 'kill', 'update', 'backup', 'restore', 'migrate', 'delete')),
	CONSTRAINT "servers_startup_check" CHECK ("servers"."startup" IN ('manual', 'auto')),
	CONSTRAINT "servers_port_check" CHECK ("servers"."port" BETWEEN 1 AND 65535),
	CONSTRAINT "servers_heap_check" CHECK ("servers"."heap_max_bytes" < "servers"."memory_limit_bytes")
);
--> statement-breakpoint
CREATE TABLE "software_builds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"software" text NOT NULL,
	"minecraft_version" text NOT NULL,
	"build" text NOT NULL,
	"channel" text NOT NULL,
	"download_url" text NOT NULL,
	"checksum_algorithm" text,
	"checksum" text,
	"java_major" integer,
	"released_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "software_builds_unique" UNIQUE("software","minecraft_version","build"),
	CONSTRAINT "software_builds_software_check" CHECK ("software_builds"."software" IN ('vanilla', 'paper', 'purpur', 'folia', 'spigot', 'fabric', 'forge', 'neoforge', 'velocity')),
	CONSTRAINT "software_builds_checksum_algorithm_check" CHECK ("software_builds"."checksum_algorithm" IS NULL OR "software_builds"."checksum_algorithm" IN ('sha1', 'sha256', 'sha512'))
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dimension_dirs" text[] DEFAULT '{}'::text[] NOT NULL,
	"seed" text,
	"size_bytes" bigint,
	"measured_at" timestamp with time zone,
	CONSTRAINT "worlds_server_name_unique" UNIQUE("server_id","name")
);
--> statement-breakpoint
CREATE TABLE "forced_host_targets" (
	"forced_host_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "forced_host_targets_pk" PRIMARY KEY("forced_host_id","server_id"),
	CONSTRAINT "forced_host_targets_position_unique" UNIQUE("forced_host_id","position")
);
--> statement-breakpoint
CREATE TABLE "forced_hosts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"network_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forced_hosts_unique" UNIQUE("network_id","hostname"),
	CONSTRAINT "forced_hosts_lowercase_check" CHECK ("forced_hosts"."hostname" = lower("forced_hosts"."hostname"))
);
--> statement-breakpoint
CREATE TABLE "network_config_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"network_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"rendered" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"validation" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "network_config_revisions_unique" UNIQUE("network_id","revision"),
	CONSTRAINT "network_config_revisions_status_check" CHECK ("network_config_revisions"."status" IN ('draft', 'validated', 'applied', 'failed', 'rolled_back'))
);
--> statement-breakpoint
CREATE TABLE "network_members" (
	"network_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"role" text NOT NULL,
	"backend_name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"internal_address" text,
	"internal_port" integer,
	CONSTRAINT "network_members_pk" PRIMARY KEY("network_id","server_id"),
	CONSTRAINT "network_members_backend_unique" UNIQUE("network_id","backend_name"),
	CONSTRAINT "network_members_server_unique" UNIQUE("server_id"),
	CONSTRAINT "network_members_role_check" CHECK ("network_members"."role" IN ('proxy', 'lobby', 'survival', 'creative', 'minigame', 'limbo', 'event', 'other'))
);
--> statement-breakpoint
CREATE TABLE "network_try_servers" (
	"network_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "network_try_servers_pk" PRIMARY KEY("network_id","server_id"),
	CONSTRAINT "network_try_servers_position_unique" UNIQUE("network_id","position")
);
--> statement-breakpoint
CREATE TABLE "networks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"forwarding_mode" text NOT NULL,
	"forwarding_secret_id" uuid,
	"maintenance" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "networks_slug_unique" UNIQUE("slug"),
	CONSTRAINT "networks_forwarding_mode_check" CHECK ("networks"."forwarding_mode" IN ('modern', 'legacy', 'none', 'bungeeguard'))
);
--> statement-breakpoint
CREATE TABLE "alert_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid,
	"dedup_key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_name" text,
	"summary" text NOT NULL,
	"value" double precision,
	"first_fired_at" timestamp with time zone NOT NULL,
	"last_fired_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"last_notified_at" timestamp with time zone,
	CONSTRAINT "alert_incidents_kind_check" CHECK ("alert_incidents"."kind" IN ('node.cpu.high', 'node.memory.high', 'node.disk.low', 'node.unreachable', 'server.crashed', 'server.memory.high', 'server.heap.high', 'job.failed')),
	CONSTRAINT "alert_incidents_severity_check" CHECK ("alert_incidents"."severity" IN ('info', 'warning', 'critical')),
	CONSTRAINT "alert_incidents_status_check" CHECK ("alert_incidents"."status" IN ('firing', 'acknowledged', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"builtin_key" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"scope_type" text DEFAULT 'global' NOT NULL,
	"scope_id" uuid,
	"threshold" double precision,
	"for_seconds" integer DEFAULT 0 NOT NULL,
	"cooldown_seconds" integer DEFAULT 900 NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_builtin_key_unique" UNIQUE("builtin_key"),
	CONSTRAINT "alert_rules_kind_check" CHECK ("alert_rules"."kind" IN ('node.cpu.high', 'node.memory.high', 'node.disk.low', 'node.unreachable', 'server.crashed', 'server.memory.high', 'server.heap.high', 'job.failed')),
	CONSTRAINT "alert_rules_severity_check" CHECK ("alert_rules"."severity" IN ('info', 'warning', 'critical')),
	CONSTRAINT "alert_rules_scope_type_check" CHECK ("alert_rules"."scope_type" IN ('global', 'node', 'server')),
	CONSTRAINT "alert_rules_scope_id_check" CHECK (("alert_rules"."scope_type" = 'global') = ("alert_rules"."scope_id" IS NULL)),
	CONSTRAINT "alert_rules_durations_check" CHECK ("alert_rules"."for_seconds" >= 0 AND "alert_rules"."cooldown_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_kind_check" CHECK ("notification_channels"."kind" IN ('discord', 'webhook', 'email'))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"incident_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"payload" jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "notification_deliveries_status_check" CHECK ("notification_deliveries"."status" IN ('pending', 'succeeded', 'failed')),
	CONSTRAINT "notification_deliveries_reason_check" CHECK ("notification_deliveries"."reason" IN ('test', 'fired', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_auth_jti" ADD CONSTRAINT "agent_auth_jti_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_used_by_node_id_nodes_id_fk" FOREIGN KEY ("used_by_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_credentials" ADD CONSTRAINT "node_credentials_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_commands" ADD CONSTRAINT "agent_commands_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_commands" ADD CONSTRAINT "agent_commands_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_commands" ADD CONSTRAINT "agent_commands_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_history" ADD CONSTRAINT "extension_history_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_history" ADD CONSTRAINT "extension_history_actor_users_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_history" ADD CONSTRAINT "extension_history_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extensions" ADD CONSTRAINT "installed_extensions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extensions" ADD CONSTRAINT "installed_extensions_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_config_revisions" ADD CONSTRAINT "server_config_revisions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_config_revisions" ADD CONSTRAINT "server_config_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_active_job_id_jobs_id_fk" FOREIGN KEY ("active_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_host_targets" ADD CONSTRAINT "forced_host_targets_forced_host_id_forced_hosts_id_fk" FOREIGN KEY ("forced_host_id") REFERENCES "public"."forced_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_host_targets" ADD CONSTRAINT "forced_host_targets_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_hosts" ADD CONSTRAINT "forced_hosts_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_hosts" ADD CONSTRAINT "forced_hosts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_config_revisions" ADD CONSTRAINT "network_config_revisions_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_config_revisions" ADD CONSTRAINT "network_config_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_members" ADD CONSTRAINT "network_members_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_members" ADD CONSTRAINT "network_members_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_try_servers" ADD CONSTRAINT "network_try_servers_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_try_servers" ADD CONSTRAINT "network_try_servers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networks" ADD CONSTRAINT "networks_forwarding_secret_id_secrets_id_fk" FOREIGN KEY ("forwarding_secret_id") REFERENCES "public"."secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_incidents" ADD CONSTRAINT "alert_incidents_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_incidents" ADD CONSTRAINT "alert_incidents_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_incidents" ADD CONSTRAINT "alert_incidents_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_incident_id_alert_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."alert_incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "role_bindings_user_idx" ON "role_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "role_bindings_scope_idx" ON "role_bindings" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_auth_jti_expires_idx" ON "agent_auth_jti" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "maintenance_windows_scope_idx" ON "maintenance_windows" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_credentials_one_active" ON "node_credentials" USING btree ("node_id") WHERE "node_credentials"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "node_credentials_one_pending" ON "node_credentials" USING btree ("node_id") WHERE "node_credentials"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "node_credentials_node_idx" ON "node_credentials" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "agent_commands_node_idx" ON "agent_commands" USING btree ("node_id","issued_at");--> statement-breakpoint
CREATE INDEX "agent_commands_issued_idx" ON "agent_commands" USING btree ("issued_at");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "events_occurred_idx" ON "events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "events_undispatched_idx" ON "events" USING btree ("id") WHERE "events"."dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "job_logs_job_idx" ON "job_logs" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "jobs_target_idx" ON "jobs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "extension_history_server_idx" ON "extension_history" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "installed_extensions_server_idx" ON "installed_extensions" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "resource_reservations_node_idx" ON "resource_reservations" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "servers_node_idx" ON "servers" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "servers_state_idx" ON "servers" USING btree ("state");--> statement-breakpoint
CREATE INDEX "network_config_revisions_network_idx" ON "network_config_revisions" USING btree ("network_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_incidents_open_dedup" ON "alert_incidents" USING btree ("dedup_key") WHERE "alert_incidents"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "alert_incidents_status_idx" ON "alert_incidents" USING btree ("status","last_fired_at");--> statement-breakpoint
CREATE INDEX "alert_incidents_dedup_idx" ON "alert_incidents" USING btree ("dedup_key","resolved_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_pending_idx" ON "notification_deliveries" USING btree ("next_attempt_at") WHERE "notification_deliveries"."status" = 'pending';