import { z } from "zod";
import { EpochMs } from "./common.js";

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
