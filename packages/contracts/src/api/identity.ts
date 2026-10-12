import { z } from "zod";
import { DisplayName, EpochMs, Id } from "../common.js";
import { PermissionSchema, ScopeType } from "../permissions.js";

export const Email = z.email().max(254).transform((e) => e.toLowerCase());
/** Password policy: length over composition rules (NIST 800-63B). */
export const Password = z.string().min(12, "Use at least 12 characters").max(256);
export const TotpCode = z.string().regex(/^\d{6}$/);

export const SetupStatus = z.object({ setupRequired: z.boolean() });
export const SetupRequest = z.object({
  setupToken: z.string().min(16).max(128),
  email: Email,
  displayName: DisplayName,
  password: Password,
});

export const LoginRequest = z.object({ email: Email, password: z.string().min(1).max(256) });
export const MfaVerifyRequest = z.object({ code: TotpCode });

export const RoleBinding = z.object({
  id: Id,
  roleKey: z.string(),
  roleName: z.string(),
  scopeType: ScopeType,
  scopeId: Id.nullable(),
  scopeName: z.string().nullable(),
});
export type RoleBinding = z.infer<typeof RoleBinding>;

export const User = z.object({
  id: Id,
  email: z.string(),
  displayName: z.string(),
  status: z.enum(["active", "disabled"]),
  mfaEnabled: z.boolean(),
  lastLoginAt: EpochMs.nullable(),
  createdAt: EpochMs,
  roles: z.array(RoleBinding),
});
export type User = z.infer<typeof User>;

/** `GET /api/v1/auth/me` — the session's user plus effective global permissions for UI gating. */
export const Me = z.object({
  user: User,
  /** Permissions held at global scope. */
  globalPermissions: z.array(PermissionSchema),
  /** Scoped grants: the UI uses these for per-resource gating; the API enforces independently. */
  scopedPermissions: z.array(z.object({ scopeType: ScopeType, scopeId: Id, permissions: z.array(PermissionSchema) })),
  session: z.object({ mfaVerified: z.boolean(), expiresAt: EpochMs }),
  csrfToken: z.string(),
});
export type Me = z.infer<typeof Me>;

export const LoginResponse = z.object({
  status: z.enum(["ok", "mfa_required"]),
  me: Me.optional(),
});

export const MfaEnrollStart = z.object({ otpauthUrl: z.string(), secret: z.string() });
export const MfaEnrollConfirm = z.object({ code: TotpCode });

export const CreateUserRequest = z.object({
  email: Email,
  displayName: DisplayName,
  password: Password,
  roles: z.array(z.object({ roleKey: z.string(), scopeType: ScopeType, scopeId: Id.nullable() })).default([]),
});
export const UpdateUserRequest = z.object({
  displayName: DisplayName.optional(),
  status: z.enum(["active", "disabled"]).optional(),
});
export const ResetPasswordRequest = z.object({ password: Password });
export const ChangePasswordRequest = z.object({ currentPassword: z.string().min(1).max(256), newPassword: Password });
export const AddRoleBindingRequest = z.object({ roleKey: z.string(), scopeType: ScopeType, scopeId: Id.nullable() });

export const Role = z.object({
  id: Id,
  key: z.string(),
  name: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  permissions: z.array(PermissionSchema),
});
export type Role = z.infer<typeof Role>;

export const AuditEvent = z.object({
  id: z.string(),
  at: EpochMs,
  actorType: z.enum(["user", "system", "node", "api_token"]),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  outcome: z.enum(["success", "denied", "failed"]),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  action: z.string().max(100).optional(),
  actorId: z.string().max(100).optional(),
  targetType: z.string().max(50).optional(),
  targetId: z.string().max(100).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});
