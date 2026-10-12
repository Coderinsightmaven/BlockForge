import {
  AlertIncident,
  AlertRule,
  AuditEvent,
  AuditVerifyResult,
  CreatedEnrollmentToken,
  EnrollmentToken,
  LoginResponse,
  Me,
  MetricSeriesResult,
  MfaEnrollStart,
  Node,
  NotificationChannel,
  NotificationTestResult,
  OverviewSummary,
  Role,
  SetupStatus,
  User,
  page,
} from "@blockforge/contracts";
import type {
  AddRoleBindingRequest,
  ChangePasswordRequest,
  CreateEnrollmentTokenRequest,
  CreateUserRequest,
  LoginRequest,
  MetricRangeQuery,
  MfaEnrollConfirm,
  MfaVerifyRequest,
  ResetPasswordRequest,
  SetupRequest,
  UpdateNodeRequest,
  UpdateUserRequest,
  UpsertAlertRuleRequest,
  UpsertNotificationChannelRequest,
} from "@blockforge/contracts";
import { z } from "zod";
import { apiClient } from "./client";

/*
 * One typed function per route in docs/architecture/api.md. Request bodies use the zod *input*
 * types (defaults applied server-side); responses are validated against the contract schemas.
 */

const UserPage = page(User);
const AuditPage = page(AuditEvent);
const IncidentPage = page(AlertIncident);

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;

function rememberCsrf(me: Me): Me {
  apiClient.setCsrfToken(me.csrfToken);
  return me;
}

/**
 * Starting a new session: any token still in memory belongs to the previous session. Until the
 * new `Me` arrives the client falls back to the `bf_csrf` cookie, which the server rotates with the
 * session (this is what the pending-MFA `POST /auth/mfa/verify` uses).
 */
function forgetCsrf(): void {
  apiClient.setCsrfToken(null);
}

export const authApi = {
  setupStatus: (signal?: AbortSignal) =>
    apiClient.get("/auth/setup", { schema: SetupStatus, signal, skipAuthRedirect: true }),
  setup: (body: In<typeof SetupRequest>) => {
    forgetCsrf();
    return apiClient.post("/auth/setup", { body, schema: Me, skipAuthRedirect: true }).then(rememberCsrf);
  },
  login: (body: In<typeof LoginRequest>) => {
    forgetCsrf();
    return apiClient
      .post("/auth/login", { body, schema: LoginResponse, skipAuthRedirect: true })
      .then((r) => {
        // `mfa_required`: memory stays empty so the fresh session cookie is used for verify.
        if (r.me) rememberCsrf(r.me);
        return r;
      });
  },
  verifyMfa: (body: In<typeof MfaVerifyRequest>) =>
    apiClient.post("/auth/mfa/verify", { body, schema: Me, skipAuthRedirect: true }).then(rememberCsrf),
  logout: () => apiClient.post<void>("/auth/logout", { skipAuthRedirect: true }),
  me: (signal?: AbortSignal) =>
    apiClient.get("/auth/me", { schema: Me, signal, skipAuthRedirect: true }).then(rememberCsrf),
  changePassword: (body: In<typeof ChangePasswordRequest>) =>
    apiClient.post<void>("/auth/password", { body }),
  mfaEnrollStart: () => apiClient.post("/auth/mfa/enroll", { schema: MfaEnrollStart }),
  mfaEnrollConfirm: (body: In<typeof MfaEnrollConfirm>) =>
    apiClient.post<void>("/auth/mfa/enroll/confirm", { body }),
  mfaDisable: (body: In<typeof MfaVerifyRequest>) => apiClient.post<void>("/auth/mfa/disable", { body }),
};

export const usersApi = {
  list: (q: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal) =>
    apiClient.get("/users", { query: { limit: q.limit ?? 100, cursor: q.cursor }, schema: UserPage, signal }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`/users/${enc(id)}`, { schema: User, signal }),
  create: (body: In<typeof CreateUserRequest>) => apiClient.post("/users", { body, schema: User }),
  update: (id: string, body: In<typeof UpdateUserRequest>) =>
    apiClient.patch(`/users/${enc(id)}`, { body, schema: User }),
  resetPassword: (id: string, body: In<typeof ResetPasswordRequest>) =>
    apiClient.post<void>(`/users/${enc(id)}/password`, { body }),
  resetMfa: (id: string) => apiClient.post<void>(`/users/${enc(id)}/mfa/reset`),
  addRole: (id: string, body: In<typeof AddRoleBindingRequest>) =>
    apiClient.post(`/users/${enc(id)}/roles`, { body, schema: User }),
  removeRole: (id: string, bindingId: string) =>
    apiClient.delete(`/users/${enc(id)}/roles/${enc(bindingId)}`, { schema: User }),
};

export const rolesApi = {
  list: (signal?: AbortSignal) => apiClient.get("/roles", { schema: z.array(Role), signal }),
};

/** `AuditQuery` without paging (the schema's coerced fields have `unknown` input types). */
export interface AuditFilters {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: number;
  to?: number;
}

export const auditApi = {
  list: (q: AuditFilters & { limit?: number; cursor?: string }, signal?: AbortSignal) =>
    apiClient.get("/audit", { query: { ...q }, schema: AuditPage, signal }),
  verify: (signal?: AbortSignal) => apiClient.get("/audit/verify", { schema: AuditVerifyResult, signal }),
};

export const nodesApi = {
  list: (signal?: AbortSignal) => apiClient.get("/nodes", { schema: z.array(Node), signal }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`/nodes/${enc(id)}`, { schema: Node, signal }),
  update: (id: string, body: In<typeof UpdateNodeRequest>) =>
    apiClient.patch(`/nodes/${enc(id)}`, { body, schema: Node }),
  approve: (id: string) => apiClient.post(`/nodes/${enc(id)}/approve`, { schema: Node }),
  revoke: (id: string) => apiClient.post(`/nodes/${enc(id)}/revoke`, { schema: Node }),
  rotateCredentials: (id: string) => apiClient.post(`/nodes/${enc(id)}/rotate-credentials`, { schema: Node }),
  remove: (id: string) => apiClient.delete<void>(`/nodes/${enc(id)}`),
  listEnrollmentTokens: (signal?: AbortSignal) =>
    apiClient.get("/nodes/enrollment-tokens", { schema: z.array(EnrollmentToken), signal }),
  createEnrollmentToken: (body: In<typeof CreateEnrollmentTokenRequest>) =>
    apiClient.post("/nodes/enrollment-tokens", { body, schema: CreatedEnrollmentToken }),
  revokeEnrollmentToken: (id: string) => apiClient.delete<void>(`/nodes/enrollment-tokens/${enc(id)}`),
};

/** `MetricRangeQuery` with concrete types (the schema coerces strings from the URL). */
export type MetricRangeParams = Pick<z.output<typeof MetricRangeQuery>, "series" | "from" | "to"> & {
  nodeId?: string;
  serverId?: string;
  stepMs?: number;
};

export const monitoringApi = {
  overview: (signal?: AbortSignal) => apiClient.get("/overview", { schema: OverviewSummary, signal }),
  range: (q: MetricRangeParams, signal?: AbortSignal) =>
    apiClient.get("/metrics/range", { query: { ...q }, schema: MetricSeriesResult, signal }),
};

export type IncidentStatus = AlertIncident["status"];

export const alertsApi = {
  incidents: (q: { status?: IncidentStatus; limit?: number; cursor?: string | null }, signal?: AbortSignal) =>
    apiClient.get("/alerts/incidents", {
      query: { status: q.status, limit: q.limit ?? 50, cursor: q.cursor },
      schema: IncidentPage,
      signal,
    }),
  ack: (id: string) => apiClient.post(`/alerts/incidents/${enc(id)}/ack`, { schema: AlertIncident }),
  resolve: (id: string) => apiClient.post(`/alerts/incidents/${enc(id)}/resolve`, { schema: AlertIncident }),
  rules: (signal?: AbortSignal) => apiClient.get("/alerts/rules", { schema: z.array(AlertRule), signal }),
  createRule: (body: In<typeof UpsertAlertRuleRequest>) =>
    apiClient.post("/alerts/rules", { body, schema: AlertRule }),
  updateRule: (id: string, body: In<typeof UpsertAlertRuleRequest>) =>
    apiClient.put(`/alerts/rules/${enc(id)}`, { body, schema: AlertRule }),
  deleteRule: (id: string) => apiClient.delete<void>(`/alerts/rules/${enc(id)}`),
  channels: (signal?: AbortSignal) =>
    apiClient.get("/notification-channels", { schema: z.array(NotificationChannel), signal }),
  createChannel: (body: In<typeof UpsertNotificationChannelRequest>) =>
    apiClient.post("/notification-channels", { body, schema: NotificationChannel }),
  updateChannel: (id: string, body: In<typeof UpsertNotificationChannelRequest>) =>
    apiClient.put(`/notification-channels/${enc(id)}`, { body, schema: NotificationChannel }),
  deleteChannel: (id: string) => apiClient.delete<void>(`/notification-channels/${enc(id)}`),
  testChannel: (id: string) =>
    apiClient.post(`/notification-channels/${enc(id)}/test`, { schema: NotificationTestResult }),
};
