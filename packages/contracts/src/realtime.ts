import { z } from "zod";
import { EpochMs } from "./common.js";
import { NodeMetricSample, WorkloadMetricSample } from "./agent/metrics.js";
import { Node } from "./api/nodes.js";
import { AlertIncident, Job, JobLogLine, OverviewSummary } from "./api/operations.js";
import { Server } from "./api/servers.js";
import { Backup } from "./api/backups.js";
import { Schedule } from "./api/schedules.js";
import { ExtensionsUpdatedEvent } from "./api/extensions.js";
import { PlayerJoinedEvent, PlayerLeftEvent } from "./api/players.js";

/**
 * UI realtime channel: WSS /api/v1/realtime (session cookie auth; Origin checked).
 * Topics are authorised per subscription; the realtime stream is a convenience — durable
 * state is always re-read over REST after reconnecting.
 */
export const TOPIC_PATTERNS = {
  overview: /^overview$/,
  nodes: /^nodes$/,
  node: /^node:[0-9a-f-]{36}$/,
  servers: /^servers$/,
  server: /^server:[0-9a-f-]{36}$/,
  console: /^console:[0-9a-f-]{36}$/,
  job: /^job:[0-9a-f-]{36}$/,
  network: /^network:[0-9a-f-]{36}$/,
  alerts: /^alerts$/,
} as const;

export const Topic = z
  .string()
  .max(64)
  .refine((t) => Object.values(TOPIC_PATTERNS).some((re) => re.test(t)), "unknown topic");

export const ClientFrame = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), topic: Topic }),
  z.object({ op: z.literal("unsubscribe"), topic: Topic }),
  z.object({ op: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const RealtimeEventType = z.enum([
  "overview.updated",
  "node.updated",
  "node.metrics",
  "server.updated",
  "server.metrics",
  "console.lines",
  "job.updated",
  "job.log",
  "alert.updated",
  "network.updated",
  "backup.updated",
  "backup.deleted",
  "schedule.updated",
  "schedule.deleted",
  "extensions.updated",
  "player.joined",
  "player.left",
]);
export type RealtimeEventType = z.infer<typeof RealtimeEventType>;

export const ServerFrame = z.discriminatedUnion("op", [
  z.object({ op: z.literal("event"), topic: z.string(), type: RealtimeEventType, ts: EpochMs, data: z.unknown() }),
  z.object({ op: z.literal("subscribed"), topic: z.string() }),
  z.object({ op: z.literal("unsubscribed"), topic: z.string() }),
  z.object({ op: z.literal("error"), topic: z.string().optional(), code: z.string(), message: z.string() }),
  z.object({ op: z.literal("pong"), ts: EpochMs }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** `console.lines` payload. `seq` is monotonic per server so clients can detect gaps. */
export const ConsoleLinesEvent = z.object({
  serverId: z.uuid(),
  lines: z.array(z.object({ seq: z.number().int(), ts: EpochMs, stream: z.enum(["stdout", "stderr", "system"]), line: z.string() })),
  dropped: z.number().int().optional(),
});
export type ConsoleLinesEvent = z.infer<typeof ConsoleLinesEvent>;

/**
 * Payload schema per realtime event type. Entity updates carry the full REST DTO (bare, not wrapped)
 * so clients can patch their caches; metric events carry the raw agent sample with its subject id.
 * Clients must still treat payloads as hints and fall back to a REST refetch when parsing fails.
 */
export const REALTIME_EVENT_PAYLOADS = {
  "overview.updated": OverviewSummary,
  "node.updated": Node,
  "node.metrics": z.object({ nodeId: z.uuid(), sample: NodeMetricSample }),
  /** Per-user fields (`myPermissions`, `sftp`) are not broadcast; clients keep their REST values. */
  "server.updated": Server.omit({ myPermissions: true, sftp: true }),
  "server.metrics": z.object({ serverId: z.uuid(), sample: WorkloadMetricSample }),
  "console.lines": ConsoleLinesEvent,
  "job.updated": Job,
  "job.log": JobLogLine.extend({ jobId: z.uuid() }),
  "alert.updated": AlertIncident,
  "network.updated": z.object({ networkId: z.uuid() }),
  /** Published on `server:<id>`. */
  "backup.updated": Backup,
  /** Published on `server:<id>`. */
  "backup.deleted": z.object({ serverId: z.uuid(), backupId: z.uuid() }),
  /** Published on `server:<id>`. */
  "schedule.updated": Schedule,
  /** Published on `server:<id>`. */
  "schedule.deleted": z.object({ serverId: z.uuid(), scheduleId: z.uuid() }),
  /** Published on `server:<id>`: invalidation of the extension list / scan status (ids, not DTOs). */
  "extensions.updated": ExtensionsUpdatedEvent,
  /** Published on `server:<id>`; delivered only to subscribers with `servers.players.view` on the server. */
  "player.joined": PlayerJoinedEvent,
  /** Published on `server:<id>`; delivered only to subscribers with `servers.players.view` on the server. */
  "player.left": PlayerLeftEvent,
} as const satisfies Record<RealtimeEventType, z.ZodType>;
