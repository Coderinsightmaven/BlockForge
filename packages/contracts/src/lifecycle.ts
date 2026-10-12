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
  stopped: ["starting", "updating", "backing_up", "restoring", "migrating", "deleting", "unreachable", "running"],
  crashed: ["starting", "stopped", "updating", "backing_up", "restoring", "migrating", "deleting", "unreachable"],
  updating: ["stopped", "starting", "crashed"],
  backing_up: ["running", "degraded", "stopped", "crashed"],
  restoring: ["stopped", "starting", "crashed"],
  migrating: ["stopped", "starting", "crashed"],
  unreachable: ["running", "degraded", "starting", "stopping", "stopped", "crashed"],
  deleting: ["stopped", "crashed"],
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
  "start",
  "stop",
  "restart",
  "kill",
  "update",
  "backup",
  "restore",
  "migrate",
  "delete",
]);
export type ServerOperation = z.infer<typeof ServerOperation>;

/** Source states from which a user-initiated operation may begin. */
export const OPERATION_ALLOWED_FROM: Record<ServerOperation, readonly ServerState[]> = {
  provision: ["provision_failed"],
  start: ["stopped", "crashed"],
  stop: ["starting", "running", "degraded"],
  restart: ["running", "degraded", "crashed"],
  kill: ["starting", "running", "degraded", "stopping"],
  update: ["stopped", "crashed", "running", "degraded"],
  backup: ["running", "degraded", "stopped", "crashed"],
  restore: ["stopped", "crashed"],
  migrate: ["stopped", "crashed"],
  delete: ["stopped", "crashed", "provision_failed"],
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
