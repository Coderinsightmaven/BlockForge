# Data Model (PostgreSQL)

Implemented in `apps/control-plane/src/db/schema/*.ts` (Drizzle) with SQL migrations in
`apps/control-plane/drizzle/`. Conventions:

* Primary keys `uuid` (v4, generated in app). Timestamps `timestamptz`, `created_at`/`updated_at`.
* Human identifiers (`slug`) are `^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$`, unique per scope.
* Enums are Postgres `text` + `CHECK` constraints (easier migrations than native enums);
  the allowed values come from `packages/contracts`.
* Soft deletion is avoided; deletions are explicit jobs with audit events. FK behaviour is
  stated per relation. High-volume time series never go here (VictoriaMetrics).
* Optimistic concurrency: mutable aggregates carry `version integer` bumped on every update.

## Identity & access

| Table | Key columns | Notes |
|-------|-------------|-------|
| `users` | `id, email (citext unique), display_name, password_hash, status (active/disabled), mfa_totp_secret_enc, mfa_enabled, failed_login_count, locked_until, last_login_at` | argon2id hashes. TOTP secret encrypted with the master key. |
| `sessions` | `id, user_id → users ON DELETE CASCADE, token_hash (unique), csrf_token_hash, created_at, last_seen_at, expires_at, ip, user_agent, mfa_verified` | Opaque cookie `bf_session`; idle timeout 12 h, absolute 7 d. |
| `roles` | `id, key (unique), name, description, builtin bool` | Built-ins seeded: owner, admin, infra_admin, network_admin, server_admin, moderator, observer. |
| `role_permissions` | `role_id → roles CASCADE, permission` PK(role_id, permission) | Permission keys from contracts. |
| `role_bindings` | `id, user_id → users CASCADE, role_id → roles RESTRICT, scope_type (global/node/network/server), scope_id uuid null` unique(user, role, scope_type, scope_id) | Scoped grants. |
| `api_tokens` | `id, user_id CASCADE, name, token_hash unique, prefix, scopes jsonb, expires_at, last_used_at, revoked_at` | For integrations; permissions ⊆ owner's. |
| `setup_state` | singleton row `id=1, completed_at, setup_token_hash` | First-run owner creation guarded by a one-time token printed to the control-plane log. |

## Infrastructure

| Table | Key columns | Notes |
|-------|-------------|-------|
| `nodes` | `id, name unique, slug unique, status (pending/active/draining/maintenance/disabled/revoked), connection (online/offline/degraded/unreachable — derived & cached), location, tags text[], public_address, private_address, scheduling_enabled, cpu_allocatable_millicores, memory_allocatable_bytes, storage_allocatable_bytes, overcommit_memory_ratio numeric, facts jsonb, agent_version, last_heartbeat_at, last_connected_at, clock_skew_ms, version` | `facts` is the latest `NodeFacts`. |
| `node_credentials` | `id, node_id → nodes CASCADE, public_key (b64url), status (active/rotated/revoked), created_at, revoked_at` | Exactly one `active` per node (partial unique index). |
| `enrollment_tokens` | `id, token_id (16 hex) unique, secret_hash, label, created_by → users SET NULL, expires_at, used_at, used_by_node_id, requires_approval, tags text[], location` | Single use. |
| `resource_reservations` | `id, node_id → nodes RESTRICT, server_id → servers CASCADE null, kind (server/hold), cpu_millicores, memory_bytes, storage_bytes, expires_at null` | Holds during provisioning expire; server reservations persist while the server exists. |
| `maintenance_windows` | `id, scope_type, scope_id, starts_at, ends_at, reason, created_by` | |
| `agent_commands` | `id (= command id), node_id CASCADE, type, payload_redacted jsonb, issued_by_user_id null, job_id null, status (sent/succeeded/failed/expired/rejected), error jsonb, issued_at, completed_at` | Auditable command history (payloads with secrets redacted). Retained 30 d. |

## Servers & software

| Table | Key columns | Notes |
|-------|-------------|-------|
| `servers` | `id, name, slug unique, kind (game/proxy), node_id → nodes RESTRICT, software (vanilla/paper/purpur/fabric/forge/neoforge/folia/spigot/velocity), minecraft_version, build_id, java_major, state (lifecycle), desired_state (running/stopped), active_operation null, active_job_id null, memory_limit_bytes, heap_max_bytes, cpu_limit_millicores, storage_quota_bytes, port, host_ip, query_port null, rcon_enabled, jvm_args text[], startup (manual/auto), restart_policy jsonb, timezone, location, last_started_at, last_crash_at, last_exit_code, version` | `state` transitions are validated against the contracts state machine. |
| `server_config_revisions` | `id, server_id CASCADE, file_path, content (text), sha256, source (generated/user/rollback/observed), created_by null, created_at, applied_at null, health (unknown/healthy/failed)` unique(server_id, file_path, sha256) | Revision history + last-known-good. |
| `software_builds` | `id, software, minecraft_version, build, channel, download_url, checksum_algorithm, checksum, java_major, released_at, metadata jsonb, fetched_at` unique(software, minecraft_version, build) | Cache of authoritative catalogue data. |
| `installed_extensions` | `id, server_id CASCADE, kind (plugin/mod/datapack), source (modrinth/upload/url), project_id, version_id, name, filename, sha256, enabled, installed_at, installed_by` | Phase 4. |
| `extension_history` | `id, server_id CASCADE, action (install/update/remove/rollback/enable/disable), from_version, to_version, actor, at, job_id` | Phase 4. |
| `worlds` | `id, server_id CASCADE, name, dimension_dirs text[], seed null, size_bytes, measured_at` | Phase 4. |

## Networks (Velocity)

| Table | Key columns | Notes |
|-------|-------------|-------|
| `networks` | `id, name, slug unique, description, forwarding_mode (modern/legacy/none/bungeeguard), forwarding_secret_id → secrets RESTRICT, default_server_ids uuid[] (ordered try list), maintenance bool, version` | |
| `network_members` | `network_id CASCADE, server_id CASCADE, role (proxy/lobby/survival/creative/minigame/limbo/event/other), backend_name (velocity server key), priority int, internal_address, internal_port` PK(network_id, server_id), unique(network_id, backend_name) | A server belongs to ≤ 1 network in v1. |
| `forced_hosts` | `id, network_id CASCADE, hostname (lowercase, IDNA-normalised), target_server_ids uuid[] ordered, created_by, updated_at` unique(network_id, hostname) | |
| `network_config_revisions` | `id, network_id CASCADE, revision int, plan jsonb (desired model), rendered jsonb (file → content/sha), status (draft/validated/applied/failed/rolled_back), validation jsonb, created_by, created_at, applied_at` unique(network_id, revision) | Drafts from the topology editor, diffs, rollback. |

## Operations

| Table | Key columns | Notes |
|-------|-------------|-------|
| `jobs` | `id, type, status (queued/running/succeeded/failed/cancelled), target_type, target_id, requested_by, idempotency_key unique null, input jsonb (redacted), result jsonb, error jsonb, attempts, created_at, started_at, finished_at` | User-visible durable job record (pg-boss holds queue mechanics). |
| `job_steps` | `id, job_id CASCADE, ordinal, key, label, status (pending/running/succeeded/failed/skipped), message, started_at, finished_at` | Progress UI + resumability. |
| `job_logs` | `id bigserial, job_id CASCADE, ts, level, message` | Bounded per job (≤ 2000 lines). |
| `events` | `id bigserial, type, subject_type, subject_id, data jsonb, occurred_at` | Domain event outbox/history; retention 90 d. |
| `backups`, `backup_policies` | Phase 6 | |
| `schedules`, `schedule_runs` | Phase 4/7 | |
| `alert_rules`, `alert_incidents`, `notification_channels`, `notification_deliveries` | Phase 2 (basic) / 7 | |
| `secrets` | `id, scope_type, scope_id, name, ciphertext bytea, nonce bytea, key_version, created_at, rotated_at` | AES-256-GCM with `BLOCKFORGE_MASTER_KEY`; never returned by the API. |
| `audit_events` | `id bigserial, at, actor_type (user/system/node/api_token), actor_id, action, target_type, target_id, ip, request_id, outcome (success/denied/failed), details jsonb (redacted), prev_hash, hash` | Hash chain (`hash = sha256(prev_hash ‖ canonical row)`) for tamper evidence; insert-only (no UPDATE/DELETE grants for the app role in production). |
| `settings` | `key primary, value jsonb, updated_by, updated_at` | |
