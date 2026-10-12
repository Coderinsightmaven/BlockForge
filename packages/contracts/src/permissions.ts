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
  /** Create/delete/alias the IP:port allocation pools of nodes. */
  "allocations.manage": ["global", "node"],

  /** Server templates (built-in Minecraft templates and imported eggs). */
  "templates.view": ["global"],
  /** Import/edit/delete templates. Install scripts run as root inside install containers: admin-only. */
  "templates.manage": ["global"],

  "networks.view": ["global", "network"],
  "networks.create": ["global"],
  "networks.manage": ["global", "network"],

  "servers.view": ["global", "node", "network", "server"],
  "servers.create": ["global", "node", "network"],
  /** Administrative server settings: resource limits, owner, suspension, template change. */
  "servers.admin": ["global", "node", "network"],
  "servers.delete": ["global", "node", "network", "server"],
  "servers.control": ["global", "node", "network", "server"],
  "servers.console.view": ["global", "node", "network", "server"],
  /** Operator-equivalent: arbitrary Minecraft commands (incl. /op). Grant only to trusted administrators. */
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
  "servers.backups.delete": ["global", "node", "network", "server"],
  "servers.backups.download": ["global", "node", "network", "server"],
  /** Log in to the server's files over SFTP (read access additionally needs files.read, writes files.write). */
  "servers.files.sftp": ["global", "node", "network", "server"],
  "servers.startup.view": ["global", "node", "network", "server"],
  /** Edit user-editable startup variables (values reach the container's startup shell — operator-equivalent inside the container). */
  "servers.startup.edit": ["global", "node", "network", "server"],
  /** Switch between the Docker images the template offers. */
  "servers.startup.image": ["global", "node", "network", "server"],
  "servers.allocations.view": ["global", "node", "network", "server"],
  "servers.allocations.manage": ["global", "node", "network", "server"],
  "servers.subusers.view": ["global", "node", "network", "server"],
  "servers.subusers.manage": ["global", "node", "network", "server"],
  "servers.settings.edit": ["global", "node", "network", "server"],
  "servers.reinstall": ["global", "node", "network", "server"],
  "servers.activity.view": ["global", "node", "network", "server"],
  "schedules.view": ["global", "node", "network", "server"],
  "schedules.manage": ["global", "node", "network", "server"],
} as const satisfies Record<string, readonly ScopeType[]>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
export const PermissionSchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);

const viewPermissions = ALL_PERMISSIONS.filter((p) => p.endsWith(".view"));
/** View permissions minus identity/audit data, which only user administrators should see. */
const operationalViewPermissions = viewPermissions.filter((p) => p !== "users.view" && p !== "audit.view");

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
      ...operationalViewPermissions,
      "nodes.manage",
      "nodes.enroll",
      "allocations.manage",
      "alerts.manage",
      "servers.control",
      "servers.console.view",
    ],
  },
  network_admin: {
    name: "Network Administrator",
    description: "Manages Velocity networks, proxies, routing and their servers.",
    permissions: [
      ...operationalViewPermissions,
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
      "servers.backups.delete",
      "servers.backups.download",
      "servers.files.sftp",
      "servers.startup.edit",
      "servers.startup.image",
      "servers.allocations.manage",
      "servers.subusers.manage",
      "servers.settings.edit",
      "servers.reinstall",
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
      "servers.backups.delete",
      "servers.backups.download",
      "servers.files.sftp",
      "servers.startup.view",
      "servers.startup.edit",
      "servers.startup.image",
      "servers.allocations.view",
      "servers.allocations.manage",
      "servers.subusers.view",
      "servers.subusers.manage",
      "servers.settings.edit",
      "servers.reinstall",
      "servers.activity.view",
      "schedules.view",
      "schedules.manage",
    ],
  },
  moderator: {
    name: "Moderator",
    description:
      "Watches servers and manages players through structured actions (kick, ban, whitelist); no raw console input, configuration or file access.",
    permissions: [
      "monitoring.view",
      "servers.view",
      "servers.console.view",
      "servers.players.view",
      "servers.players.manage",
    ],
  },
  observer: {
    name: "Read-only Observer",
    description: "Read-only access to dashboards, servers and infrastructure.",
    permissions: operationalViewPermissions,
  },
} as const satisfies Record<string, { name: string; description: string; permissions: readonly Permission[] }>;

export type BuiltinRoleKey = keyof typeof BUILTIN_ROLES;
/** Roles only an Owner may grant or revoke. */
export const PRIVILEGED_ROLES: readonly BuiltinRoleKey[] = ["owner", "admin"];

/** Permissions that can be held on a single server (owner/subuser/server-scoped role bindings). */
export const SERVER_SCOPED_PERMISSIONS = ALL_PERMISSIONS.filter((p) =>
  (PERMISSIONS[p] as readonly ScopeType[]).includes("server"),
);

/**
 * What a server's owner holds on that server (Pterodactyl-style ownership). Deleting a server, changing
 * its limits/owner/suspension and reading platform secrets stay with administrators.
 */
export const SERVER_OWNER_PERMISSIONS: readonly Permission[] = SERVER_SCOPED_PERMISSIONS.filter(
  (p) => !["servers.delete", "secrets.read", "secrets.manage", "alerts.manage"].includes(p),
);

/**
 * Permissions an owner (or a subuser holding `servers.subusers.manage`) may grant to a subuser. A granter
 * can only grant permissions it holds itself on that server (enforced by the control plane).
 */
export const SUBUSER_ASSIGNABLE_PERMISSIONS: readonly Permission[] = SERVER_OWNER_PERMISSIONS;

/** True if a permission may be granted at the given scope type. */
export function permissionAllowsScope(permission: Permission, scope: ScopeType): boolean {
  return (PERMISSIONS[permission] as readonly ScopeType[]).includes(scope);
}
