import { AuditEvent, DOMAIN_EVENTS, EPHEMERAL_EVENTS, JobLogLine, JobStatus, JobStepStatus } from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { enumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";
import { nodes } from "./infrastructure.js";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").unique("jobs_idempotency_key_unique"),
    /** Redacted copy of the input (for display); the runnable input is `input_data`. */
    input: jsonb("input").notNull().default({}),
    /** Validated input the steps run with. Never serialised in API responses. */
    inputData: jsonb("input_data").notNull().default({}),
    /** Cross-step state persisted for resumability. Never serialised in API responses. */
    state: jsonb("state").notNull().default({}),
    result: jsonb("result"),
    error: jsonb("error").$type<{ code: string; message: string }>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(1),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    bossJobId: text("boss_job_id"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    startedAt: tsz("started_at"),
    finishedAt: tsz("finished_at"),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    enumCheck("jobs_status_check", t.status, JobStatus.options),
    index("jobs_target_idx").on(t.targetType, t.targetId),
    index("jobs_status_idx").on(t.status),
    index("jobs_created_idx").on(t.createdAt),
  ],
);

export const jobSteps = pgTable(
  "job_steps",
  {
    id: uuid("id").primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    status: text("status").notNull().default("pending"),
    message: text("message"),
    startedAt: tsz("started_at"),
    finishedAt: tsz("finished_at"),
  },
  (t) => [
    unique("job_steps_job_key_unique").on(t.jobId, t.key),
    enumCheck("job_steps_status_check", t.status, JobStepStatus.options),
  ],
);

export const jobLogs = pgTable(
  "job_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    ts: tsz("ts").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
  },
  (t) => [
    index("job_logs_job_idx").on(t.jobId, t.id),
    enumCheck("job_logs_level_check", t.level, JobLogLine.shape.level.options),
  ],
);

const PERSISTED_EVENTS = DOMAIN_EVENTS.filter((e) => !EPHEMERAL_EVENTS.includes(e));

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    data: jsonb("data").notNull().default({}),
    occurredAt: tsz("occurred_at").notNull(),
    /** Set once every in-process subscriber handled the event (outbox re-dispatch otherwise). */
    dispatchedAt: tsz("dispatched_at"),
  },
  (t) => [
    enumCheck("events_type_check", t.type, PERSISTED_EVENTS),
    index("events_occurred_idx").on(t.occurredAt),
    index("events_subject_idx").on(t.subjectType, t.subjectId),
    index("events_undispatched_idx").on(t.id).where(sql`${t.dispatchedAt} IS NULL`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: tsz("at").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    requestId: text("request_id"),
    outcome: text("outcome").notNull(),
    details: jsonb("details").notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    enumCheck("audit_events_actor_type_check", t.actorType, AuditEvent.shape.actorType.options),
    enumCheck("audit_events_outcome_check", t.outcome, AuditEvent.shape.outcome.options),
    index("audit_events_at_idx").on(t.at),
    index("audit_events_action_idx").on(t.action),
    index("audit_events_target_idx").on(t.targetType, t.targetId),
    index("audit_events_actor_idx").on(t.actorId),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});

/** api.md "Idempotency": replayed responses for job-creating routes (24 h retention). */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    /** Null while the original request is still being processed. */
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "idempotency_keys_pk", columns: [t.userId, t.route, t.key] }),
    index("idempotency_keys_created_idx").on(t.createdAt),
  ],
);

export const AGENT_COMMAND_STATUSES = ["sent", "succeeded", "failed", "expired", "rejected"] as const;
export type AgentCommandStatus = (typeof AGENT_COMMAND_STATUSES)[number];

export const agentCommands = pgTable(
  "agent_commands",
  {
    /** Equals the command id inside the signed body. */
    id: uuid("id").primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payloadRedacted: jsonb("payload_redacted").notNull().default({}),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    error: jsonb("error"),
    issuedAt: tsz("issued_at").notNull(),
    expiresAt: tsz("expires_at").notNull(),
    completedAt: tsz("completed_at"),
  },
  (t) => [
    enumCheck("agent_commands_status_check", t.status, AGENT_COMMAND_STATUSES),
    index("agent_commands_node_idx").on(t.nodeId, t.issuedAt),
    index("agent_commands_issued_idx").on(t.issuedAt),
  ],
);
