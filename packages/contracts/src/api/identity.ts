import { z } from "zod";
import { DisplayName, EpochMs, Id } from "../common.js";
import { PermissionSchema, ScopeType } from "../permissions.js";

export const Email = z.email().max(254).transform((e) => e.toLowerCase());
/** Password policy: length over composition rules (NIST 800-63B). */
export const Password = z.string().min(12, "Use at least 12 characters").max(256);
export const TotpCode = z.string().regex(/^\d{6}$/);
/** Login-independent handle used in SFTP usernames (`<username>.<serverShortId>`) and subuser lookup. */
export const Username = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/, "3–32 lowercase letters, digits, '-' or '_'")
  .transform((u) => u.toLowerCase());

export const SetupStatus = z.object({ setupRequired: z.boolean() });
export const SetupRequest = z.object({
  setupToken: z.string().min(16).max(128),
  email: Email,
  /** Derived from the email's local part when omitted. */
  username: Username.optional(),
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
  username: z.string(),
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
  username: Username,
  displayName: DisplayName,
  password: Password,
  roles: z.array(z.object({ roleKey: z.string(), scopeType: ScopeType, scopeId: Id.nullable() })).default([]),
});
export const UpdateUserRequest = z.object({
  displayName: DisplayName.optional(),
  username: Username.optional(),
  status: z.enum(["active", "disabled"]).optional(),
});
export const ResetPasswordRequest = z.object({ password: Password });
export const ChangePasswordRequest = z.object({ currentPassword: z.string().min(1).max(256), newPassword: Password });
export const AddRoleBindingRequest = z.object({ roleKey: z.string(), scopeType: ScopeType, scopeId: Id.nullable() });

/** SSH public keys for SFTP (`/account/ssh-keys`). Only ed25519, ecdsa-sha2-nistp256/384/521 and rsa ≥ 3072 bits. */
export const SshKey = z.object({
  id: Id,
  name: z.string(),
  keyType: z.string(),
  /** OpenSSH-style `SHA256:<base64>` fingerprint. */
  fingerprint: z.string(),
  createdAt: EpochMs,
  lastUsedAt: EpochMs.nullable(),
});
export type SshKey = z.infer<typeof SshKey>;
export const CreateSshKeyRequest = z.object({
  name: z.string().trim().min(1).max(80),
  publicKey: z.string().min(16).max(16 * 1024),
});

/**
 * Personal API keys (`/account/api-keys`). `Authorization: Bearer bfk_<id>_<secret>`; no cookies, no CSRF.
 * Effective permissions = the owner's current effective permissions ∩ `permissions` (null = all of them),
 * evaluated per resource: listing a server-scoped permission (e.g. `servers.files.read`) lets the key use
 * it on every server where the owner holds it (via role, ownership or subuser grant). At creation a key may
 * list any permission the owner holds anywhere (globally, scoped, as owner or as subuser).
 * re-evaluated on every request. Keys can never manage users, roles, API keys, SSH keys, passwords or MFA,
 * and requests from outside `allowedIps` are refused. Rate-limited per key. Audited as actor `api_token`.
 */
export const API_KEY_PATTERN = /^bfk_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
export const ApiKey = z.object({
  id: Id,
  name: z.string(),
  /** `bfk_<id>` — shown so users can recognise keys; the secret is never retrievable. */
  prefix: z.string(),
  permissions: z.array(PermissionSchema).nullable(),
  /** CIDR list; empty = any address. */
  allowedIps: z.array(z.string()),
  expiresAt: EpochMs.nullable(),
  lastUsedAt: EpochMs.nullable(),
  lastUsedIp: z.string().nullable(),
  createdAt: EpochMs,
});
export type ApiKey = z.infer<typeof ApiKey>;
export const CreateApiKeyRequest = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(PermissionSchema).min(1).nullable().default(null),
  allowedIps: z
    .array(z.string().regex(/^[0-9a-fA-F.:]+(\/\d{1,3})?$/, "IP or CIDR"))
    .max(32)
    .default([]),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
});
/**
 * `GET /account/permissions` (session or API key): everything the user currently holds, so UIs (API key
 * picker, subuser grant matrix) offer only grantable permissions. `servers` lists effective permissions
 * from ownership and subuser grants per server (role-derived server permissions are covered by `scoped`).
 */
export const AccountPermissions = z.object({
  global: z.array(PermissionSchema),
  scoped: z.array(z.object({ scopeType: ScopeType, scopeId: Id, permissions: z.array(PermissionSchema) })),
  servers: z.array(z.object({ serverId: Id, serverName: z.string(), via: z.enum(["owner", "subuser"]), permissions: z.array(PermissionSchema) })),
});
export type AccountPermissions = z.infer<typeof AccountPermissions>;

/** Returned once at creation. */
export const CreatedApiKey = z.object({ key: ApiKey, secret: z.string() });
/** Permissions an API key can never exercise, regardless of grants. */
export const API_KEY_FORBIDDEN_PERMISSIONS = ["users.manage", "roles.manage", "settings.manage"] as const;

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
