import { BackupConsistency, BackupStatus, type ScheduleCron, type ScheduleRun, type ScheduleTask } from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { enumCheck, nullableEnumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";
import { servers } from "./servers.js";

export const SCHEDULE_RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cron: jsonb("cron").$type<ScheduleCron>().notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    onlyWhenOnline: boolean("only_when_online").notNull().default(false),
    tasks: jsonb("tasks").$type<ScheduleTask[]>().notNull(),
    nextRunAt: tsz("next_run_at"),
    lastRunAt: tsz("last_run_at"),
    /** Status of the most recent finished run. */
    lastRunStatus: text("last_run_status"),
    /** The run currently executing (at most one per schedule). */
    runningRunId: uuid("running_run_id"),
    /** Last editor: task permissions are re-checked against this user at run time. */
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("schedules_server_idx").on(t.serverId),
    index("schedules_due_idx").on(t.nextRunAt).where(sql`${t.enabled}`),
    nullableEnumCheck("schedules_last_run_status_check", t.lastRunStatus, ["succeeded", "failed", "skipped"]),
  ],
);

export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: uuid("id").primaryKey(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    tasks: jsonb("tasks").$type<ScheduleRun["tasks"]>().notNull(),
    startedAt: tsz("started_at").notNull(),
    finishedAt: tsz("finished_at"),
  },
  (t) => [
    enumCheck("schedule_runs_trigger_check", t.trigger, ["cron", "manual"]),
    enumCheck("schedule_runs_status_check", t.status, SCHEDULE_RUN_STATUSES),
    index("schedule_runs_schedule_idx").on(t.scheduleId, t.startedAt),
  ],
);

export const backups = pgTable(
  "backups",
  {
    id: uuid("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"),
    locked: boolean("locked").notNull().default(false),
    storage: text("storage").notNull(),
    /** S3 object key (null for local backups). */
    objectKey: text("object_key"),
    consistency: text("consistency"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    ignored: text("ignored").array().notNull().default(sql`'{}'::text[]`),
    skippedSymlinks: integer("skipped_symlinks"),
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    scheduleId: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    jobId: uuid("job_id"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    completedAt: tsz("completed_at"),
  },
  (t) => [
    enumCheck("backups_status_check", t.status, BackupStatus.options),
    enumCheck("backups_storage_check", t.storage, ["local", "s3"]),
    nullableEnumCheck("backups_consistency_check", t.consistency, BackupConsistency.options),
    index("backups_server_idx").on(t.serverId, t.createdAt),
  ],
);
