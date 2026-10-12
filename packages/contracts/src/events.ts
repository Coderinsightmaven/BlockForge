/**
 * Durable domain events (persisted in the `events` table before being fanned out).
 * Delivery: at-least-once to in-process subscribers; consumers must be idempotent.
 * Heartbeats are intentionally *not* persisted (`node.heartbeat.received` is in-memory only).
 */
export const DOMAIN_EVENTS = [
  "node.enrolled",
  "node.approved",
  "node.revoked",
  "node.connection.changed",
  "node.heartbeat.received",
  "server.created",
  "server.provision.requested",
  "server.provision.completed",
  "server.provision.failed",
  "server.state.changed",
  "server.crashed",
  "server.config.changed",
  "server.installed",
  "server.install.failed",
  "server.suspended",
  "server.unsuspended",
  "server.deleted",
  "network.configuration.validated",
  "network.configuration.applied",
  "backup.started",
  "backup.completed",
  "backup.failed",
  "backup.restored",
  "schedule.run.completed",
  "schedule.run.failed",
  "migration.completed",
  "alert.fired",
  "alert.resolved",
  "job.updated",
] as const;
export type DomainEventType = (typeof DOMAIN_EVENTS)[number];

export const EPHEMERAL_EVENTS: readonly DomainEventType[] = ["node.heartbeat.received"];
