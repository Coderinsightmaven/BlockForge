import {
  Activity,
  FileJson,
  Archive,
  Bell,
  CalendarClock,
  FolderOpen,
  Gamepad2,
  LayoutDashboard,
  Network,
  Puzzle,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Users,
  Waypoints,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Me, Permission } from "@blockforge/contracts";
import { canAny, hasGlobal } from "@/lib/permissions";

export type AppPath =
  | "/"
  | "/servers"
  | "/nodes"
  | "/monitoring"
  | "/alerts"
  | "/users"
  | "/audit"
  | "/settings"
  | "/admin/templates";

export interface NavItem {
  label: string;
  icon: LucideIcon;
  /** Present for sections that exist in this build. */
  to?: AppPath;
  /** Implementation phase for sections whose backend has not landed yet. */
  phase?: number;
  permission?: Permission;
  /** Permission must be global (not just scoped somewhere). */
  globalOnly?: boolean;
  /** Lives inside each server's page; the entry explains where instead of linking. */
  perServer?: string;
  keywords?: string[];
}

/** The 15 sections from spec §4, in order. */
export const NAV_ITEMS: NavItem[] = [
  {
    label: "Overview",
    icon: LayoutDashboard,
    to: "/",
    permission: "monitoring.view",
    keywords: ["dashboard", "home"],
  },
  // Everyone signed in has a server list (owned / shared servers); the API filters it.
  {
    label: "Game Servers",
    icon: Gamepad2,
    to: "/servers",
    keywords: ["servers", "minecraft", "console", "games"],
  },
  { label: "Server Networks", icon: Network, phase: 5 },
  { label: "Proxies", icon: Waypoints, phase: 5 },
  {
    label: "Nodes & Infrastructure",
    icon: Server,
    to: "/nodes",
    permission: "nodes.view",
    keywords: ["machines", "hosts", "agents"],
  },
  {
    label: "Monitoring",
    icon: Activity,
    to: "/monitoring",
    permission: "monitoring.view",
    keywords: ["metrics", "charts"],
  },
  { label: "Players", icon: Users, phase: 4 },
  { label: "Plugins & Mods", icon: Puzzle, phase: 4 },
  { label: "Files", icon: FolderOpen, perServer: "Open a server's Files tab" },
  { label: "Backups", icon: Archive, phase: 6 },
  { label: "Schedules & Tasks", icon: CalendarClock, phase: 4 },
  {
    label: "Alerts",
    icon: Bell,
    to: "/alerts",
    permission: "alerts.view",
    keywords: ["incidents", "notifications", "rules"],
  },
  {
    label: "Users & Permissions",
    icon: ShieldCheck,
    to: "/users",
    permission: "users.view",
    globalOnly: true,
    keywords: ["roles", "rbac", "accounts"],
  },
  {
    label: "Audit Logs",
    icon: ScrollText,
    to: "/audit",
    permission: "audit.view",
    globalOnly: true,
    keywords: ["history", "events"],
  },
  { label: "Settings", icon: Settings, to: "/settings", keywords: ["account", "password", "mfa", "theme"] },
];

export type NavAvailability =
  { kind: "available" } | { kind: "phase"; reason: string } | { kind: "forbidden"; reason: string };

/** Administration entries shown below the main sections when permitted. */
export const ADMIN_NAV_ITEMS: NavItem[] = [
  {
    label: "Templates",
    icon: FileJson,
    to: "/admin/templates",
    permission: "templates.view",
    globalOnly: true,
    keywords: ["eggs", "nests", "import", "games"],
  },
];

export function navAvailability(item: NavItem, me: Me | null | undefined): NavAvailability {
  if (item.perServer) return { kind: "phase", reason: item.perServer };
  if (!item.to) return { kind: "phase", reason: `Available in Phase ${item.phase}` };
  if (item.permission) {
    const ok = item.globalOnly ? hasGlobal(me, item.permission) : canAny(me, item.permission);
    if (!ok) return { kind: "forbidden", reason: `Requires the ${item.permission} permission` };
  }
  return { kind: "available" };
}
