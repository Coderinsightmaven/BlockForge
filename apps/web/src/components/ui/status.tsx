import {
  ArchiveRestore,
  ArrowDownToLine,
  Ban,
  BadgeCheck,
  Bell,
  CircleArrowUp,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CirclePlay,
  CircleStop,
  CircleX,
  Clock,
  DatabaseBackup,
  Eye,
  Hourglass,
  Info,
  MoveRight,
  OctagonX,
  PackagePlus,
  PackageX,
  RefreshCw,
  ShieldOff,
  Siren,
  Trash2,
  TriangleAlert,
  Unplug,
  UserCheck,
  UserX,
  Wifi,
  WifiOff,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NodeConnection, NodeStatus, ServerState } from "@blockforge/contracts";
import { cn } from "@/lib/utils";
import { Badge, toneClass } from "./badge";
import type { Tone } from "./badge";

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  /** Short explanation shown in tooltips. */
  description: string;
}

export const SERVER_STATE_META: Record<ServerState, StatusMeta> = {
  provisioning: {
    label: "Provisioning",
    tone: "info",
    icon: PackagePlus,
    description: "The server environment is being created.",
  },
  provision_failed: {
    label: "Provision failed",
    tone: "danger",
    icon: PackageX,
    description: "Provisioning did not complete; see the job log.",
  },
  starting: {
    label: "Starting",
    tone: "info",
    icon: CirclePlay,
    description: "The process is booting and not yet accepting players.",
  },
  running: {
    label: "Running",
    tone: "success",
    icon: CircleCheck,
    description: "Running and passing health checks.",
  },
  degraded: {
    label: "Degraded",
    tone: "warning",
    icon: TriangleAlert,
    description: "Running, but health checks report problems.",
  },
  stopping: { label: "Stopping", tone: "info", icon: CirclePause, description: "Shutting down gracefully." },
  stopped: { label: "Stopped", tone: "neutral", icon: CircleStop, description: "Not running." },
  crashed: {
    label: "Crashed",
    tone: "danger",
    icon: OctagonX,
    description: "The process exited unexpectedly.",
  },
  updating: {
    label: "Updating",
    tone: "info",
    icon: CircleArrowUp,
    description: "Server software is being updated.",
  },
  backing_up: {
    label: "Backing up",
    tone: "info",
    icon: DatabaseBackup,
    description: "A backup is in progress.",
  },
  restoring: {
    label: "Restoring",
    tone: "info",
    icon: ArchiveRestore,
    description: "A backup is being restored.",
  },
  migrating: { label: "Migrating", tone: "info", icon: MoveRight, description: "Moving to another node." },
  unreachable: {
    label: "Unreachable",
    tone: "danger",
    icon: Unplug,
    description: "Its node is not reporting, so the real state is unknown.",
  },
  deleting: { label: "Deleting", tone: "warning", icon: Trash2, description: "The server is being removed." },
};

export const NODE_CONNECTION_META: Record<NodeConnection, StatusMeta> = {
  online: {
    label: "Online",
    tone: "success",
    icon: Wifi,
    description: "Agent connected and heartbeats are current.",
  },
  degraded: {
    label: "Degraded",
    tone: "warning",
    icon: TriangleAlert,
    description: "Agent connected but heartbeats are late or health checks fail.",
  },
  unreachable: {
    label: "Unreachable",
    tone: "danger",
    icon: Unplug,
    description: "The agent stopped responding unexpectedly.",
  },
  offline: {
    label: "Offline",
    tone: "neutral",
    icon: WifiOff,
    description: "No agent session (never connected, or disconnected cleanly).",
  },
};

export const NODE_STATUS_META: Record<NodeStatus, StatusMeta> = {
  pending: {
    label: "Pending approval",
    tone: "warning",
    icon: Hourglass,
    description: "Enrolled; an administrator must approve it before it is used.",
  },
  active: { label: "Active", tone: "success", icon: BadgeCheck, description: "Available for workloads." },
  draining: {
    label: "Draining",
    tone: "info",
    icon: ArrowDownToLine,
    description: "No new workloads; existing ones are being moved off.",
  },
  maintenance: {
    label: "Maintenance",
    tone: "warning",
    icon: Wrench,
    description: "In maintenance; no new workloads are placed here.",
  },
  disabled: { label: "Disabled", tone: "neutral", icon: Ban, description: "Disabled by an administrator." },
  revoked: {
    label: "Revoked",
    tone: "danger",
    icon: ShieldOff,
    description: "Credentials revoked; the agent can no longer connect.",
  },
};

export type AlertSeverityValue = "info" | "warning" | "critical";
export const ALERT_SEVERITY_META: Record<AlertSeverityValue, StatusMeta> = {
  info: { label: "Info", tone: "info", icon: Info, description: "Informational." },
  warning: { label: "Warning", tone: "warning", icon: TriangleAlert, description: "Needs attention soon." },
  critical: { label: "Critical", tone: "danger", icon: Siren, description: "Needs attention now." },
};

export type IncidentStatusValue = "firing" | "acknowledged" | "resolved";
export const INCIDENT_STATUS_META: Record<IncidentStatusValue, StatusMeta> = {
  firing: {
    label: "Firing",
    tone: "danger",
    icon: Bell,
    description: "The condition is active and nobody has acknowledged it.",
  },
  acknowledged: {
    label: "Acknowledged",
    tone: "warning",
    icon: Eye,
    description: "Someone is looking at it.",
  },
  resolved: {
    label: "Resolved",
    tone: "success",
    icon: CircleCheck,
    description: "The condition cleared or was resolved manually.",
  },
};

export type JobStatusValue = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const JOB_STATUS_META: Record<JobStatusValue, StatusMeta> = {
  queued: { label: "Queued", tone: "neutral", icon: Clock, description: "Waiting to run." },
  running: { label: "Running", tone: "info", icon: RefreshCw, description: "In progress." },
  succeeded: {
    label: "Succeeded",
    tone: "success",
    icon: CircleCheck,
    description: "Completed successfully.",
  },
  failed: { label: "Failed", tone: "danger", icon: CircleX, description: "Did not complete." },
  cancelled: { label: "Cancelled", tone: "neutral", icon: Ban, description: "Cancelled before completion." },
};

export type AuditOutcomeValue = "success" | "denied" | "failed";
export const AUDIT_OUTCOME_META: Record<AuditOutcomeValue, StatusMeta> = {
  success: { label: "Success", tone: "success", icon: CircleCheck, description: "The action was performed." },
  denied: { label: "Denied", tone: "warning", icon: ShieldOff, description: "Rejected by authorisation." },
  failed: { label: "Failed", tone: "danger", icon: CircleX, description: "Attempted but failed." },
};

export type UserStatusValue = "active" | "disabled";
export const USER_STATUS_META: Record<UserStatusValue, StatusMeta> = {
  active: { label: "Active", tone: "success", icon: UserCheck, description: "Can sign in." },
  disabled: { label: "Disabled", tone: "neutral", icon: UserX, description: "Cannot sign in." },
};

export const UNKNOWN_STATUS: StatusMeta = {
  label: "Unknown",
  tone: "neutral",
  icon: CircleDashed,
  description: "This status is not known to this version of the web app.",
};

/** Look up a status, tolerating values newer than this build. */
export function statusMeta<K extends string>(map: Record<K, StatusMeta>, value: string): StatusMeta {
  return Object.hasOwn(map, value) ? map[value as K] : { ...UNKNOWN_STATUS, label: value };
}

/** Badge with icon + label + tooltip-ready title; never colour alone. */
export function StatusBadge({
  meta,
  className,
  title,
}: {
  meta: StatusMeta;
  className?: string;
  title?: string;
}) {
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} className={className} title={title ?? meta.description}>
      <Icon aria-hidden />
      {meta.label}
    </Badge>
  );
}

export function ServerStateBadge({ state, className }: { state: ServerState; className?: string }) {
  return <StatusBadge meta={statusMeta(SERVER_STATE_META, state)} className={className} />;
}

export function NodeConnectionBadge({
  connection,
  className,
}: {
  connection: NodeConnection;
  className?: string;
}) {
  return <StatusBadge meta={statusMeta(NODE_CONNECTION_META, connection)} className={className} />;
}

export function NodeStatusBadge({ status, className }: { status: NodeStatus; className?: string }) {
  return <StatusBadge meta={statusMeta(NODE_STATUS_META, status)} className={className} />;
}

/** Compact dot + label, for dense rows. */
export function StatusDot({
  meta,
  className,
  hideLabel,
}: {
  meta: StatusMeta;
  className?: string;
  hideLabel?: boolean;
}) {
  const Icon = meta.icon;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs", toneClass[meta.tone], className)}
      title={meta.description}
    >
      <Icon className="size-3.5 shrink-0 text-tone" aria-hidden />
      <span className={hideLabel ? "sr-only" : undefined}>{meta.label}</span>
    </span>
  );
}
