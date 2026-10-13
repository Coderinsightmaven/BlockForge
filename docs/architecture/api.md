# REST & Realtime API (v1)

Base path `/api/v1`. JSON bodies validated with the zod schemas named below (from
`@blockforge/contracts`). Errors always use `ApiError` with an `x-request-id` header;
`VALIDATION_FAILED` errors carry `details: ValidationErrorDetails` (`{issues:[{path, message}]}`);
`RATE_LIMITED` (429) errors carry `RateLimitedErrorDetails` (`{retryAfterMs, retryAfterSeconds?, upstream?}`) plus a
`Retry-After` header.
Alert rule thresholds are interpreted per `ALERT_RULE_KINDS`. Realtime payloads follow
`REALTIME_EVENT_PAYLOADS`.
State-changing requests (POST/PUT/PATCH/DELETE) require the `x-blockforge-csrf` header
equal to the `csrfToken` from `GET /auth/me` (bound to the session). Lists use cursor
pagination (`?limit=&cursor=` → `{items, nextCursor}`) unless noted. Timestamps are epoch ms.

Permission column = what the route checks (scope resolved from the target resource).

**Idempotency.** Job-creating routes (`POST /servers`, `POST /servers/:id/actions`,
`DELETE /servers/:id`, backup/restore/network-apply routes, extension install/apply-updates/scan/rollback) accept an optional
`Idempotency-Key` header (1–128 printable chars). The key is scoped to the user and route;
a repeat within 24 h with the same body returns the original status + body (and the same
`jobId`); the same key with a different body returns `409 CONFLICT`. The web client sends a
fresh key per user action and reuses it on automatic retries.

## Health (no auth)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/healthz` | liveness `{status:"ok"}` (outside `/api/v1`) |
| GET | `/readyz` | readiness: DB + migrations + VictoriaMetrics reachable → 200/503 with component detail |

## Auth & setup
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/auth/setup` | → `SetupStatus` | public |
| POST | `/auth/setup` | `SetupRequest` → `Me` (logs in) | one-time setup token |
| POST | `/auth/login` | `LoginRequest` → `LoginResponse` (sets `bf_session`) | public, rate-limited |
| POST | `/auth/mfa/verify` | `MfaVerifyRequest` → `Me` | session pending MFA |
| POST | `/auth/logout` | → 204 | session |
| GET | `/auth/me` | → `Me` | session |
| POST | `/auth/password` | `ChangePasswordRequest` → 204 (revokes other sessions) | session |
| POST | `/auth/mfa/enroll` | → `MfaEnrollStart` | session |
| POST | `/auth/mfa/enroll/confirm` | `MfaEnrollConfirm` → 204 | session |
| POST | `/auth/mfa/disable` | `MfaVerifyRequest` → 204 | session |

## Users, roles, audit
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/users` | → `Page<User>` | users.view |
| POST | `/users` | `CreateUserRequest` → `User` | users.manage (+owner for privileged roles) |
| GET | `/users/:id` | → `User` | users.view |
| PATCH | `/users/:id` | `UpdateUserRequest` → `User` | users.manage |
| POST | `/users/:id/password` | `ResetPasswordRequest` → 204 (revokes sessions) | users.manage |
| POST | `/users/:id/mfa/reset` | → 204 | users.manage |
| POST | `/users/:id/roles` | `AddRoleBindingRequest` → `User` | users.manage (+owner for privileged roles) |
| DELETE | `/users/:id/roles/:bindingId` | → `User` | users.manage (cannot remove last owner) |
| GET | `/roles` | → `Role[]` | users.view |
| GET | `/audit` | `AuditQuery` → `Page<AuditEvent>` | audit.view |
| GET | `/audit/verify` | → `AuditVerifyResult` | audit.view |

## Nodes
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/nodes` | → `Node[]` (not paginated; bounded by install size) | nodes.view (filtered per scope) |
| GET | `/nodes/:id` | → `Node` | nodes.view |
| PATCH | `/nodes/:id` | `UpdateNodeRequest` → `Node` | nodes.manage |
| POST | `/nodes/:id/approve` | → `Node` | nodes.manage |
| POST | `/nodes/:id/revoke` | → `Node` (closes session, revokes key) | nodes.manage |
| POST | `/nodes/:id/rotate-credentials` | → `RotateCredentialsResponse` `{node, jobId}` (202) | nodes.manage |
| DELETE | `/nodes/:id` | → 204 (only when it hosts no servers) | nodes.manage |
| POST | `/nodes/:id/probe` | `{host, port, kind}` → `node.probe` result | nodes.manage |
| GET | `/nodes/enrollment-tokens` | → `EnrollmentToken[]` | nodes.enroll |
| POST | `/nodes/enrollment-tokens` | `CreateEnrollmentTokenRequest` → `CreatedEnrollmentToken` | nodes.enroll |
| DELETE | `/nodes/enrollment-tokens/:id` | → 204 | nodes.enroll |

## Monitoring
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/overview` | → `OverviewSummary` (scoped to what the user can view) | monitoring.view |
| GET | `/metrics/range` | `MetricRangeQuery` → `MetricSeriesResult` | monitoring.view on the node/server (global for `global.*`) |
| GET | `/alerts/incidents` | `?status=&severity=&limit=&cursor=` → `Page<AlertIncident>` | alerts.view |
| POST | `/alerts/incidents/:id/ack` | → `AlertIncident` | alerts.manage |
| POST | `/alerts/incidents/:id/resolve` | → `AlertIncident` | alerts.manage |
| GET | `/alerts/rules` | → `AlertRule[]` | alerts.view |
| POST | `/alerts/rules` | `UpsertAlertRuleRequest` → `AlertRule` | alerts.manage |
| PUT | `/alerts/rules/:id` | `UpsertAlertRuleRequest` → `AlertRule` | alerts.manage |
| DELETE | `/alerts/rules/:id` | → 204 | alerts.manage |
| GET | `/notification-channels` | → `NotificationChannel[]` | alerts.manage |
| POST | `/notification-channels` | `UpsertNotificationChannelRequest` → `NotificationChannel` | alerts.manage |
| PUT | `/notification-channels/:id` | same; omitting `config.url` keeps the stored secret URL | alerts.manage |
| DELETE | `/notification-channels/:id` | → 204 | alerts.manage |
| POST | `/notification-channels/:id/test` | → `NotificationTestResult` | alerts.manage |

## Settings
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/settings/:key` | → `{key, value}` (known keys only, e.g. `notifications.webhookAllowlist`) | settings.manage |
| PUT | `/settings/:key` | `{value}` (validated per key) → `{key, value}` | settings.manage |

## Jobs
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/jobs` | `?targetType=&targetId=&status=` → `Page<Job>` | jobs.view |
| GET | `/jobs/:id` | → `Job` | jobs.view on target |
| GET | `/jobs/:id/logs` | `?afterId=` → `JobLogLine[]` | jobs.view on target |
| POST | `/jobs/:id/cancel` | → `Job` | same as the permission that started it |

## Authorisation on servers (Phase 3)
Effective permissions of a user on a server = union of (a) role bindings at global / the server's node /
its network / the server itself, (b) `SERVER_OWNER_PERMISSIONS` if the user owns it, (c) the subuser
permission set if they are a subuser. Suspended servers: only holders of `servers.admin` may act on them
(view stays allowed). `Server.myPermissions` reports the effective set. Servers (and server-scoped
metric series) the requester cannot view answer **404**, not 403 (audited). Owners and subusers may
subscribe to the `servers` realtime topic; delivery is filtered per user. Provision/reinstall jobs
expire after 2 hours. World upload at creation is not implemented yet (`world.mode: "upload"` → 400).

## Templates & catalogue (Phase 3)
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/templates` | → `TemplateSummary[]` | templates.view, or servers.create at any scope |
| GET | `/templates/:id` | → `Template` | templates.view |
| POST | `/templates/import/preview` | `ImportTemplateRequest` → `TemplateImportPreview` | templates.manage |
| POST | `/templates/import` | `ImportTemplateRequest` → `{template: Template, issues}` (201) | templates.manage |
| PATCH | `/templates/:id` | `UpdateTemplateRequest` → `Template` (built-ins: only name/description/category) | templates.manage |
| DELETE | `/templates/:id` | → 204 (only imported templates with no servers) | templates.manage |
| GET | `/templates/:id/export` | → egg JSON (PTDL_v2) | templates.manage |
| GET | `/catalog/software` | → `SoftwareInfo[]` | servers.create (any scope) or servers.view |
| GET | `/catalog/software/:software/versions` | → `SoftwareVersion[]` | same |
| GET | `/catalog/software/:software/versions/:version/builds` | → `SoftwareBuild[]` | same |
| GET | `/catalog/software/:software/versions/:version/builds/:build/plan` | `build` may be `latest` → `ArtifactPlan` | same |

## Allocations (Phase 3)
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/nodes/:id/allocations` | `AllocationListQuery` → `Page<Allocation>` | nodes.view |
| POST | `/nodes/:id/allocations` | `CreateAllocationsRequest` → `CreateAllocationsResponse` | allocations.manage |
| PATCH | `/allocations/:id` | `UpdateAllocationRequest` → `Allocation` | allocations.manage |
| DELETE | `/allocations/:id` | → 204 (unassigned only) | allocations.manage |
| GET | `/servers/:id/allocations` | → `Allocation[]` | servers.allocations.view |
| POST | `/servers/:id/allocations` | → `ServerAllocationChangeResponse` (assigns a free allocation on the server's node, ≤ allocationLimit) | servers.allocations.manage |
| PATCH | `/servers/:id/allocations/:allocationId` | `UpdateServerAllocationRequest` → `ServerAllocationChangeResponse` | servers.allocations.manage |
| DELETE | `/servers/:id/allocations/:allocationId` | → `{restartRequired}` (not the primary) | servers.allocations.manage |

## Servers (Phase 3)
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/servers` | `ServerListQuery` → `Page<Server>` (`filter=mine` = owned + subuser) | servers.view (filtered per server) |
| POST | `/servers/placement-preview` | `CreateServerBase` (partial) → `{candidates:[{nodeId, nodeName, fits, reasons[], score, freeAllocations}]}` | servers.create |
| POST | `/servers` | `CreateServerRequest` → `{server: Server, jobId}` (202, idempotent) | servers.create on node/network (+ servers.admin for another owner) |
| GET | `/servers/:id` | → `Server` | servers.view |
| PATCH | `/servers/:id` | `UpdateServerSettingsRequest` → `Server` | servers.settings.edit |
| PATCH | `/servers/:id/build` | `UpdateServerBuildRequest` → `{server, restartRequired}` | servers.admin |
| POST | `/servers/:id/suspend` · `/unsuspend` | → `Server` (suspend stops the server) | servers.admin |
| POST | `/servers/:id/reinstall` | → `{jobId}` (idempotent; stopped/crashed/provision_failed only) | servers.reinstall |
| DELETE | `/servers/:id` | `?deleteData=true` → `{jobId}` | servers.delete |
| POST | `/servers/:id/actions` | `ServerActionRequest` → `{jobId}` | servers.control |
| POST | `/servers/:id/console` | `ConsoleCommandRequest` → 204 | servers.console.send |
| GET | `/servers/:id/console/history` | `?lines=` → `ConsoleLinesEvent` | servers.console.view |
| GET | `/servers/:id/startup` | → `ServerStartup` | servers.startup.view |
| PUT | `/servers/:id/startup/variables` | `UpdateStartupVariableRequest` → `ServerStartup` (editable vars only, rules enforced) | servers.startup.edit |
| PUT | `/servers/:id/startup/image` | `UpdateDockerImageRequest` → `ServerStartup` (template images only) | servers.startup.image |
| GET | `/servers/:id/subusers` | → `ServerSubuser[]` | servers.subusers.view |
| POST | `/servers/:id/subusers` | `AddSubuserRequest` → `ServerSubuser` | servers.subusers.manage (grants ⊆ own) |
| PUT | `/servers/:id/subusers/:subuserId` | `UpdateSubuserRequest` → `ServerSubuser` | servers.subusers.manage (grants ⊆ own) |
| DELETE | `/servers/:id/subusers/:subuserId` | → 204 | servers.subusers.manage |
| GET | `/servers/:id/activity` | `AuditQuery` → `Page<AuditEvent>` (this server only) | servers.activity.view |
| GET | `/servers/:id/config/:file` | `file ∈ {server.properties, …}` → `{content, sha256, revisionId}` | servers.config.view |
| PUT | `/servers/:id/config/:file` | `{content, baseSha256}` → `{revisionId, sha256, restartRequired}` | servers.config.edit |
| GET | `/servers/:id/config/:file/revisions` | → revisions | servers.config.view |
| POST | `/servers/:id/config/:file/revisions/:rev/rollback` | → `{revisionId}` | servers.config.edit |

## Files (Phase 3) — see `api/files.ts`
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/servers/:id/files/list` | `FileListQuery` → `FileListResponse` | servers.files.read |
| GET | `/servers/:id/files/contents` | `FileContentQuery` → `FileContentResponse` | servers.files.read |
| PUT | `/servers/:id/files/contents` | `FileWriteRequest` → `{sha256, size}` | servers.files.write |
| POST | `/servers/:id/files/rename` · `/delete` · `/copy` · `/mkdir` · `/compress` · `/decompress` · `/chmod` | see schemas | servers.files.write |
| GET | `/servers/:id/files/search` | `FileSearchQuery` → `FileSearchResponse` | servers.files.read |
| POST | `/servers/:id/files/upload-url` | `UploadUrlRequest` → `TransferUrlResponse` | servers.files.write |
| GET | `/servers/:id/files/download-url` | `DownloadUrlQuery` → `TransferUrlResponse` | servers.files.read |
| PUT · GET | `/transfers/:token` | raw body stream / file stream (single use, 5 min, session-bound) | token |

## Account (Phase 3)
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/account/ssh-keys` | → `SshKey[]` | session |
| POST | `/account/ssh-keys` | `CreateSshKeyRequest` → `SshKey` | session |
| DELETE | `/account/ssh-keys/:id` | → 204 | session |

## Backups (Phase 4) — see `api/backups.ts`
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/servers/:id/backups` | `?limit=` (≤ 500, default 100) `&cursor=` → `Backup[]`, next page cursor in the `x-next-cursor` header | servers.backups.view |
| POST | `/servers/:id/backups` | `CreateBackupRequest` → `{backup, jobId}` (202, idempotent); at the limit without `rotate` → 409 | servers.backups.create |
| PATCH | `/servers/:id/backups/:backupId` | `{name?, locked?}` → `Backup` | servers.backups.delete (lock/unlock, as Pterodactyl) |
| DELETE | `/servers/:id/backups/:backupId` | → `{jobId}`; locked → 409 | servers.backups.delete |
| GET | `/servers/:id/backups/:backupId/download` | → `TransferUrlResponse` (local: streamed via agent; S3: presigned GET, 5 min) | servers.backups.download |
| POST | `/servers/:id/backups/:backupId/restore` | `RestoreBackupRequest` → `{jobId}` (server must be stopped/crashed or is stopped by the job) | servers.backups.restore |
| GET · PUT | `/settings/backups.storage` | GET → `BackupStorageSettingsView`; PUT `{value: BackupStorageSettings}` → same (generic settings wrapper; secret write-only) | settings.manage |
| POST | `/settings/backups.storage/test` | optional `{value}` to test unsaved settings → `BackupStorageTestResult` (HEAD bucket + put/delete a probe object) | settings.manage |

Backup jobs hold the server's operation lock (`backup`/`restore` in `lifecycle.ts`), so they never overlap
power actions; rotation deletes the oldest unlocked successful backup; deleting a server deletes its backups.
`pending`/`running`/`uploading`/`completed` backups count toward `backupLimit` (`BACKUP_COUNTED_STATUSES`);
failed ones don't. Restore may start from running/degraded: the job stops the server first. Responses:
`CreateBackupResponse`, `BackupStorageTestResult`; realtime `backup.updated|deleted`, `schedule.updated|deleted`.

## Schedules (Phase 4) — see `api/schedules.ts`
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/servers/:id/schedules` | → `Schedule[]` | schedules.view |
| POST | `/servers/:id/schedules` | `UpsertScheduleRequest` → `Schedule`; 409 above 50 schedules per server | schedules.manage |
| GET · PUT · DELETE | `/servers/:id/schedules/:scheduleId` | → `Schedule` / `UpsertScheduleRequest` / 204 | schedules.view / manage |
| POST | `/servers/:id/schedules/:scheduleId/run` | → `ScheduleRun` (202); also requires every task's permission on the server (power → `servers.control`, command → `servers.console.send`, backup → `servers.backups.create`), else 403 naming the missing ones; a manual run executes as the caller (re-checked per task), scheduled runs as the last editor; 409 while a run is in progress | schedules.manage |
| GET | `/servers/:id/schedules/:scheduleId/runs` | `?limit=&cursor=` → `Page<ScheduleRun>` | schedules.view |
| POST | `/schedules/preview` | `CronPreviewRequest` → `CronPreviewResponse` | session or API key |

Task permissions are checked against the schedule's last editor **at run time** (a power task requires
servers.control, command → servers.console.send, backup → servers.backups.create); if the editor lost the
permission, the task fails with FORBIDDEN and the run is recorded as failed.

## API keys (Phase 4)
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/account/api-keys` | → `ApiKey[]` | session only |
| POST | `/account/api-keys` | `CreateApiKeyRequest` → `CreatedApiKey` (secret shown once) | session only (MFA-verified) |
| DELETE | `/account/api-keys/:id` | → 204 | session only |
| GET | `/account/permissions` | → `AccountPermissions` (role grants + per-server owner/subuser grants; for an API key, limited to the key) | session or API key (the only `/account` route keys may use) |

Every other route accepts `Authorization: Bearer bfk_…` (no CSRF). Key requests are limited to
`permissions ∩ owner's current effective permissions`, minus `API_KEY_FORBIDDEN_PERMISSIONS`; account routes
(password, MFA, SSH keys, API keys) and `/auth/*` refuse API keys. `allowedIps` is matched against the
client IP as seen through `TRUST_PROXY`. Rate limit: 120 requests/min per key (configurable).

## Plugins & mods (Phase 4b) — see `api/extensions.ts`
Reads use `EXTENSIONS_READ_PERMISSION` = `servers.extensions.view` (granted to the observer role through the
`.view` rule, to server administrators and server owners). Mutations need `servers.extensions.manage`. Vanilla and
non-Minecraft servers have no install dir: the list answers `installDir: null`, every other route 422
`PRECONDITION_FAILED` (`details.reason: "unsupported_software"`).

| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/servers/:id/extensions` | → `ExtensionList` (not paginated, ≤ 4096 items) | read |
| GET | `/servers/:id/extensions/:extensionId` | → `InstalledExtension` | read |
| POST | `/servers/:id/extensions/scan` | `ScanExtensionsRequest` → `ExtensionJobResponse` (202, idempotent) | servers.extensions.manage |
| PATCH | `/servers/:id/extensions/:extensionId` | `UpdateExtensionRequest` `{enabled}` → `UpdateExtensionResponse` (renames `x.jar` ⇄ `x.jar.disabled`) | servers.extensions.manage |
| DELETE | `/servers/:id/extensions/:extensionId` | → `RemoveExtensionResponse` (synchronous) | servers.extensions.manage |
| GET | `/servers/:id/extensions/modrinth/search` | `ModrinthSearchQuery` → `ModrinthSearchResult` | read |
| GET | `/servers/:id/extensions/modrinth/projects/:project` | `:project` = id or slug, `?allowPrerelease=` (`ModrinthProjectQuery`, default false: releases only) → `ModrinthProjectResponse` | read |
| POST | `/servers/:id/extensions/modrinth/plan` | `ModrinthPlanRequest` → `ModrinthInstallPlan` (read-only) | read |
| POST | `/servers/:id/extensions/modrinth/install` | `ModrinthInstallRequest` → `ExtensionJobResponse` (202, idempotent); plan drift → 409 | servers.extensions.manage |
| GET | `/servers/:id/extensions/updates` | `ExtensionUpdatesQuery` → `ExtensionUpdatesResponse` | read |
| POST | `/servers/:id/extensions/updates/apply` | `ApplyExtensionUpdatesRequest` → `ExtensionJobResponse` (202, idempotent) | servers.extensions.manage |
| POST | `/servers/:id/extensions/uploads` | `ExtensionUploadRequest` → `ExtensionUploadResponse` (`TransferUrlResponse` + `uploadId`) | servers.extensions.manage |
| POST | `/servers/:id/extensions/uploads/:uploadId/complete` | `CompleteExtensionUploadRequest` → `CompleteExtensionUploadResponse` | servers.extensions.manage |
| GET | `/servers/:id/extensions/history` | `ExtensionHistoryQuery` → `Page<ExtensionHistoryEntry>` (newest first) | read |
| POST | `/servers/:id/extensions/history/:entryId/rollback` | → `ExtensionJobResponse` (202, idempotent) | servers.extensions.manage |
| GET · PUT | `/settings/extensions.uploads` | generic settings wrapper, value `ExtensionUploadSettings` | settings.manage |

* **Scans.** `fs.list` of the install dir → `selectExtensionFiles` → `fs.hash` (sha1 + sha512) and
  `jar.readEntries` (`EXTENSION_METADATA_ENTRIES`, 256 KiB each) only for files whose size or mtime changed
  (`full: true` re-reads everything) → Modrinth identification by SHA-512. A file renamed outside BlockForge
  keeps its row when its SHA-512 matches a vanished row of the same scan. Scans run automatically after every
  extension job and when the list is first opened (`scan.status: "never"`).
* **Install with re-plan.** The UI shows `POST …/plan` and sends the plan's files as `expect`. At install time
  the control plane plans again; if the fresh plan is not installable or its (projectId, versionId, action) set
  differs from `expect` → 409 `CONFLICT` with `ModrinthPlanChangedDetails` `{reason: "plan_changed", plan}` and
  nothing is touched. The job fetches every file with `artifact.fetch` (SHA-512 checksum, Modrinth CDN, artifact
  cache), then deletes/keeps the `replaces` files, then rescans. Failure after some files: already fetched new
  files are removed again and replaced files restored (history entries `status: "failed"`).
* **Idempotency.** Install, apply updates, scan and rollback accept `Idempotency-Key` exactly like the backup
  routes (same 24 h replay, 409 `CONFLICT` with `details.reason` `in_progress` / `key_reused`). Upload
  completion is idempotent per `uploadId` once it has succeeded (refusals may be retried with other flags). One extension job per server at a time (409 `CONFLICT`,
  `details.reason: "extension_job_running"`); none while the server is provisioning, reinstalling, restoring,
  migrating or deleting (409 `INVALID_STATE`). Everything that changes the server's files (install, apply updates,
  rollback jobs; enable/disable, remove, upload completion) holds the server operation lock as
  `activeOperation: "extensions"` (no state change) for its whole duration: start, backup, restore, reinstall and
  delete answer the usual 409 `INVALID_STATE` meanwhile, and no extension change starts while another operation
  runs. On a `running`/`degraded` server **stop, restart and kill pre-empt** the change, and so do start
  and restart of a server that crashed meanwhile (contracts `canStartOperation`). The pre-empted change notices the
  lost lock at its next re-check and may then touch plugin/mod files only under a new **cleanup hold** (an
  `extensions` hold taken only when no other operation holds the server and it is `stopped` — never `crashed`, which the
  agent's restart policy may restart on its own; re-checked before every rename/delete): with it
  the undo runs and the job fails with `LOCK_LOST` (a synchronous change answers 409 `preempted`); without it no
  file is touched, the failed history row records every kept file (`keptPath` + digest) and every file the change
  wrote (path + SHA-512), and the job fails with `PREEMPTED_UNDO_SKIPPED` (409 `preempted_undo_skipped`). An undo
  interrupted by a control-plane restart is resumed the same way (never the apply). Every move of
  a jar is hashed before and verified after (`fs.rename` takes no expected digest, so a swap in between is
  detected and undone/refused, not prevented; likewise the lock/fence is checked right before each agent command,
  so a pre-emption can still land within that one RPC — forward changes re-check afterwards and the fenced undo
  repairs or records what happened): kept jars go back only while they have the digest taken when they
  were kept, downloads land in `.blockforge/extensions/fetch/` and are renamed into place without overwriting,
  undo deletes only files the job wrote, and a changed staged upload is refused (409 `upload_changed`). A kept
  file that cannot be vouched for is never restored; its failed history row points at it (no digest) for
  inspection and pruning. Locks of jobs that ended without releasing them are taken over / swept by maintenance.
* **`restartRequired`** is true whenever the server is not `stopped`/`crashed`: plugins and mods load only at
  start; BlockForge never hot-reloads (`/reload`) and never restarts the server on its own.
* **Uploads.** `POST …/uploads` (refused with 422 `uploads_disabled` when `extensions.uploads.allowed` is false)
  returns a single-use transfer URL; the bytes land in `.blockforge/extensions/uploads/<uploadId>.jar.part` in the
  data root (outside `plugins/`/`mods/`, so no loader reads it; excluded from backups). `…/complete` checks the
  size, hashes and reads the staged jar (`fs.hash`, `jar.readEntries`), evaluates compatibility, then renames it to
  `<installDir>/<filename>`. Refusals carry `ExtensionUploadRejectedDetails`: 422 `PRECONDITION_FAILED` for
  `not_a_jar` / `no_metadata` (policy `requireMetadata`) / `incompatible` (without `allowIncompatible`) /
  `size_mismatch` / `uploads_disabled`, 409 `CONFLICT` for `exists`. A refusal keeps the staged file:
  `…/complete` may be called again (e.g. with `replaceExisting` / `allowIncompatible`) until it succeeds; only a
  successful completion is final and replayed for that `uploadId`. Unfinished uploads are deleted after 1 h.
  `ExtensionList.uploads` exposes the policy to every reader. The
  policy is not a security boundary against holders of `servers.files.write`/SFTP (their jars show up as
  `source: "unknown"`).
* **History & rollback.** Every mutation writes an `ExtensionHistoryEntry` (also failed ones). Rollback restores
  the entry's `from` (or removes `to` when `from` is null): Modrinth versions are re-fetched by version id with
  their SHA-512 (artifact cache first); upload/unknown files come from the keep area
  `.blockforge/extensions/kept/<historyEntryId>.jar` in the data root — removals and replacements move the old
  jar there instead of deleting it; its SHA-512 is re-checked with `fs.hash` before it is moved back
  (mismatch/missing → `rollback.reason: "file_unavailable"`). Kept files are pruned after 30 days / beyond 20
  per server. Only the newest succeeded entry of a path can be rolled back (`superseded`); enable/disable are
  undone with PATCH. Unavailable → 409 `CONFLICT` with `ExtensionRollbackUnavailableDetails`.
* **Modrinth limits.** All Modrinth calls go through one shared client + `ModrinthRateLimiter` (per control-plane
  process, honouring `X-Ratelimit-*`, ≤ 2 s internal wait). Exhausted → 429 `RATE_LIMITED` with
  `RateLimitedErrorDetails` `{retryAfterMs, upstream: "modrinth"}` and `Retry-After`; other upstream failures →
  502 `UPSTREAM_ERROR`; unknown project/version → 404 `NOT_FOUND`. Responses are cached (10 min TTL).
* Realtime: `extensions.updated` on `server:<id>` (`ExtensionsUpdatedEvent`: scan status + changed ids or
  `null` = refetch the list); job progress on `job:<id>`.

## Players (Phase 4b) — see `api/players.ts`
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/servers/:id/players` | → `PlayersOverview` | servers.players.view |
| POST | `/servers/:id/players/actions` | `PlayerActionRequest` → `PlayerActionResult` | servers.players.manage (+ servers.console.send for `op`/`deop`) |
| GET | `/servers/:id/players/lookup` | `PlayerLookupQuery` `?name=` → `PlayerLookupResponse` | servers.players.view |
| GET | `/servers/:id/players/sessions` | `PlayerSessionQuery` → `Page<PlayerSession>` (newest first) | servers.players.view |

* **Overview.** Online players from the console `list uuids` (running server, `source: "list"`) or the latest
  SLP sample (`"slp"`, may be partial); lists from `whitelist.json`, `ops.json`, `banned-players.json`,
  `banned-ips.json`, flags from `server.properties`. Invalid entries/unreadable files are reported in
  `listErrors` (never a 500); lists over 10 000 entries are cut (`truncated`). `availableActions` lists what the
  UI may offer for the current software and state (empty for Velocity).
* **Actions.** Running server → library console command (validated name/IPv4, sanitised single-line reason
  ≤ 200), sent with `workload.console`, then the server's own feedback line is awaited (≤ 5 s) →
  `applied: "console"` with `feedback`. A line naming the requested target decides at once, unless another
  console command of the same action that could name the same target overlapped ours (then 504): same target,
  or a wildcard — selectors, UUIDs, `ban-ip <name>` or invalid arguments make every command of that action
  ambiguous while they may still answer (60 s), so e.g. after a console `kick @a` every `kick` is a 504 for
  60 s by design. Unrecognised commands (`say`, plugin commands, `execute … run …`) don't count. If the console
  send itself fails, the agent error is returned — except that feedback attributed before an error that leaves
  open whether the line was typed (timeout, disconnect, runtime error) is still the result. Lines that name
  nobody (26.3 `Nothing changed. …`, `No player was found`, whitelist toggles) are only accepted at the end
  of the window, when they are the only feedback seen and no other console command (console route,
  schedules, backups' `save-all`, other player actions) was possibly answering meanwhile; otherwise 504
  `no_feedback`. Stopped server → atomic JSON/properties edit with `ifMatchSha256`
  (UUID from Mojang in online mode, offline UUID otherwise) → `applied: "file"` with a fresh `overview`.
  Errors: `kick`/`whitelist-reload` on a stopped server, or `expiresAt`/`op.level`/`op.bypassesPlayerLimit`
  on a running one (vanilla commands cannot express them) → 409 `INVALID_STATE` (`details.reason`
  `not_running` / `requires_stopped`); no recognised feedback → 504 `UPSTREAM_ERROR`
  `{reason: "no_feedback", sent: true}` (outcome unknown); unknown premium name → 404; Mojang throttling → 429
  `RATE_LIMITED` (`upstream: "mojang"`); Velocity/non-Minecraft → 422 `PRECONDITION_FAILED`
  (`unsupported_software`). Bodies are strict (unknown keys → 400). IP bans are IPv4 only (the server never
  matches IPv6 bans).
* **Operator escalation.** `op`/`deop` hand out arbitrary in-game command rights, so they also require
  `servers.console.send` (already operator-equivalent); the built-in moderator role cannot op.
* **Sessions** come from the server's join/leave console events (only lines from the server's own logger).
  Sessions left open when the server stops/crashes, or when the player is missing from the next `list`, are
  closed then with `leaveReason: null`. Retention 90 days. Player counts over time are the existing metric series
  `server.players` / `global.players` (`GET /metrics/range`); no extra route.
* Realtime: `player.joined` / `player.left` on `server:<id>`, delivered only to subscribers holding
  `servers.players.view` on that server (per-event filter on top of the topic's `servers.view`).

## Agent endpoints (agent auth, not cookie auth)
`POST /agent/v1/enroll`, `GET /agent/v1/connect` (WS), `POST|GET /agent/v1/transfers/:id`,
`POST /agent/v1/sftp/auth` (`SftpAuthRequest` → `SftpAuthResponse` | 401) — see `agent-protocol.md`.

## Realtime
`GET /api/v1/realtime` → WebSocket. Cookie-authenticated; `Origin` must match the configured
public URL. Frames per `packages/contracts/src/realtime.ts`. Authorisation per topic:
`overview`/`nodes`/`servers` → monitoring.view (events filtered by scope); `alerts` →
alerts.view (each incident filtered against the user's scope for its subject);
`node:<id>` → nodes.view; `server:<id>` → servers.view (`player.*` events additionally
servers.players.view, filtered per subscriber); `console:<id>` →
servers.console.view; `job:<id>` → jobs.view on the job target. Server buffers at most
1 MiB per client; slow clients are disconnected with close code 4008 and must reconnect.
