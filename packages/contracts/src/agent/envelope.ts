import { z } from "zod";
import { EpochMs } from "../common.js";
import { AGENT_COMMAND_TYPES, type AgentCommandType } from "./commands.js";
import { NodeFacts } from "./facts.js";
import { NodeMetricSample, WorkloadMetricSample } from "./metrics.js";
import { LogLine, WorkloadStatus } from "./workload.js";

export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_TOKEN_AUDIENCE = "blockforge-control-plane";
export const AGENT_AUTH_SCHEME = "BFAgent";

/** Limits shared by both sides (see docs/architecture/agent-protocol.md). */
export const AGENT_LIMITS = {
  tokenMaxLifetimeMs: 120_000,
  tokenClockSkewMs: 30_000,
  commandMaxLifetimeMs: 900_000,
  commandExpiryGraceMs: 30_000,
  resultCacheMs: 900_000,
  missedHeartbeatsBeforeUnreachable: 3,
  maxFrameBytes: 16 * 1024 * 1024,
  logLineMaxBytes: 8192,
  logLinesPerSecond: 200,
  logBurstLines: 2000,
  /** A `pending` rotated credential that never authenticates expires after this. */
  credentialRotationPendingTtlMs: 900_000,
} as const;

/** Hosts an agent may reach over plain HTTP with `--insecure-allow-http` (development only). */
export const INSECURE_HTTP_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1", "host.docker.internal"] as const;

export const AgentErrorCode = z.enum([
  "VALIDATION_FAILED",
  "UNSUPPORTED_COMMAND",
  "COMMAND_REJECTED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "CONFLICT",
  "PATH_FORBIDDEN",
  "QUOTA_EXCEEDED",
  "CHECKSUM_MISMATCH",
  "DOWNLOAD_FAILED",
  "HOST_NOT_ALLOWED",
  "RUNTIME_ERROR",
  "TIMEOUT",
  "BUSY",
  "INTERNAL",
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCode>;

// ---------------------------------------------------------------------------
// Enrollment (HTTP)

export const ENROLLMENT_TOKEN_PATTERN = /^bfe_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export const EnrollRequest = z.object({
  token: z.string().regex(ENROLLMENT_TOKEN_PATTERN),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "base64url Ed25519 public key"),
  agentVersion: z.string().max(64),
  protocolVersion: z.number().int().positive(),
  facts: NodeFacts,
  nodeName: z.string().max(80).optional(),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({
  nodeId: z.uuid(),
  approved: z.boolean(),
  controlPlaneSigningKey: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
  metricsIntervalMs: z.number().int().positive(),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

/** Claims inside `Authorization: BFAgent <b64url(claims)>.<b64url(sig)>`. */
export const AgentTokenClaims = z.object({
  nid: z.uuid(),
  aud: z.literal(AGENT_TOKEN_AUDIENCE),
  iat: EpochMs,
  exp: EpochMs,
  jti: z.string().min(16).max(128),
});
export type AgentTokenClaims = z.infer<typeof AgentTokenClaims>;

// ---------------------------------------------------------------------------
// Control plane → agent

export const CommandBody = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  type: z.enum(AGENT_COMMAND_TYPES as [AgentCommandType, ...AgentCommandType[]]),
  issuedAt: EpochMs,
  expiresAt: EpochMs,
  payload: z.unknown(),
});
export type CommandBody = z.infer<typeof CommandBody>;

export const CpCommandFrame = z.object({ t: z.literal("cmd"), body: z.string(), sig: z.string() });
export const CpWelcomeFrame = z.object({
  t: z.literal("welcome"),
  nodeId: z.uuid(),
  serverTime: EpochMs,
  approved: z.boolean(),
  heartbeatIntervalMs: z.number().int().positive(),
  metricsIntervalMs: z.number().int().positive(),
});
export const ControlPlaneFrame = z.discriminatedUnion("t", [CpCommandFrame, CpWelcomeFrame]);
export type ControlPlaneFrame = z.infer<typeof ControlPlaneFrame>;

// ---------------------------------------------------------------------------
// Agent → control plane

export const AgentError = z.object({
  code: AgentErrorCode,
  message: z.string(),
  retryable: z.boolean().default(false),
  details: z.unknown().optional(),
});
export type AgentError = z.infer<typeof AgentError>;

export const HelloFrame = z.object({
  t: z.literal("hello"),
  agentVersion: z.string(),
  protocolVersion: z.number().int(),
  ts: EpochMs,
  facts: NodeFacts,
  capabilities: z.array(z.string()),
  workloads: z.array(WorkloadStatus),
});
export const HeartbeatFrame = z.object({ t: z.literal("heartbeat"), ts: EpochMs, uptimeMs: z.number().int() });
export const ProgressFrame = z.object({
  t: z.literal("progress"),
  id: z.uuid(),
  ts: EpochMs,
  stage: z.string().max(64),
  message: z.string().max(1024).optional(),
  percent: z.number().min(0).max(100).optional(),
});
export const ResultOkFrame = z.object({ t: z.literal("result"), id: z.uuid(), ts: EpochMs, ok: z.literal(true), data: z.unknown() });
export const ResultErrFrame = z.object({ t: z.literal("result"), id: z.uuid(), ts: EpochMs, ok: z.literal(false), error: AgentError });
export const MetricsFrame = z.object({
  t: z.literal("metrics"),
  ts: EpochMs,
  node: NodeMetricSample,
  workloads: z.array(WorkloadMetricSample),
});
export const AgentEventName = z.enum(["workload.state", "workload.oom", "agent.warning"]);
export const EventFrame = z.object({
  t: z.literal("event"),
  ts: EpochMs,
  event: AgentEventName,
  data: z.unknown(),
});
export const LogsFrame = z.object({
  t: z.literal("logs"),
  workloadId: z.uuid(),
  lines: z.array(LogLine).max(5000),
  dropped: z.number().int().nonnegative().optional(),
});

/** `result` frames share a discriminator, so they are parsed in two steps. */
export const AgentFrame = z.union([
  HelloFrame,
  HeartbeatFrame,
  ProgressFrame,
  ResultOkFrame,
  ResultErrFrame,
  MetricsFrame,
  EventFrame,
  LogsFrame,
]);
export type AgentFrame = z.infer<typeof AgentFrame>;
export type HelloFrame = z.infer<typeof HelloFrame>;
export type MetricsFrame = z.infer<typeof MetricsFrame>;
export type LogsFrame = z.infer<typeof LogsFrame>;
export type EventFrame = z.infer<typeof EventFrame>;

/** Payload of `event` frames with `event: "workload.state"`. */
export const WorkloadStateEvent = WorkloadStatus;
export const WorkloadOomEvent = z.object({ workloadId: z.uuid() });
export const AgentWarningEvent = z.object({ code: z.string(), message: z.string() });
