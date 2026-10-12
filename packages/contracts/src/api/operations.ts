import { z } from "zod";
import { Bytes, EpochMs, Id } from "../common.js";

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const JobStepStatus = z.enum(["pending", "running", "succeeded", "failed", "skipped"]);

export const JobStep = z.object({
  key: z.string(),
  label: z.string(),
  status: JobStepStatus,
  message: z.string().nullable(),
  startedAt: EpochMs.nullable(),
  finishedAt: EpochMs.nullable(),
});
export const Job = z.object({
  id: Id,
  type: z.string(),
  status: JobStatus,
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  requestedBy: z.string().nullable(),
  attempts: z.number().int(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  result: z.unknown().nullable(),
  createdAt: EpochMs,
  startedAt: EpochMs.nullable(),
  finishedAt: EpochMs.nullable(),
  steps: z.array(JobStep),
});
export type Job = z.infer<typeof Job>;
export type JobStep = z.infer<typeof JobStep>;

export const JobLogLine = z.object({ id: z.number(), ts: EpochMs, level: z.enum(["debug", "info", "warn", "error"]), message: z.string() });
export type JobLogLine = z.infer<typeof JobLogLine>;

// ---------------------------------------------------------------------------
// Metrics

/** Whitelisted series. The control plane maps each id to a fixed PromQL template. */
export const METRIC_SERIES = {
  "node.cpu.usage": { unit: "percent", scope: "node" },
  "node.cpu.core": { unit: "percent", scope: "node" },
  "node.load": { unit: "load", scope: "node" },
  "node.memory": { unit: "bytes", scope: "node" },
  "node.swap.used": { unit: "bytes", scope: "node" },
  "node.fs.used": { unit: "bytes", scope: "node" },
  "node.disk.throughput": { unit: "bytes_per_second", scope: "node" },
  "node.disk.latency": { unit: "milliseconds", scope: "node" },
  "node.net.throughput": { unit: "bytes_per_second", scope: "node" },
  "node.net.errors": { unit: "count_per_second", scope: "node" },
  "server.cpu": { unit: "percent", scope: "server" },
  "server.memory": { unit: "bytes", scope: "server" },
  "server.jvm.heap": { unit: "bytes", scope: "server" },
  "server.jvm.gc": { unit: "milliseconds_per_second", scope: "server" },
  "server.net.throughput": { unit: "bytes_per_second", scope: "server" },
  "server.disk.throughput": { unit: "bytes_per_second", scope: "server" },
  "server.players": { unit: "count", scope: "server" },
  "global.cpu.usage": { unit: "percent", scope: "global" },
  "global.memory": { unit: "bytes", scope: "global" },
  "global.net.throughput": { unit: "bytes_per_second", scope: "global" },
  "global.disk.throughput": { unit: "bytes_per_second", scope: "global" },
  "global.players": { unit: "count", scope: "global" },
} as const satisfies Record<string, { unit: string; scope: "node" | "server" | "global" }>;
export type MetricSeriesId = keyof typeof METRIC_SERIES;
export const MetricSeriesIdSchema = z.enum(Object.keys(METRIC_SERIES) as [MetricSeriesId, ...MetricSeriesId[]]);

export const TIME_RANGE_PRESETS = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
} as const;
export type TimeRangePreset = keyof typeof TIME_RANGE_PRESETS;

export const MetricRangeQuery = z.object({
  series: MetricSeriesIdSchema,
  nodeId: Id.optional(),
  serverId: Id.optional(),
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().nonnegative(),
  /** Optional step; the control plane picks ~300 points by default and clamps to ≥ 5 s. */
  stepMs: z.coerce.number().int().min(5000).optional(),
});
export const MetricSeriesResult = z.object({
  series: MetricSeriesIdSchema,
  unit: z.string(),
  from: EpochMs,
  to: EpochMs,
  stepMs: z.number().int(),
  lines: z.array(
    z.object({
      /** e.g. {kind:"used"} or {core:"3"} or {iface:"eth0", direction:"rx"} */
      labels: z.record(z.string(), z.string()),
      /** [timestamp, value|null] — null marks missing telemetry (rendered as a gap). */
      points: z.array(z.tuple([EpochMs, z.number().nullable()])),
    }),
  ),
});
export type MetricSeriesResult = z.infer<typeof MetricSeriesResult>;

// ---------------------------------------------------------------------------
// Overview

export const OverviewSummary = z.object({
  generatedAt: EpochMs,
  nodes: z.object({
    total: z.number().int(),
    online: z.number().int(),
    degraded: z.number().int(),
    unreachable: z.number().int(),
    offline: z.number().int(),
    pending: z.number().int(),
  }),
  servers: z.object({ total: z.number().int(), byState: z.record(z.string(), z.number().int()) }),
  players: z.object({ online: z.number().int(), reportingServers: z.number().int() }),
  cpu: z.object({
    capacityMillicores: z.number().int(),
    allocatedMillicores: z.number().int(),
    /** Weighted by node core counts; null if no node reported recently. */
    usagePct: z.number().nullable(),
  }),
  memory: z.object({
    totalBytes: Bytes,
    allocatedBytes: Bytes,
    usedBytes: Bytes.nullable(),
    availableBytes: Bytes.nullable(),
  }),
  storage: z.object({ totalBytes: Bytes.nullable(), usedBytes: Bytes.nullable() }),
  network: z.object({ rxBytesPerSec: z.number().nullable(), txBytesPerSec: z.number().nullable() }),
  backups: z.object({ configured: z.boolean(), lastSuccessAt: EpochMs.nullable(), failedLast24h: z.number().int() }).nullable(),
  pendingUpdates: z.number().int().nullable(),
  activeAlerts: z.object({ critical: z.number().int(), warning: z.number().int(), info: z.number().int() }),
  recentCrashes: z.array(z.object({ serverId: Id, serverName: z.string(), at: EpochMs, exitCode: z.number().int().nullable() })),
  recentFailedJobs: z.array(z.object({ jobId: Id, type: z.string(), targetName: z.string().nullable(), at: EpochMs, message: z.string() })),
});
export type OverviewSummary = z.infer<typeof OverviewSummary>;

// ---------------------------------------------------------------------------
// Alerts

export const AlertSeverity = z.enum(["info", "warning", "critical"]);
export const AlertRuleKind = z.enum([
  "node.cpu.high",
  "node.memory.high",
  "node.disk.low",
  "node.unreachable",
  "server.crashed",
  "server.memory.high",
  "server.heap.high",
  "job.failed",
]);
/**
 * Meaning of `AlertRule.threshold` per kind (the evaluator and the UI must agree on these).
 * `null` unit = the rule takes no threshold (it must be `null`).
 */
export const ALERT_RULE_KINDS = {
  "node.cpu.high": { unit: "percent", subject: "node", description: "Host CPU usage above threshold % for forSeconds" },
  "node.memory.high": {
    unit: "percent",
    subject: "node",
    description: "Host memory used ((total − available) / total) above threshold % for forSeconds",
  },
  "node.disk.low": {
    unit: "percent",
    subject: "node",
    description: "Free space on any filesystem below threshold % (e.g. 10 = fires when < 10% free)",
  },
  "node.unreachable": { unit: null, subject: "node", description: "Node has not sent a heartbeat for forSeconds" },
  "server.crashed": { unit: null, subject: "server", description: "Server process exited unexpectedly" },
  "server.memory.high": {
    unit: "percent",
    subject: "server",
    description: "Container memory usage above threshold % of its limit for forSeconds",
  },
  "server.heap.high": {
    unit: "percent",
    subject: "server",
    description: "JVM heap used above threshold % of heap max for forSeconds",
  },
  "job.failed": { unit: null, subject: "job", description: "A background job failed" },
} as const satisfies Record<
  z.infer<typeof AlertRuleKind>,
  { unit: "percent" | null; subject: "node" | "server" | "job"; description: string }
>;

export const AlertRule = z.object({
  id: Id,
  name: z.string(),
  kind: AlertRuleKind,
  severity: AlertSeverity,
  enabled: z.boolean(),
  scopeType: z.enum(["global", "node", "server"]),
  scopeId: Id.nullable(),
  threshold: z.number().nullable(),
  forSeconds: z.number().int().min(0),
  cooldownSeconds: z.number().int().min(0),
  channelIds: z.array(Id),
});
export type AlertRule = z.infer<typeof AlertRule>;
export const UpsertAlertRuleRequest = AlertRule.omit({ id: true });

export const AlertIncident = z.object({
  id: Id,
  ruleId: Id.nullable(),
  kind: AlertRuleKind,
  severity: AlertSeverity,
  status: z.enum(["firing", "acknowledged", "resolved"]),
  subjectType: z.string(),
  subjectId: z.string(),
  subjectName: z.string().nullable(),
  summary: z.string(),
  value: z.number().nullable(),
  firstFiredAt: EpochMs,
  lastFiredAt: EpochMs,
  acknowledgedAt: EpochMs.nullable(),
  acknowledgedBy: z.string().nullable(),
  resolvedAt: EpochMs.nullable(),
  occurrences: z.number().int(),
});
export type AlertIncident = z.infer<typeof AlertIncident>;

export const NotificationChannel = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(["discord", "webhook", "email"]),
  enabled: z.boolean(),
  /** Non-secret config only (e.g. email recipients). Webhook URLs are secrets and never returned. */
  config: z.record(z.string(), z.unknown()),
  createdAt: EpochMs,
});
/** `POST /notification-channels/:id/test` response. `error` never contains the webhook URL. */
export const NotificationTestResult = z.object({ delivered: z.boolean(), error: z.string().nullable() });
export type NotificationTestResult = z.infer<typeof NotificationTestResult>;

/** `GET /audit/verify` response. */
export const AuditVerifyResult = z.object({
  valid: z.boolean(),
  checked: z.number().int().nonnegative(),
  firstBrokenId: z.string().nullable(),
});
export type AuditVerifyResult = z.infer<typeof AuditVerifyResult>;

/**
 * Create/update a channel. On update, omitting `config.url` keeps the stored (secret) URL; sending
 * a new `url` replaces it. The URL is write-only and never returned.
 */
export const UpsertNotificationChannelRequest = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(["discord", "webhook", "email"]),
  enabled: z.boolean().default(true),
  /** discord/webhook: {url}; email: {to: string[]} */
  config: z.record(z.string(), z.unknown()),
});
