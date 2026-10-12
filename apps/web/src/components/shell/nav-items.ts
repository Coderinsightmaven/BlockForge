import {
  Activity,
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

export type AppPath = "/" | "/nodes" | "/monitoring" | "/alerts" | "/users" | "/audit" | "/settings";

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
  { label: "Game Servers", icon: Gamepad2, phase: 3 },
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
  { label: "Files", icon: FolderOpen, phase: 4 },
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

export function navAvailability(item: NavItem, me: Me | null | undefined): NavAvailability {
  if (!item.to) return { kind: "phase", reason: `Available in Phase ${item.phase}` };
  if (item.permission) {
    const ok = item.globalOnly ? hasGlobal(me, item.permission) : canAny(me, item.permission);
    if (!ok) return { kind: "forbidden", reason: `Requires the ${item.permission} permission` };
  }
  return { kind: "available" };
}
