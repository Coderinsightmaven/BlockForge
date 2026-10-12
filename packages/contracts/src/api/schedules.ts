import { z } from "zod";
import { EpochMs, Id } from "../common.js";

/**
 * Server schedules (Pterodactyl parity): a cron trigger evaluated in the server's time zone, running an
 * ordered list of tasks. Each task waits `offsetSeconds` after the previous one. Runs are recorded.
 * The control plane's scheduler claims due schedules with `FOR UPDATE SKIP LOCKED`, so one run per due
 * time even with several control-plane replicas; missed runs while the control plane was down are NOT
 * replayed (the next future time is used), except a single catch-up within 5 minutes.
 */
const CronField = z.string().trim().min(1).max(64).regex(/^[0-9*/,\-A-Za-z?LW#]+$/, "invalid cron field");

export const ScheduleCron = z.object({
  minute: CronField,
  hour: CronField,
  dayOfMonth: CronField,
  month: CronField,
  dayOfWeek: CronField,
});
export type ScheduleCron = z.infer<typeof ScheduleCron>;

export const ScheduleTask = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("command"),
    command: z.string().trim().min(1).max(1024).regex(/^[^\0\r\n]*$/),
    offsetSeconds: z.number().int().min(0).max(900).default(0),
    continueOnFailure: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("power"),
    power: z.enum(["start", "stop", "restart", "kill"]),
    offsetSeconds: z.number().int().min(0).max(900).default(0),
    continueOnFailure: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("backup"),
    ignore: z.array(z.string().max(512)).max(100).default([]),
    /** At the backup limit, rotate out the oldest unlocked backup (scheduled backups default to true). */
    rotate: z.boolean().default(true),
    offsetSeconds: z.number().int().min(0).max(900).default(0),
    continueOnFailure: z.boolean().default(false),
  }),
]);
export type ScheduleTask = z.infer<typeof ScheduleTask>;

export const Schedule = z.object({
  id: Id,
  serverId: Id,
  name: z.string(),
  cron: ScheduleCron,
  /** IANA zone; defaults to the server's time zone. */
  timezone: z.string(),
  enabled: z.boolean(),
  /** Skip the run when the server is not running (Pterodactyl "only when online"). */
  onlyWhenOnline: z.boolean(),
  tasks: z.array(ScheduleTask).max(20),
  nextRunAt: EpochMs.nullable(),
  lastRunAt: EpochMs.nullable(),
  /** A run is currently executing. */
  running: z.boolean(),
  createdAt: EpochMs,
});
export type Schedule = z.infer<typeof Schedule>;

export const UpsertScheduleRequest = z.object({
  name: z.string().trim().min(1).max(80),
  cron: ScheduleCron,
  timezone: z.string().max(64).optional(),
  enabled: z.boolean().default(true),
  onlyWhenOnline: z.boolean().default(false),
  tasks: z.array(ScheduleTask).min(1).max(20),
});

export const ScheduleRun = z.object({
  id: Id,
  scheduleId: Id,
  trigger: z.enum(["cron", "manual"]),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  /** e.g. "server offline" for skipped runs. */
  reason: z.string().nullable(),
  startedAt: EpochMs,
  finishedAt: EpochMs.nullable(),
  tasks: z.array(
    z.object({
      index: z.number().int(),
      action: z.enum(["command", "power", "backup"]),
      status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
      message: z.string().nullable(),
      jobId: Id.nullable(),
      startedAt: EpochMs.nullable(),
      finishedAt: EpochMs.nullable(),
    }),
  ),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

/** `POST /schedules/preview` — validates a cron expression and returns the next run times. */
export const CronPreviewRequest = z.object({ cron: ScheduleCron, timezone: z.string().max(64), count: z.number().int().min(1).max(10).default(5) });
export const CronPreviewResponse = z.object({ valid: z.boolean(), error: z.string().nullable(), next: z.array(EpochMs), description: z.string().nullable() });
