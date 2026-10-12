# REST & Realtime API (v1)

Base path `/api/v1`. JSON bodies validated with the zod schemas named below (from
`@blockforge/contracts`). Errors always use `ApiError` with an `x-request-id` header.
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
| GET | `/audit/verify` | → `{valid, checked, firstBrokenId?}` | audit.view |

## Nodes
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/nodes` | → `Node[]` (not paginated; bounded by install size) | nodes.view (filtered per scope) |
| GET | `/nodes/:id` | → `Node` | nodes.view |
| PATCH | `/nodes/:id` | `UpdateNodeRequest` → `Node` | nodes.manage |
| POST | `/nodes/:id/approve` | → `Node` | nodes.manage |
| POST | `/nodes/:id/revoke` | → `Node` (closes session, revokes key) | nodes.manage |
| POST | `/nodes/:id/rotate-credentials` | → `Node` | nodes.manage |
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
| GET | `/alerts/incidents` | `?status=&limit=&cursor=` → `Page<AlertIncident>` | alerts.view |
| POST | `/alerts/incidents/:id/ack` | → `AlertIncident` | alerts.manage |
| POST | `/alerts/incidents/:id/resolve` | → `AlertIncident` | alerts.manage |
| GET | `/alerts/rules` | → `AlertRule[]` | alerts.view |
| POST | `/alerts/rules` | `UpsertAlertRuleRequest` → `AlertRule` | alerts.manage |
| PUT | `/alerts/rules/:id` | `UpsertAlertRuleRequest` → `AlertRule` | alerts.manage |
| DELETE | `/alerts/rules/:id` | → 204 | alerts.manage |
| GET | `/notification-channels` | → `NotificationChannel[]` | alerts.manage |
| POST | `/notification-channels` | `UpsertNotificationChannelRequest` → `NotificationChannel` | alerts.manage |
| PUT | `/notification-channels/:id` | same | alerts.manage |
| DELETE | `/notification-channels/:id` | → 204 | alerts.manage |
| POST | `/notification-channels/:id/test` | → `{delivered, error?}` | alerts.manage |

## Jobs
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/jobs` | `?targetType=&targetId=&status=` → `Page<Job>` | jobs.view |
| GET | `/jobs/:id` | → `Job` | jobs.view on target |
| GET | `/jobs/:id/logs` | `?afterId=` → `JobLogLine[]` | jobs.view on target |
| POST | `/jobs/:id/cancel` | → `Job` | same as the permission that started it |

## Servers (Phase 3)
| Method | Path | Body → Response | Permission |
|--------|------|-----------------|------------|
| GET | `/catalog/software` | → `SoftwareInfo[]` | servers.view |
| GET | `/catalog/software/:software/versions` | → `SoftwareVersion[]` | servers.view |
| GET | `/catalog/software/:software/versions/:version/builds` | → `SoftwareBuild[]` | servers.view |
| GET | `/servers` | `ServerListQuery` → `Page<Server>` | servers.view (filtered) |
| POST | `/servers/placement-preview` | `CreateServerRequest` (partial) → `{candidates:[{nodeId, nodeName, fits, reasons[], score}]}` | servers.create |
| POST | `/servers` | `CreateServerRequest` → `{server: Server, jobId}` (202) | servers.create on node/network |
| GET | `/servers/:id` | → `Server` | servers.view |
| PATCH | `/servers/:id` | limits/startup/restart policy → `Server` | servers.config.edit |
| DELETE | `/servers/:id` | `?deleteData=true` → `{jobId}` | servers.delete |
| POST | `/servers/:id/actions` | `ServerActionRequest` → `{jobId}` | servers.control |
| POST | `/servers/:id/console` | `ConsoleCommandRequest` → 204 | servers.console.send |
| GET | `/servers/:id/console/history` | `?lines=` → `ConsoleLinesEvent` | servers.console.view |
| GET | `/servers/:id/config/:file` | `file ∈ {server.properties, …}` → `{content, sha256, revisionId}` | servers.config.view |
| PUT | `/servers/:id/config/:file` | `{content, baseSha256}` → `{revisionId, sha256, restartRequired}` | servers.config.edit |
| GET | `/servers/:id/config/:file/revisions` | → revisions | servers.config.view |
| POST | `/servers/:id/config/:file/revisions/:rev/rollback` | → `{revisionId}` | servers.config.edit |

## Agent endpoints (agent auth, not cookie auth)
`POST /agent/v1/enroll`, `GET /agent/v1/connect` (WS), `POST|GET /agent/v1/transfers/:id`
— see `agent-protocol.md`.

## Realtime
`GET /api/v1/realtime` → WebSocket. Cookie-authenticated; `Origin` must match the configured
public URL. Frames per `packages/contracts/src/realtime.ts`. Authorisation per topic:
`overview`/`nodes`/`servers` → monitoring.view (events filtered by scope); `alerts` →
alerts.view (each incident filtered against the user's scope for its subject);
`node:<id>` → nodes.view; `server:<id>` → servers.view; `console:<id>` →
servers.console.view; `job:<id>` → jobs.view on the job target. Server buffers at most
1 MiB per client; slow clients are disconnected with close code 4008 and must reconnect.
