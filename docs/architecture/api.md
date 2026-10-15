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

**Rate limits.** Besides the auth/enrollment limits and the per-API-key limit, the database routes that reach a
database host or reveal a password are limited to 60 requests/minute per client IP and route (429 `RATE_LIMITED`).

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
| PATCH | `/servers/:id/build` | `UpdateServerBuildRequest` → `{server, restartRequired}` (incl. `databaseLimit`, Phase 5) | servers.admin |
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
* **`source` is provenance.** `modrinth` = BlockForge installed the file from Modrinth (install, update, or a
  rollback that re-fetched it), `upload` = uploaded through BlockForge, `unknown` = found on disk. A scan never
  sets `modrinth`/`upload`: a file copied in (file manager, SFTP) stays `unknown` even when the SHA-512 lookup
  identifies it — the identification is in `InstalledExtension.modrinth` and drives update checks, plans and
  rollback re-fetches exactly as for installed files — and a BlockForge-placed file whose content changes on disk
  (a successful hash that differs from the stored digest) becomes `unknown` with `installedAt`/`installedBy`
  cleared. A changed file that cannot be hashed keeps its row as it was (digest, metadata, provenance, old
  size/mtime) and is retried on the next scan. Migration 0007 relabelled rows a scan had labelled `modrinth`
  (`installed_at` null).
* **Rollback source.** A rollback restores `from` from the keep area whenever the entry has an unexpired kept file
  (no network); if that file is gone or no longer matches its digest, or there is none, it re-fetches the exact file from
  Modrinth when the snapshot has a version id + SHA-512 (whatever its `source`; the download must match). A
  re-fetched file is `source: "modrinth"` with `installedAt` set; a kept file keeps its recorded source, and an
  `unknown` one gets no `installedAt`. The rescan stamps only the row whose SHA-512 equals the restored bytes. A
  kept file that cannot be hashed (I/O error) fails the job with `HASH_FAILED` before anything moves (run the
  rollback again); it never switches the rollback to a download.
* **Duplicate copies.** Two enabled jars of the install dir whose selected metadata declare the same plugin name /
  mod id (case-insensitive; Bukkit names with spaces read as `_`; every mod of a multi-mod jar) both get a
  `DUPLICATE_ID` problem naming the other path(s): a warning for plugins (Paper/Velocity load one copy), an error
  for mods (`loadable: false`; Fabric/Forge/NeoForge refuse to start). Disabled, unread and otherwise unloadable
  jars do not count, and a client-only Fabric copy makes it a warning (dedicated servers skip it). Only jars of
  the same directory are compared. The problem depends on the other files, so it is added whenever extensions are
  read (list, single read, enable/disable and upload responses) and is never stored with the row; the upload's
  `DUPLICATE_ID` warning uses the same rule. Every change that can alter it (enable, disable, remove, upload, and
  scans, which every install/update/rollback job ends with) lists in `extensions.updated.changed` all rows sharing
  a plugin name / mod id with the changed rows before or after the change, so clients re-read each affected row
  (more than 256 ids → `changed: null`, for every publisher).
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

## Databases (Phase 5) — see `api/databases.ts`
MySQL/MariaDB database hosts (admin) and per-server databases (Pterodactyl "Databases"). The control plane connects
to the hosts itself with the host's admin account (`mysql2`, one short-lived connection per operation, 10 s connect
/ 15 s statement timeout, no LOCAL INFILE, cleartext auth refused); agents are not involved.

| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/database-hosts` | → `DatabaseHost[]` (not paginated) | database_hosts.manage (global) |
| POST | `/database-hosts` | `CreateDatabaseHostRequest` → `DatabaseHost` (201) | database_hosts.manage |
| GET | `/database-hosts/:id` | → `DatabaseHost` | database_hosts.manage |
| PATCH | `/database-hosts/:id` | `UpdateDatabaseHostRequest` → `DatabaseHost` | database_hosts.manage |
| DELETE | `/database-hosts/:id` | → 204; 409 `{reason: "has_databases", count}` while it has databases | database_hosts.manage |
| POST | `/database-hosts/:id/test` | → `DatabaseHostTestResult` (saved settings) | database_hosts.manage, rate-limited |
| POST | `/database-hosts/test` | `TestDatabaseHostRequest` → `DatabaseHostTestResult` (unsaved settings) | database_hosts.manage, rate-limited |
| GET | `/servers/:id/databases` | → `ServerDatabase[]` (no passwords) | servers.databases.view |
| POST | `/servers/:id/databases` | `CreateServerDatabaseRequest` `{name, remote?, hostId?}` → `ServerDatabase` (201) | servers.databases.create (+ database_hosts.manage for `hostId`), rate-limited |
| GET | `/servers/:id/databases/:databaseId/password` | → `ServerDatabasePassword` (`Cache-Control: no-store`, audited) | servers.databases.view_password, rate-limited |
| POST | `/servers/:id/databases/:databaseId/rotate-password` | → `ServerDatabase` | servers.databases.update, rate-limited |
| DELETE | `/servers/:id/databases/:databaseId` | `?forget=true` (optional) → 204 | servers.databases.delete (+ database_hosts.manage to forget), rate-limited |

* **Host admin password** is write-only: never returned (`DatabaseHost` is strict), logged or audited (audit
  records `passwordChanged`). Omitting it on PATCH keeps the stored one, **except** when a connection setting changes
  (`host`, `port`, `username`, `tlsMode`, `tlsCaCertificate`): then it must be sent again (400, issue path
  `password`), so a stored password is never sent to a different address or over a weaker channel. The same rule
  applies to `POST /database-hosts/test` with `hostId` instead of `password`. Test results carry only fixed,
  credential-free messages (`access denied for the admin user …`, `connection refused`, `TLS error: …`).
* **TLS** (`tlsMode`, named after the MySQL client's SSL modes): `disabled` (plain TCP); `preferred` (TLS when
  offered, plain otherwise — **host not verified**); `required` (TLS or fail — encrypted but **host not verified**:
  stops passive sniffing only, an active man-in-the-middle can impersonate the host and receive the admin
  credentials); `verify_ca` (TLS, and the certificate chain must verify against `tlsCaCertificate` — MySQL
  `VERIFY_CA`; the host name is not checked). `tlsCaCertificate` is required with `verify_ca` and refused (400)
  with every other mode; PATCHing to another mode clears the stored CA (a CHECK constraint enforces
  CA ⇔ `verify_ca`). `DatabaseHostTestResult.tls` only says the session was encrypted. The UI labels the modes
  "host not verified" / "certificate verified" accordingly. `required` stays available because many self-hosted
  servers present auto-generated certificates no CA vouches for; use `verify_ca` with the server's CA (or its
  self-signed certificate) wherever the network between control plane and host is not trusted. **Pin a private CA or
  the server's own certificate, never a public CA**: the host name is not checked, so any certificate the pinned CA
  issued (for any name) would be accepted. A `verify_identity` mode (host name check) is not offered: `mysql2` skips
  the name check for IP-literal hosts and hosts are commonly addressed by IP; pinning the server's own certificate
  gives the stronger guarantee.
* **Names.** Database `s<shortId>_<name>` (`name` = 1–48 of `[a-z0-9_]`, ≤ 58 chars in total), username
  `u<shortId>_<10 random [a-z0-9]>` (20 chars), password 32 random chars of `[A-Za-z0-9-_.~]` (at least one of each
  class, so `validate_password` MEDIUM accepts it). `remote` ("connections from", default `%`) is normalised by
  `normalizeDatabaseRemote`: `%`, IPv4, `10.0.%`-style wildcards, CIDR (rewritten to the portable netmask form
  `10.0.0.0/255.0.0.0`), address/netmask, host names (optionally `%.example.com`), IPv6.
* **Statements** (`databases/sql.ts`): `CREATE DATABASE … utf8mb4`, `CREATE USER … IDENTIFIED BY …`,
  `GRANT <Pterodactyl's 18 database privileges> ON \`db\`.* TO …` (never GRANT OPTION or anything global),
  `ALTER USER … IDENTIFIED BY …`, `DROP DATABASE IF EXISTS`, `DROP USER IF EXISTS`. These statements take no `?`
  parameters, so every identifier/value is re-validated against an allowlist regex right before it is backtick- or
  single-quoted; nothing else reaches SQL. In the GRANT the `_` of the database name is escaped (`\_`), because `_`
  is a wildcard in database-level grants (an unescaped grant on `s…_a_b` would also cover — and allow creating —
  `s…_aXb`); on MySQL with `partial_revokes = ON` grant names are literal and the escape is omitted.
* **Host choice** (no `hostId`): the first host with capacity (`maxDatabases`, null = unlimited) among hosts linked
  to the server's node, then unlinked hosts, then hosts linked to other nodes (oldest first). None → 422
  `PRECONDITION_FAILED` `{reason: "no_host"}`; an explicitly chosen full host → 409 `{reason: "host_full"}`.
* **Limit** `Server.databaseLimit` (set with `PATCH /servers/:id/build`, default 0): 0 disables databases for
  non-administrators (403 `{reason: "disabled"}`), at the limit 409 `{reason: "limit_reached", limit}`; holders of
  `servers.admin` are not limited (as for backups). Concurrent creations are serialised per server. Lowering the
  limit below the usage keeps the existing databases.
* **No transaction across host I/O.** Every create/rotate/delete claims the row in a short transaction
  (`server_databases.operation` = `creating`/`rotating`/`deleting` + a token, timestamps from the database clock),
  talks to the host with no Postgres transaction, lock or pooled connection held, then records the outcome in a
  second short transaction that is conditional on still holding the claim. A second create/rotate/delete of the same
  database meanwhile → 409 `{reason: "busy"}`. A claim older than the stale limit (default ≈ 7 minutes; checked at
  startup to exceed the longest host operation including the create clean-up, ≈ 6 minutes with the default
  timeouts) belongs to a crashed process: the maintenance sweep (every minute and at start) resolves it, and claim
  takeovers are audited (`server.database.claim_takeover`).
* **Statements the host does not answer.** mysql2's statement timeout only reports an error: the statement keeps
  running on the host (e.g. waiting behind `FLUSH TABLES WITH READ LOCK` or a metadata lock) and may take effect
  later. Therefore (1) every admin session sets `lock_wait_timeout` (and `max_statement_time` on MariaDB; MySQL's
  `max_execution_time` covers SELECTs only) to a few seconds below the client timeout, so the host aborts such a
  statement itself with an error; (2) if no answer arrives anyway (client timeout, connection lost, cancellation),
  the control plane sends `KILL QUERY <id>` from a fresh connection, confirms in `information_schema.PROCESSLIST`
  that the statement is gone, kills the thread, destroys the socket and never reuses that session; (3) the outcome
  is then decided by looking at the host (database / account existence, the account's authentication string). Only
  if the statement cannot be confirmed stopped is the outcome unknown (502 with `unknownOutcome: true`) and the
  database's `status` says what happens next. The admin account therefore needs `SELECT` on `mysql.user` (and may
  kill its own threads, which needs no privilege).
* **KILL only for our own statement on a proven direct connection.** Every session statement carries a random
  per-statement nonce comment (`/* bf:<nonce> */ …`, visible in `PROCESSLIST.INFO`), and every session records
  `CONNECTION_ID()` and the server's identity (`@@server_id`, `@@hostname`, `@@port`, `VERSION()`, plus the server's
  unique id: `@@server_uuid` on MySQL, `@@server_uid` on MariaDB 10.5.26 / 10.6.19 / 10.11.9 / 11.4.3 and later).
  `KILL QUERY` is sent only when both connections are direct (greeting id = `CONNECTION_ID()`), report the same server
  identity, and the process-list row of the recorded thread belongs to the admin user and shows the statement's nonce.
  Without a KILL a statement counts as stopped only when the unique ids prove the same server and the thread is gone
  or runs something else; on older MariaDB without `@@server_uid` only the nonce can prove it. Otherwise — a proxy or
  load balancer (MaxScale, ProxySQL, HAProxy to several servers), an identity query the host refuses, a foreign thread —
  nothing is killed and the outcome stays unknown until reconciled. Test connection reports `proxyDetected`
  (greeting id ≠ `CONNECTION_ID()`, two sessions reaching different servers, or an unreadable identity); connect
  BlockForge directly to the database server where possible.
* **Shutdown** never waits for a host: before in-flight requests and background tasks are awaited the control plane
  refuses new host connections, cancels the sweep, abandons running statements and destroys the connections of abort
  procedures already in progress (a `KILL` waiting for a host that stopped answering); outcomes are recorded as unknown
  (`password_unknown` / `cleanup_pending`), requests waiting on them answer 503 `{reason: "host_error", code:
  "SHUTDOWN"}`, and server-deletion jobs see `SHUTDOWN` and are retried after the restart.
* **Status** (`ServerDatabase.status`): `creating` / `rotating` / `deleting` while that operation runs; `ready`;
  `password_unknown` (a rotation's outcome could not be determined — the password route answers 409
  `{reason: "password_unknown"}`; rotating again fixes it); `cleanup_pending` (a failed create, a deletion that got
  partway, or an outcome that is unknown: the sweep drops it by name with `IF EXISTS` once a late statement can no
  longer land — host statement limit + 60 s after the state was set — and removes the entry). Deleting a
  `cleanup_pending` database inside that safety window answers 409 `{reason: "not_ready", retryAfterMs}`; afterwards it
  retries the drops at once. Password and rotation answer 409 `{reason: "not_ready"}` while a database is `creating`
  or `cleanup_pending`.
* **Create** reserves the row (limits, host capacity, names; state `reserved`, claimed `creating`) in one short
  transaction, then on the host checks that neither the database nor an account with the generated name exists
  (pre-existing database → 409 `{reason: "name_taken"}`, pre-existing account → 502 `ER_CANNOT_USER`; neither is ever
  touched) and marks the row `provisioning` — from then on whatever exists under those names is ours — and creates
  database, account and grant. On failure everything that may have been created is dropped by name and the row
  removed; if that clean-up fails or a statement could not be confirmed stopped, the row stays `cleanup_pending`
  (audited) for the sweep. Host failures → 502 `UPSTREAM_ERROR` `{reason: "host_error", code}`. Refused while the
  server is being deleted (409 `INVALID_STATE`); if the server is deleted while the host is contacted, the created
  objects are dropped again. A creation or deletion abandoned by a crash on a `reserved` row (names never verified on
  the host) only removes the row — nothing is ever dropped by name for it.
* **Rotate** (`ready` or `password_unknown`): claim → read the account's authentication string → `ALTER USER` →
  store the new (encrypted) password, `ready`, release. A failure before `ALTER USER` was sent changes nothing (the
  state stays). `ALTER USER` refused by the host (atomic) → the old password stays valid (502, "the password was not
  changed"). No answer → the statement is stopped and the authentication string compared: changed → applied, the new
  password is stored (200); unchanged → nothing happened (502); undeterminable → `password_unknown` (502
  `unknownOutcome`). If the database was deleted meanwhile → 404; taken over → 409 `busy`.
* **Delete**: claim → `DROP DATABASE IF EXISTS` + `DROP USER IF EXISTS` → delete the row (conditional on the claim;
  if the entry vanished meanwhile → 404 and no success is recorded). On failure the outcome is decided per statement:
  before `DROP DATABASE` was sent, or `DROP DATABASE` refused by the host (atomic on MySQL 8; on MariaDB a
  `DROP DATABASE` that has started dropping is not interruptible, so an error means it had not) → unchanged (502,
  "the database was not deleted"; retry); no answer and not confirmed stopped → `cleanup_pending` (502
  `unknownOutcome`); otherwise the host is inspected: both gone → deleted (204), both present → unchanged (502),
  anything else — e.g. `DROP USER` failed after the database was dropped — → `cleanup_pending` (502, "partly
  deleted"; the sweep finishes the requested deletion); stopped but the host could not be inspected → `cleanup_pending`
  (502, result `unchecked`).
* **Forget** (`DELETE …?forget=true`, contracts `DeleteServerDatabaseQuery`; also requires `database_hosts.manage`):
  removes only BlockForge's entry without contacting the host — the database and its account stay there. For hosts
  that are permanently gone, so their entry can be deleted. Refused (409 `busy`) while a live operation holds the
  database; audited as `server.database.forget` with host, database and username.
* **Sweep** (maintenance, every minute and at start): resolves abandoned claims, then drops `cleanup_pending`
  databases whose window has passed (re-checked when each row is claimed) — the oldest 20 of every host per run (fair
  share), 4 hosts at a time, one session per host; after any failure on a host its remaining rows wait for the next run
  (a frozen host costs one statement timeout per run, not one per row). Cancelled at shutdown.
* **Test connection** (`DatabaseHostTestResult`) also reports `proxyDetected` (see above) and `missingPrivileges`:
  privileges the admin account seems to lack — `CREATE USER` (global), `GRANT OPTION` and the 18 database privileges
  it hands out, held globally (`information_schema.USER_PRIVILEGES` of `CURRENT_USER()`) or by a database-level grant
  whose pattern covers BlockForge's names (`SCHEMA_PRIVILEGES`, matched against `s00000000_probe` with the grant
  wildcard semantics; literally on MySQL with `partial_revokes = ON`) — plus `SELECT on mysql.user` (checked by a
  query). Privileges granted only through roles are not seen; the UI says so.
* **Recommended admin account** (least privilege; tested on MariaDB 11.4 — create, rotate and delete work and the check
  reports nothing missing):
  ```sql
  CREATE USER 'blockforge'@'<control-plane address>' IDENTIFIED BY '<strong password>';
  GRANT ALL PRIVILEGES ON `s%`.* TO 'blockforge'@'<control-plane address>' WITH GRANT OPTION;
  GRANT CREATE USER ON *.* TO 'blockforge'@'<control-plane address>';
  GRANT SELECT ON mysql.user TO 'blockforge'@'<control-plane address>';
  ```
  `s%` covers every BlockForge database (`s<shortId>_<name>`) and — like any database-level wildcard grant — any other
  database whose name starts with `s`: keep the account's host dedicated to BlockForge databases. On MySQL with
  `partial_revokes = ON` grant names are literal and the `s%` grant does not work; use global privileges there.
* **Server deletion** gets a `databases` step after the container is removed: every database of the server is
  dropped on its host, each row deleted (and audited) as soon as its database is gone. One session per host; after an
  unanswered statement the next database gets a fresh session, a host that cannot be reached marks its remaining
  databases failed. Outcomes are decided per statement as for Delete (inspections honour the step's cancellation and
  deadline). The step honours job cancellation (the running statement is killed, the job ends cancelled, the server
  stays), control-plane shutdown (the job is retried after the restart) and its own deadline (5 minutes; databases
  not reached are recorded with code `DEADLINE`). Problems are written to the job log as warnings and audited
  (`server.database.delete`, `outcome: failed` with `details.result` `unchanged` / `partial` / `unknown` / `unchecked` /
  `not_attempted` — an unconfirmed drop is logged as "outcome unknown, may still complete", a stopped one whose result
  could not be checked as such, neither as a refusal; the audit outcome enum has no "unknown") with host, database and username to check and drop by hand. The step never fails the
  job and the remaining rows go with the server.
* **Audit**: `database_host.create|update|delete`, `server.database.create|rotate_password|delete` (also failed
  attempts, with `result`, `cleanupPending` / `passwordUnknown` where relevant), `server.database.forget`,
  `server.database.claim_takeover`, `server.database.password.view` (every reveal). No password, hash or SQL
  statement is ever recorded.
* **Rate limits**: 60 requests/minute per client IP and route on the routes that reach a host or reveal a password.
* No realtime events: all mutations are synchronous; clients refetch the list after their own changes.

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
