import { SUBUSER_ASSIGNABLE_PERMISSIONS } from "@blockforge/contracts";
import type { Me, Permission, Server } from "@blockforge/contracts";
import { canAny, hasGlobal } from "./permissions";

/*
 * Server-level gating uses `Server.myPermissions` — the effective set the control plane computed
 * (role bindings ∪ ownership ∪ subuser grants). The UI only hides/disables; the API enforces.
 */

export function serverCan(
  server: Pick<Server, "myPermissions"> | null | undefined,
  permission: Permission,
): boolean {
  return !!server && server.myPermissions.includes(permission);
}

/** Suspended servers can only be acted on by `servers.admin` holders (viewing stays allowed). */
export function serverActionable(
  server: Pick<Server, "myPermissions" | "suspended">,
  permission: Permission,
): boolean {
  if (!serverCan(server, permission)) return false;
  return !server.suspended || serverCan(server, "servers.admin");
}

export type ServerTab =
  "console" | "stats" | "files" | "startup" | "network" | "users" | "activity" | "settings";

export interface ServerTabDef {
  id: ServerTab;
  label: string;
  /** Shown when the user holds any of these. */
  anyOf: Permission[];
}

export const SERVER_TABS: ServerTabDef[] = [
  { id: "console", label: "Console", anyOf: ["servers.console.view"] },
  { id: "stats", label: "Stats", anyOf: ["monitoring.view"] },
  { id: "files", label: "Files", anyOf: ["servers.files.read"] },
  { id: "startup", label: "Startup", anyOf: ["servers.startup.view"] },
  { id: "network", label: "Network", anyOf: ["servers.allocations.view"] },
  { id: "users", label: "Users", anyOf: ["servers.subusers.view"] },
  { id: "activity", label: "Activity", anyOf: ["servers.activity.view"] },
  {
    id: "settings",
    label: "Settings",
    anyOf: [
      "servers.settings.edit",
      "servers.files.sftp",
      "servers.reinstall",
      "servers.admin",
      "servers.delete",
    ],
  },
];

export function visibleServerTabs(server: Pick<Server, "myPermissions"> | null | undefined): ServerTabDef[] {
  return SERVER_TABS.filter((t) => t.anyOf.some((p) => serverCan(server, p)));
}

/** The requested tab if visible, else the first visible one (or null when nothing is). */
export function resolveServerTab(
  server: Pick<Server, "myPermissions">,
  requested: ServerTab | undefined,
): ServerTab | null {
  const tabs = visibleServerTabs(server);
  if (requested && tabs.some((t) => t.id === requested)) return requested;
  return tabs[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Subuser permissions (Pterodactyl-style grouping)

export interface PermissionInfo {
  permission: Permission;
  label: string;
  description: string;
}
export interface PermissionGroup {
  id: string;
  label: string;
  permissions: PermissionInfo[];
  /** The panel has no page for this yet (the permission still applies to the API). */
  uiPhase?: number;
}

const P = (permission: Permission, label: string, description: string): PermissionInfo => ({
  permission,
  label,
  description,
});

/** Every permission in `SUBUSER_ASSIGNABLE_PERMISSIONS` appears in exactly one group (tested). */
export const SUBUSER_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "console",
    label: "Console",
    permissions: [
      P("servers.console.view", "View", "Read the live console and its history."),
      P("servers.console.send", "Send commands", "Run any console command — equivalent to server operator."),
    ],
  },
  {
    id: "power",
    label: "Power",
    permissions: [P("servers.control", "Start, stop, restart, kill", "Change the server's power state.")],
  },
  {
    id: "files",
    label: "Files",
    permissions: [
      P("servers.files.read", "Read & download", "List, open and download files."),
      P(
        "servers.files.write",
        "Create, edit & delete",
        "Upload, edit, rename, delete, archive and extract files.",
      ),
      P(
        "servers.files.sftp",
        "SFTP access",
        "Connect over SFTP (still limited by the read/write permissions).",
      ),
    ],
  },
  {
    id: "config",
    label: "Configuration",
    uiPhase: 4,
    permissions: [
      P("servers.config.view", "View config", "Read managed configuration files such as server.properties."),
      P("servers.config.edit", "Edit config", "Change managed configuration files (with revision history)."),
    ],
  },
  {
    id: "backups",
    label: "Backups",
    uiPhase: 6,
    permissions: [
      P("servers.backups.view", "View", "See backups."),
      P("servers.backups.create", "Create", "Create backups."),
      P("servers.backups.restore", "Restore", "Restore a backup over the current files."),
      P("servers.backups.download", "Download", "Download backup archives."),
      P("servers.backups.delete", "Delete", "Delete backups."),
    ],
  },
  {
    id: "allocations",
    label: "Network",
    permissions: [
      P("servers.allocations.view", "View allocations", "See the server's IP:port allocations."),
      P(
        "servers.allocations.manage",
        "Manage allocations",
        "Add, remove, annotate and set the primary allocation.",
      ),
    ],
  },
  {
    id: "startup",
    label: "Startup",
    permissions: [
      P("servers.startup.view", "View", "See startup variables and the startup command."),
      P(
        "servers.startup.edit",
        "Edit variables",
        "Change editable startup variables (runs inside the container).",
      ),
      P("servers.startup.image", "Change image", "Switch between the template's Docker images."),
    ],
  },
  {
    id: "users",
    label: "Users",
    permissions: [
      P("servers.subusers.view", "View", "See who has access to this server."),
      P(
        "servers.subusers.manage",
        "Manage",
        "Add, edit and remove users (only permissions they hold themselves).",
      ),
    ],
  },
  {
    id: "schedules",
    label: "Schedules",
    uiPhase: 4,
    permissions: [
      P("schedules.view", "View", "See scheduled tasks."),
      P("schedules.manage", "Manage", "Create, edit and run scheduled tasks."),
    ],
  },
  {
    id: "settings",
    label: "Settings",
    permissions: [
      P("servers.settings.edit", "Rename & describe", "Change the server's name and description."),
      P("servers.reinstall", "Reinstall", "Re-run the install step (may overwrite files)."),
    ],
  },
  {
    id: "activity",
    label: "Activity",
    permissions: [P("servers.activity.view", "View activity", "Read this server's activity log.")],
  },
  {
    id: "players",
    label: "Players",
    uiPhase: 4,
    permissions: [
      P("servers.players.view", "View players", "See online players and player history."),
      P("servers.players.manage", "Manage players", "Kick, ban, whitelist and op players."),
    ],
  },
  {
    id: "extensions",
    label: "Plugins & mods",
    uiPhase: 4,
    permissions: [P("servers.extensions.manage", "Manage", "Install, update and remove plugins and mods.")],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    permissions: [
      P("servers.view", "View server", "See the server in the list (always granted)."),
      P("monitoring.view", "Stats", "See resource usage and history charts."),
      P("jobs.view", "Jobs", "See install and power job progress."),
      P("alerts.view", "Alerts", "See alert incidents for this server."),
    ],
  },
];

/** Every subuser needs to see the server. */
export const BASE_SUBUSER_PERMISSIONS: readonly Permission[] = ["servers.view"];

/** Starting selection for a new subuser: console view (if the granter may grant it) + servers.view. */
export function defaultSubuserGrant(granterPermissions: readonly Permission[]): Permission[] {
  return normalizeGrant(["servers.console.view"], granterPermissions);
}

/**
 * What the granter may hand out: assignable permissions they hold themselves on this server
 * (the control plane enforces the same rule).
 */
export function grantablePermissions(granterPermissions: readonly Permission[]): Set<Permission> {
  const held = new Set(granterPermissions);
  return new Set(SUBUSER_ASSIGNABLE_PERMISSIONS.filter((p) => held.has(p)));
}

/**
 * Normalise a subuser permission selection before sending it. Matches the contract's
 * granter-relative update rule — effective = (old ∖ granterHeld) ∪ (requested ∩ granterHeld):
 *  - only assignable permissions;
 *  - permissions the granter does not hold are sent back exactly as the subuser has them
 *    (the granter can neither add nor remove them);
 *  - `servers.view` is always included.
 */
export function normalizeGrant(
  selected: Iterable<Permission>,
  granterPermissions: readonly Permission[],
  existing: readonly Permission[] = [],
): Permission[] {
  const grantable = grantablePermissions(granterPermissions);
  const assignable = new Set<Permission>(SUBUSER_ASSIGNABLE_PERMISSIONS);
  const had = new Set(existing);
  const out = new Set<Permission>(BASE_SUBUSER_PERMISSIONS);
  for (const p of selected) {
    if (!assignable.has(p)) continue;
    if (grantable.has(p) || had.has(p)) out.add(p);
  }
  // Permissions the granter cannot touch are kept exactly as they were.
  for (const p of existing) if (assignable.has(p) && !grantable.has(p)) out.add(p);
  return SUBUSER_ASSIGNABLE_PERMISSIONS.filter((p) => out.has(p));
}

// ---------------------------------------------------------------------------------------------
// Global (non-server) capabilities used by the servers area

/** Admins (global servers.view) can switch the dashboard to "all servers". */
export function canSeeAllServers(me: Me | null | undefined): boolean {
  return hasGlobal(me, "servers.view") || hasGlobal(me, "servers.admin");
}

export function canCreateServers(me: Me | null | undefined): boolean {
  return canAny(me, "servers.create");
}
