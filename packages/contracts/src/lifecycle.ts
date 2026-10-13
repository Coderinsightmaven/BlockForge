import { z } from "zod";

export const ServerState = z.enum([
  "provisioning",
  "provision_failed",
  "starting",
  "running",
  "degraded",
  "stopping",
  "stopped",
  "crashed",
  "updating",
  "backing_up",
  "restoring",
  "migrating",
  "unreachable",
  "deleting",
]);
export type ServerState = z.infer<typeof ServerState>;

export const DesiredState = z.enum(["running", "stopped"]);
export type DesiredState = z.infer<typeof DesiredState>;

/** Allowed state transitions. Anything not listed is rejected by the control plane. */
export const SERVER_TRANSITIONS: Record<ServerState, readonly ServerState[]> = {
  provisioning: ["starting", "stopped", "provision_failed", "deleting", "unreachable"],
  provision_failed: ["provisioning", "deleting"],
  starting: ["running", "degraded", "crashed", "stopping", "stopped", "unreachable"],
  running: ["stopping", "degraded", "crashed", "backing_up", "updating", "unreachable", "stopped"],
  degraded: ["running", "stopping", "crashed", "backing_up", "unreachable", "stopped"],
  stopping: ["stopped", "crashed", "unreachable"],
  stopped: ["starting", "updating", "backing_up", "restoring", "migrating", "deleting", "unreachable", "running", "provisioning"],
  crashed: ["starting", "stopped", "updating", "backing_up", "restoring", "migrating", "deleting", "unreachable", "provisioning"],
  updating: ["stopped", "starting", "crashed", "unreachable"],
  backing_up: ["running", "degraded", "stopped", "crashed", "unreachable"],
  restoring: ["stopped", "starting", "crashed", "unreachable"],
  migrating: ["stopped", "starting", "crashed", "unreachable"],
  unreachable: ["running", "degraded", "starting", "stopping", "stopped", "crashed"],
  deleting: ["stopped", "crashed", "unreachable"],
};

export function canTransition(from: ServerState, to: ServerState): boolean {
  return from === to || SERVER_TRANSITIONS[from].includes(to);
}

/** States in which an operation is in flight; new conflicting operations are rejected. */
export const TRANSITIONAL_STATES: readonly ServerState[] = [
  "provisioning",
  "starting",
  "stopping",
  "updating",
  "backing_up",
  "restoring",
  "migrating",
  "deleting",
];

export const ServerOperation = z.enum([
  "provision",
  "reinstall",
  "start",
  "stop",
  "restart",
  "kill",
  "update",
  "backup",
  "restore",
  "migrate",
  "delete",
  /**
   * Plugin/mod changes (install, update, rollback, remove, enable/disable, upload) hold the operation lock
   * while they touch the server's files, without changing the lifecycle state.
   */
  "extensions",
]);
export type ServerOperation = z.infer<typeof ServerOperation>;

/** Source states from which a user-initiated operation may begin. */
export const OPERATION_ALLOWED_FROM: Record<ServerOperation, readonly ServerState[]> = {
  provision: ["provision_failed"],
  /** Re-runs the install step (egg install script / artifact download) and config generation. */
  reinstall: ["stopped", "crashed", "provision_failed"],
  start: ["stopped", "crashed"],
  stop: ["starting", "running", "degraded"],
  restart: ["running", "degraded", "crashed"],
  kill: ["starting", "running", "degraded", "stopping"],
  update: ["stopped", "crashed", "running", "degraded"],
  backup: ["running", "degraded", "stopped", "crashed"],
  /** From running/degraded the restore job stops the server first (stopping → stopped → restoring). */
  restore: ["stopped", "crashed", "running", "degraded"],
  migrate: ["stopped", "crashed"],
  /** `provisioning` only once its job is no longer active (e.g. an abandoned provision). */
  delete: ["stopped", "crashed", "provision_failed", "provisioning", "unreachable"],
  /** No state change: the server keeps running (changes take effect at the next start). */
  extensions: ["stopped", "crashed", "running", "degraded"],
};

export function canStartOperation(
  op: ServerOperation,
  state: ServerState,
  activeOperation: ServerOperation | null,
): boolean {
  // `kill` is the escape hatch and may pre-empt a stuck stop.
  if (activeOperation && !(op === "kill" && activeOperation === "stop")) return false;
  return OPERATION_ALLOWED_FROM[op].includes(state);
}

/** Node connectivity as derived by the control plane from agent sessions and heartbeats. */
export const NodeConnection = z.enum(["online", "degraded", "unreachable", "offline"]);
export type NodeConnection = z.infer<typeof NodeConnection>;

/** Administrative node status. */
export const NodeStatus = z.enum(["pending", "active", "draining", "maintenance", "disabled", "revoked"]);
export type NodeStatus = z.infer<typeof NodeStatus>;
