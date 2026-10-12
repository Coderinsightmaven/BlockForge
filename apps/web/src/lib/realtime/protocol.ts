import { EpochMs } from "@blockforge/contracts";
import { z } from "zod";

/*
 * The realtime frame schemas the always-loaded client needs (topic check, server frames, console
 * lines), rebuilt from the contract's definitions in `packages/contracts/src/realtime.ts`.
 *
 * Why a copy: that module also builds `REALTIME_EVENT_PAYLOADS`, whose initializer the bundler must
 * keep and which references every event's contract module (Plugins & mods, Players, …) — importing
 * anything from it put ~7 KiB of unrelated schemas into every page. `protocol.test.ts` pins these
 * copies to the contract (same JSON Schema, same event types, same topic patterns), so drift fails CI.
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

export const ServerFrame = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("event"),
    topic: z.string(),
    type: RealtimeEventType,
    ts: EpochMs,
    data: z.unknown(),
  }),
  z.object({ op: z.literal("subscribed"), topic: z.string() }),
  z.object({ op: z.literal("unsubscribed"), topic: z.string() }),
  z.object({ op: z.literal("error"), topic: z.string().optional(), code: z.string(), message: z.string() }),
  z.object({ op: z.literal("pong"), ts: EpochMs }),
]);

export const ConsoleLinesEvent = z.object({
  serverId: z.uuid(),
  lines: z.array(
    z.object({
      seq: z.number().int(),
      ts: EpochMs,
      stream: z.enum(["stdout", "stderr", "system"]),
      line: z.string(),
    }),
  ),
  dropped: z.number().int().optional(),
});
