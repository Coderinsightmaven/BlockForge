# REST & Realtime API (v1)

Base path `/api/v1`. JSON bodies validated with the zod schemas named below (from
`@blockforge/contracts`). Errors always use `ApiError` with an `x-request-id` header;
`VALIDATION_FAILED` errors carry `details: ValidationErrorDetails` (`{issues:[{path, message}]}`).
Alert rule thresholds are interpreted per `ALERT_RULE_KINDS`. Realtime payloads follow
`REALTIME_EVENT_PAYLOADS`.
State-changing requests (POST/PUT/PATCH/DELETE) require the `x-blockforge-csrf` header
equal to the `csrfToken` from `GET /auth/me` (bound to the session). Lists use cursor
pagination (`?limit=&cursor=` → `{items, nextCursor}`) unless noted. Timestamps are epoch ms.

Permission column = what the route checks (scope resolved from the target resource).

**Idempotency.** Job-creating routes (`POST /servers`, `POST /servers/:id/actions`,
`DELETE /servers/:id`, backup/restore/network-apply routes) accept an optional
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
| GET | `/servers/:id/backups` | → `Backup[]` | servers.backups.view |
| POST | `/servers/:id/backups` | `CreateBackupRequest` → `{backup, jobId}` (202, idempotent); at the limit without `rotate` → 409 | servers.backups.create |
| PATCH | `/servers/:id/backups/:backupId` | `{name?, locked?}` → `Backup` | servers.backups.delete (lock/unlock, as Pterodactyl) |
| DELETE | `/servers/:id/backups/:backupId` | → `{jobId}`; locked → 409 | servers.backups.delete |
| GET | `/servers/:id/backups/:backupId/download` | → `TransferUrlResponse` (local: streamed via agent; S3: presigned GET, 5 min) | servers.backups.download |
| POST | `/servers/:id/backups/:backupId/restore` | `RestoreBackupRequest` → `{jobId}` (server must be stopped/crashed or is stopped by the job) | servers.backups.restore |
| GET · PUT | `/settings/backups.storage` | `BackupStorageSettings` (secret write-only, never returned) | settings.manage |
| POST | `/settings/backups.storage/test` | → `{ok, error}` (HEAD bucket + put/delete a probe object) | settings.manage |

Backup jobs hold the server's operation lock (`backup`/`restore` in `lifecycle.ts`), so they never overlap
power actions; rotation deletes the oldest unlocked successful backup; deleting a server deletes its backups.
`pending`/`running`/`uploading`/`completed` backups count toward `backupLimit` (`BACKUP_COUNTED_STATUSES`);
failed ones don't. Restore may start from running/degraded: the job stops the server first. Responses:
`CreateBackupResponse`, `BackupStorageTestResult`; realtime `backup.updated|deleted`, `schedule.updated|deleted`.

## Schedules (Phase 4) — see `api/schedules.ts`
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/servers/:id/schedules` | → `Schedule[]` | schedules.view |
| POST | `/servers/:id/schedules` | `UpsertScheduleRequest` → `Schedule` | schedules.manage |
| GET · PUT · DELETE | `/servers/:id/schedules/:scheduleId` | → `Schedule` / `UpsertScheduleRequest` / 204 | schedules.view / manage |
| POST | `/servers/:id/schedules/:scheduleId/run` | → `ScheduleRun` (202) | schedules.manage |
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

Every other route accepts `Authorization: Bearer bfk_…` (no CSRF). Key requests are limited to
`permissions ∩ owner's current effective permissions`, minus `API_KEY_FORBIDDEN_PERMISSIONS`; account routes
(password, MFA, SSH keys, API keys) and `/auth/*` refuse API keys. `allowedIps` is matched against the
client IP as seen through `TRUST_PROXY`. Rate limit: 120 requests/min per key (configurable).

## Agent endpoints (agent auth, not cookie auth)
`POST /agent/v1/enroll`, `GET /agent/v1/connect` (WS), `POST|GET /agent/v1/transfers/:id`,
`POST /agent/v1/sftp/auth` (`SftpAuthRequest` → `SftpAuthResponse` | 401) — see `agent-protocol.md`.

## Realtime
`GET /api/v1/realtime` → WebSocket. Cookie-authenticated; `Origin` must match the configured
public URL. Frames per `packages/contracts/src/realtime.ts`. Authorisation per topic:
`overview`/`nodes`/`servers` → monitoring.view (events filtered by scope); `alerts` →
alerts.view (each incident filtered against the user's scope for its subject);
`node:<id>` → nodes.view; `server:<id>` → servers.view; `console:<id>` →
servers.console.view; `job:<id>` → jobs.view on the job target. Server buffers at most
1 MiB per client; slow clients are disconnected with close code 4008 and must reconnect.
