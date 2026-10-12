import { z } from "zod";
import { Bytes, DisplayName, EpochMs, Id } from "../common.js";
import { NodeFacts } from "../agent/facts.js";
import { NodeMetricSample } from "../agent/metrics.js";
import { NodeConnection, NodeStatus } from "../lifecycle.js";

export const NodeCapacity = z.object({
  cpuAllocatableMillicores: z.number().int().nonnegative(),
  memoryAllocatableBytes: Bytes,
  storageAllocatableBytes: Bytes,
  /** Reserved by servers + in-flight provisioning holds. */
  cpuReservedMillicores: z.number().int().nonnegative(),
  memoryReservedBytes: Bytes,
  storageReservedBytes: Bytes,
  overcommitMemoryRatio: z.number().min(1).max(4),
});
export type NodeCapacity = z.infer<typeof NodeCapacity>;

export const Node = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  status: NodeStatus,
  connection: NodeConnection,
  location: z.string().nullable(),
  tags: z.array(z.string()),
  publicAddress: z.string().nullable(),
  privateAddress: z.string().nullable(),
  schedulingEnabled: z.boolean(),
  agentVersion: z.string().nullable(),
  lastHeartbeatAt: EpochMs.nullable(),
  lastConnectedAt: EpochMs.nullable(),
  clockSkewMs: z.number().int().nullable(),
  facts: NodeFacts.nullable(),
  capacity: NodeCapacity,
  serverCount: z.number().int().nonnegative(),
  /**
   * Active agent warnings (agent-protocol §5.1 codes: CLOCK_SKEW, SFTP_UNAVAILABLE, INSTALL_OWNERSHIP,
   * WORKLOAD_RESTART_LIMIT, …), most recent per code. Cleared when the condition is reported resolved or
   * on reconnect after `ttlMs` without a repeat.
   */
  warnings: z
    .array(z.object({ code: z.string().max(64), message: z.string().max(1024), at: EpochMs }))
    .default([]),
  /** Most recent metric sample held in memory by the control plane (null if none / stale). */
  latest: NodeMetricSample.nullable(),
  createdAt: EpochMs,
});
export type Node = z.infer<typeof Node>;

export const UpdateNodeRequest = z.object({
  name: DisplayName.optional(),
  location: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-_.]{0,31}$/)).max(32).optional(),
  publicAddress: z.string().max(253).nullable().optional(),
  privateAddress: z.string().max(253).nullable().optional(),
  schedulingEnabled: z.boolean().optional(),
  cpuAllocatableMillicores: z.number().int().min(0).optional(),
  memoryAllocatableBytes: Bytes.optional(),
  storageAllocatableBytes: Bytes.optional(),
  overcommitMemoryRatio: z.number().min(1).max(4).optional(),
  status: z.enum(["active", "draining", "maintenance", "disabled"]).optional(),
});

export const CreateEnrollmentTokenRequest = z.object({
  label: z.string().trim().min(1).max(80),
  expiresInMinutes: z.number().int().min(5).max(7 * 24 * 60).default(60),
  requiresApproval: z.boolean().default(false),
  location: z.string().max(80).nullable().default(null),
  tags: z.array(z.string()).max(32).default([]),
});

export const EnrollmentToken = z.object({
  id: Id,
  tokenId: z.string(),
  label: z.string(),
  expiresAt: EpochMs,
  usedAt: EpochMs.nullable(),
  usedByNodeId: Id.nullable(),
  requiresApproval: z.boolean(),
  createdAt: EpochMs,
  /** Email of the creating user (display identity); null if that user was deleted. */
  createdBy: z.string().nullable(),
});
export type EnrollmentToken = z.infer<typeof EnrollmentToken>;

/** `POST /nodes/:id/rotate-credentials` response: rotation runs as a job. */
export const RotateCredentialsResponse = z.object({ node: Node, jobId: z.uuid() });

/** Returned once on creation; the secret is never retrievable again. */
export const CreatedEnrollmentToken = z.object({
  token: EnrollmentToken,
  secretToken: z.string(),
  installCommand: z.string(),
});
