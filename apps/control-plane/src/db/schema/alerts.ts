import { AlertIncident, AlertRule, AlertRuleKind, AlertSeverity, NotificationChannel } from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { enumCheck, tsz } from "./_helpers.js";
import { users } from "./identity.js";
import { secrets } from "./secrets.js";

export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey(),
    /** Stable key for seeded default rules (idempotent seeding); null for user-created rules. */
    builtinKey: text("builtin_key").unique("alert_rules_builtin_key_unique"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    scopeType: text("scope_type").notNull().default("global"),
    scopeId: uuid("scope_id"),
    threshold: doublePrecision("threshold"),
    forSeconds: integer("for_seconds").notNull().default(0),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(900),
    channelIds: uuid("channel_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    enumCheck("alert_rules_kind_check", t.kind, AlertRuleKind.options),
    enumCheck("alert_rules_severity_check", t.severity, AlertSeverity.options),
    enumCheck("alert_rules_scope_type_check", t.scopeType, AlertRule.shape.scopeType.options),
    check("alert_rules_scope_id_check", sql`(${t.scopeType} = 'global') = (${t.scopeId} IS NULL)`),
    check("alert_rules_durations_check", sql`${t.forSeconds} >= 0 AND ${t.cooldownSeconds} >= 0`),
  ],
);

export const alertIncidents = pgTable(
  "alert_incidents",
  {
    id: uuid("id").primaryKey(),
    ruleId: uuid("rule_id").references(() => alertRules.id, { onDelete: "set null" }),
    /** (rule, subject) dedup key; at most one open (non-resolved) incident per key. */
    dedupKey: text("dedup_key").notNull(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectName: text("subject_name"),
    summary: text("summary").notNull(),
    value: doublePrecision("value"),
    firstFiredAt: tsz("first_fired_at").notNull(),
    lastFiredAt: tsz("last_fired_at").notNull(),
    acknowledgedAt: tsz("acknowledged_at"),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: tsz("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    occurrences: integer("occurrences").notNull().default(1),
    lastNotifiedAt: tsz("last_notified_at"),
  },
  (t) => [
    enumCheck("alert_incidents_kind_check", t.kind, AlertRuleKind.options),
    enumCheck("alert_incidents_severity_check", t.severity, AlertSeverity.options),
    enumCheck("alert_incidents_status_check", t.status, AlertIncident.shape.status.options),
    uniqueIndex("alert_incidents_open_dedup").on(t.dedupKey).where(sql`${t.status} <> 'resolved'`),
    index("alert_incidents_status_idx").on(t.status, t.lastFiredAt),
    index("alert_incidents_dedup_idx").on(t.dedupKey, t.resolvedAt),
  ],
);

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Non-secret configuration only (e.g. email recipients). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Webhook URL (discord/webhook) lives in `secrets`. */
    secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "restrict" }),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [enumCheck("notification_channels_kind_check", t.kind, NotificationChannel.shape.kind.options)],
);

export const DELIVERY_STATUSES = ["pending", "succeeded", "failed"] as const;

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id").references(() => alertIncidents.id, { onDelete: "set null" }),
    /** `test`, `fired` or `resolved`. */
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Rendered message (no secrets: subject names and summaries only). */
    payload: jsonb("payload").notNull(),
    lastError: text("last_error"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    lastAttemptAt: tsz("last_attempt_at"),
    nextAttemptAt: tsz("next_attempt_at"),
    deliveredAt: tsz("delivered_at"),
  },
  (t) => [
    enumCheck("notification_deliveries_status_check", t.status, DELIVERY_STATUSES),
    enumCheck("notification_deliveries_reason_check", t.reason, ["test", "fired", "resolved"]),
    index("notification_deliveries_pending_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
  ],
);
