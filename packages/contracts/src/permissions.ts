import { z } from "zod";

export const ScopeType = z.enum(["global", "node", "network", "server"]);
export type ScopeType = z.infer<typeof ScopeType>;

/**
 * Every permission and the scopes at which it may be granted. A grant at a broader scope
 * implies the narrower ones: global ⊇ node ⊇ server and global ⊇ network ⊇ server.
 */
export const PERMISSIONS = {
  "settings.manage": ["global"],
  "users.view": ["global"],
  "users.manage": ["global"],
  "roles.manage": ["global"],
  "audit.view": ["global"],
  "secrets.read": ["global", "network", "server"],
  "secrets.manage": ["global", "network", "server"],
  "monitoring.view": ["global", "node", "network", "server"],
  "jobs.view": ["global", "node", "network", "server"],
  "alerts.view": ["global", "node", "network", "server"],
  "alerts.manage": ["global", "node", "network", "server"],

  "nodes.view": ["global", "node"],
  "nodes.manage": ["global", "node"],
  "nodes.enroll": ["global"],

  "networks.view": ["global", "network"],
  "networks.create": ["global"],
  "networks.manage": ["global", "network"],

  "servers.view": ["global", "node", "network", "server"],
  "servers.create": ["global", "node", "network"],
  "servers.delete": ["global", "node", "network", "server"],
  "servers.control": ["global", "node", "network", "server"],
  "servers.console.view": ["global", "node", "network", "server"],
  "servers.console.send": ["global", "node", "network", "server"],
  "servers.config.view": ["global", "node", "network", "server"],
  "servers.config.edit": ["global", "node", "network", "server"],
  "servers.files.read": ["global", "node", "network", "server"],
  "servers.files.write": ["global", "node", "network", "server"],
  "servers.extensions.manage": ["global", "node", "network", "server"],
  "servers.players.view": ["global", "node", "network", "server"],
  "servers.players.manage": ["global", "node", "network", "server"],
  "servers.backups.view": ["global", "node", "network", "server"],
  "servers.backups.create": ["global", "node", "network", "server"],
  "servers.backups.restore": ["global", "node", "network", "server"],
  "schedules.manage": ["global", "node", "network", "server"],
} as const satisfies Record<string, readonly ScopeType[]>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
export const PermissionSchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);

const viewPermissions = ALL_PERMISSIONS.filter((p) => p.endsWith(".view"));

export const BUILTIN_ROLES = {
  owner: {
    name: "Owner",
    description: "Full control of the installation, including administrators and ownership.",
    permissions: ALL_PERMISSIONS,
  },
  admin: {
    name: "Administrator",
    description: "Full control except granting or revoking Owner/Administrator roles.",
    permissions: ALL_PERMISSIONS,
  },
  infra_admin: {
    name: "Infrastructure Administrator",
    description: "Manages nodes, capacity and monitoring; can operate servers.",
    permissions: [
      ...viewPermissions,
      "nodes.manage",
      "nodes.enroll",
      "alerts.manage",
      "servers.control",
      "servers.console.view",
    ],
  },
  network_admin: {
    name: "Network Administrator",
    description: "Manages Velocity networks, proxies, routing and their servers.",
    permissions: [
      ...viewPermissions,
      "networks.create",
      "networks.manage",
      "servers.create",
      "servers.control",
      "servers.console.view",
      "servers.console.send",
      "servers.config.edit",
      "servers.files.read",
      "servers.files.write",
      "servers.extensions.manage",
      "servers.players.manage",
      "servers.backups.create",
      "servers.backups.restore",
      "schedules.manage",
      "alerts.manage",
    ],
  },
  server_admin: {
    name: "Server Administrator",
    description: "Operates and configures the servers in scope.",
    permissions: [
      "monitoring.view",
      "jobs.view",
      "alerts.view",
      "alerts.manage",
      "servers.view",
      "servers.control",
      "servers.console.view",
      "servers.console.send",
      "servers.config.view",
      "servers.config.edit",
      "servers.files.read",
      "servers.files.write",
      "servers.extensions.manage",
      "servers.players.view",
      "servers.players.manage",
      "servers.backups.view",
      "servers.backups.create",
      "servers.backups.restore",
      "schedules.manage",
    ],
  },
  moderator: {
    name: "Moderator",
    description: "Watches servers and manages players; no configuration or file access.",
    permissions: [
      "monitoring.view",
      "servers.view",
      "servers.console.view",
      "servers.console.send",
      "servers.players.view",
      "servers.players.manage",
    ],
  },
  observer: {
    name: "Read-only Observer",
    description: "Read-only access to dashboards, servers and infrastructure.",
    permissions: viewPermissions.filter((p) => p !== "users.view" && p !== "audit.view"),
  },
} as const satisfies Record<string, { name: string; description: string; permissions: readonly Permission[] }>;

export type BuiltinRoleKey = keyof typeof BUILTIN_ROLES;
/** Roles only an Owner may grant or revoke. */
export const PRIVILEGED_ROLES: readonly BuiltinRoleKey[] = ["owner", "admin"];

/** True if a permission may be granted at the given scope type. */
export function permissionAllowsScope(permission: Permission, scope: ScopeType): boolean {
  return (PERMISSIONS[permission] as readonly ScopeType[]).includes(scope);
}
