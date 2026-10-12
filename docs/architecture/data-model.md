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

### Phase 3 additions (identity)
* `users.username` text unique (`^[a-z0-9][a-z0-9_-]{2,31}$`; existing rows backfilled from the email local part with a numeric suffix on collision).
* `user_ssh_keys`: `id, user_id → users CASCADE, name, key_type, public_key (authorized_keys line), fingerprint unique per user, created_at, last_used_at`.

## Infrastructure

| Table | Key columns | Notes |
|-------|-------------|-------|
| `nodes` | `id, name unique, slug unique, status (pending/active/draining/maintenance/disabled/revoked), connection (online/offline/degraded/unreachable — derived & cached), location, tags text[], public_address, private_address, scheduling_enabled, cpu_allocatable_millicores, memory_allocatable_bytes, storage_allocatable_bytes, overcommit_memory_ratio numeric, facts jsonb, agent_version, last_heartbeat_at, last_connected_at, clock_skew_ms, version` | `facts` is the latest `NodeFacts`. |
| `node_credentials` | `id, node_id → nodes CASCADE, public_key (b64url), status (pending/active/rotated/revoked), created_at, expires_at null (pending only), activated_at, revoked_at` | Exactly one `active` and at most one `pending` per node (partial unique indexes). See agent-protocol §3.1. |
| `agent_auth_jti` | `jti primary, node_id → nodes CASCADE, expires_at` | Durable, replica-shared replay cache for agent tokens; rows deleted after `expires_at`. |
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
| `installed_extensions` | Phase 0 placeholder, reshaped in Phase 4b (see below). | |
| `extension_history` | Phase 0 placeholder, reshaped in Phase 4b (see below). | |
| `worlds` | `id, server_id CASCADE, name, dimension_dirs text[], seed null, size_bytes, measured_at` | Phase 4. |

### Phase 3 additions (servers)
| Table | Key columns | Notes |
|-------|-------------|-------|
| `templates` | `id, key unique, name, description, category, kind (minecraft/velocity/egg), game, author, source (builtin/import), source_format, docker_images jsonb, startup text, config_files jsonb, startup_done jsonb, stop jsonb, install jsonb null, features text[], file_denylist text[], runtime jsonb, raw_import jsonb null, created_at, updated_at` | Built-ins seeded idempotently (`minecraft-java`, `velocity`). |
| `template_variables` | `id, template_id → templates CASCADE, env_name, name, description, default_value, user_viewable, user_editable, rules, sort_order` unique(template_id, env_name) | |
| `allocations` | `id, node_id → nodes CASCADE, ip inet, port int, alias, notes, server_id → servers SET NULL null, is_primary bool, created_at` unique(node_id, ip, port); partial unique(server_id) where is_primary | Deleting a node with allocations in use is blocked by the server FK on nodes. |
| `server_variables` | `server_id → servers CASCADE, env_name, value` PK(server_id, env_name) | Values for egg variables (defaults not copied). |
| `server_subusers` | `id, server_id → servers CASCADE, user_id → users CASCADE, permissions text[], created_by, created_at` unique(server_id, user_id) | |
| `servers` (changes) | `+ owner_id → users RESTRICT, template_id → templates RESTRICT, description, docker_image, suspended bool, allocation_limit, backup_limit; software/minecraft_version/heap_max_bytes become nullable; port/host_ip replaced by the primary allocation` | Owner deletion requires transferring their servers first. |

### Phase 4 additions
| Table | Key columns | Notes |
|-------|-------------|-------|
| `backups` | `id, server_id → servers CASCADE, name, status, locked, storage (local/s3), object_key null, consistency, size_bytes, sha256, ignored text[], skipped_symlinks, error, created_by → users SET NULL, schedule_id → schedules SET NULL, job_id, created_at, completed_at` index(server_id, created_at) | Server deletion runs a job that deletes local archives / S3 objects before the rows cascade. |
| `schedules` | `id, server_id → servers CASCADE, name, cron jsonb, timezone, enabled, only_when_online, tasks jsonb, next_run_at, last_run_at, running_run_id null, updated_by → users SET NULL, created_at, updated_at` index(next_run_at) where enabled | Claimed with `FOR UPDATE SKIP LOCKED`. |
| `schedule_runs` | `id, schedule_id → schedules CASCADE, trigger, status, reason, tasks jsonb, started_at, finished_at` | Retention 30 d / last 100 per schedule. |
| `api_tokens` (changes) | `+ permissions text[] null (null = all), allowed_ips text[], last_used_ip, prefix`; `token_hash` = sha256(secret) | Revocation = row delete (audited). |
| `settings['backups.storage']` | JSON without the secret; S3 secret key in `secrets` (scope global, name `backups.s3.secretAccessKey`) | |

### Phase 4b additions (plugins & mods, players)
The Phase 0 placeholder tables `installed_extensions` / `extension_history` are empty and unused; the migration
may drop and recreate them. Shapes mirror `packages/contracts/src/api/extensions.ts` / `players.ts`.

| Table | Key columns | Notes |
|-------|-------------|-------|
| `installed_extensions` | `id, server_id → servers CASCADE, kind (plugin/mod), source (modrinth/upload/unknown), path, filename, enabled, size_bytes, mtime timestamptz, sha512 null, sha1 null, metadata jsonb ([] default, ExtensionMetadataView[]), compatibility jsonb null, modrinth jsonb null (ModrinthRef), modrinth_project_id text null, installed_at null, installed_by → users SET NULL, first_seen_at, last_seen_at` unique(server_id, path); index(server_id, modrinth_project_id) | One row per jar in `plugins/`/`mods/` (incl. `.jar.disabled`). Enable/disable updates `path` in place (same id). Scans upsert by path and delete rows whose file vanished (a vanished row whose sha512 reappears under a new path in the same scan keeps its id). `installed_*` set only for BlockForge installs/uploads. jsonb columns are untrusted text, capped as in the contracts. |
| `extension_scans` | `server_id → servers CASCADE primary, status (never/running/completed/failed), job_id → jobs SET NULL, started_at, scanned_at null, error null` | Separate from `servers` so scans do not bump `servers.version`. |
| `extension_history` | `id, server_id → servers CASCADE, extension_id → installed_extensions SET NULL, action (install/update/remove/rollback/enable/disable/upload), status (succeeded/failed), extension_name, path, from jsonb null, to jsonb null (ExtensionFileSnapshot), actor_type (user/api_token/schedule/system), actor_id uuid null, actor_name null, at, job_id → jobs SET NULL, error null, kept_path null, kept_sha512 null, kept_until null` index(server_id, at desc) | `kept_*` = the replaced/removed jar moved to `.blockforge/extensions/kept/<id>.jar` in the data root (restorable by rollback; pruned after 30 d / beyond 20 per server, then `kept_path` is cleared). Retention of rows: 1 year. |
| `extension_uploads` | `id, server_id → servers CASCADE, filename, size_bytes, staging_path, created_by → users SET NULL, created_at, expires_at, completed_at null` index(expires_at) where completed_at is null | Staging file `.blockforge/extensions/uploads/<id>.jar.part`; expired rows and their files are removed after 1 h. |
| `player_sessions` | `id, server_id → servers CASCADE, name, uuid null, joined_at, left_at null, leave_reason null (≤ 256, untrusted)` index(server_id, joined_at desc); index(server_id, lower(name)); partial index(server_id) where left_at is null | From console join/leave events; open sessions are closed on stop/crash or when missing from `list`. Retention 90 days. |
| `settings['extensions.uploads']` | `ExtensionUploadSettings` `{allowed, requireMetadata}` (default `{true, true}`) | Generic `/settings/:key` route. |

## Networks (Velocity)

| Table | Key columns | Notes |
|-------|-------------|-------|
| `networks` | `id, name, slug unique, description, forwarding_mode (modern/legacy/none/bungeeguard), forwarding_secret_id → secrets RESTRICT, maintenance bool, version` | |
| `network_try_servers` | `network_id → networks CASCADE, server_id → servers CASCADE, position int` PK(network_id, server_id), unique(network_id, position) | Ordered default/fallback (`try`) list with real FKs; the validator flags an empty list. |
| `network_members` | `network_id CASCADE, server_id CASCADE, role (proxy/lobby/survival/creative/minigame/limbo/event/other), backend_name (velocity server key), priority int, internal_address, internal_port` PK(network_id, server_id), unique(network_id, backend_name) | A server belongs to ≤ 1 network in v1. |
| `forced_hosts` | `id, network_id CASCADE, hostname (lowercase, IDNA-normalised), created_by, updated_at` unique(network_id, hostname) | |
| `forced_host_targets` | `forced_host_id → forced_hosts CASCADE, server_id → servers CASCADE, position int` PK(forced_host_id, server_id), unique(forced_host_id, position) | Ordered targets with FKs; deleting a backend removes it from every mapping and the validator reports mappings left empty. |
| `network_config_revisions` | `id, network_id CASCADE, revision int, plan jsonb (desired model), rendered jsonb (file → content/sha), status (draft/validated/applied/failed/rolled_back), validation jsonb, created_by, created_at, applied_at` unique(network_id, revision) | Drafts from the topology editor, diffs, rollback. |

## Operations

| Table | Key columns | Notes |
|-------|-------------|-------|
| `jobs` | `id, type, status (queued/running/succeeded/failed/cancelled), target_type, target_id, requested_by, idempotency_key unique null, input jsonb (redacted), result jsonb, error jsonb, attempts, created_at, started_at, finished_at` | User-visible durable job record (pg-boss holds queue mechanics). |
| `idempotency_keys` | `key, user_id → users CASCADE, route, request_hash, response_status, response_body jsonb, created_at` PK(user_id, route, key) | 24 h retention; see api.md Idempotency. |
| `job_steps` | `id, job_id CASCADE, ordinal, key, label, status (pending/running/succeeded/failed/skipped), message, started_at, finished_at` | Progress UI + resumability. |
| `job_logs` | `id bigserial, job_id CASCADE, ts, level, message` | Bounded per job (≤ 2000 lines). |
| `events` | `id bigserial, type, subject_type, subject_id, data jsonb, occurred_at` | Domain event outbox/history; retention 90 d. |
| `backups`, `backup_policies` | Phase 6 | |
| `schedules`, `schedule_runs` | Phase 4/7 | |
| `alert_rules`, `alert_incidents`, `notification_channels`, `notification_deliveries` | Phase 2 (basic) / 7 | |
| `secrets` | `id, scope_type, scope_id, name, ciphertext bytea, nonce bytea, key_version, created_at, rotated_at` | AES-256-GCM with `BLOCKFORGE_MASTER_KEY`; never returned by the API. |
| `audit_events` | `id bigserial, at, actor_type (user/system/node/api_token), actor_id, action, target_type, target_id, ip, request_id, outcome (success/denied/failed), details jsonb (redacted), prev_hash, hash` | Hash chain (`hash = sha256(prev_hash ‖ canonical row)`) for tamper evidence; insert-only (no UPDATE/DELETE grants for the app role in production). |
| `settings` | `key primary, value jsonb, updated_by, updated_at` | |
