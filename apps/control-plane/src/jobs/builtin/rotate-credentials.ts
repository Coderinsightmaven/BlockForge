import { randomUUID } from "node:crypto";
import { AGENT_LIMITS, ROTATION_PROOF_PREFIX } from "@blockforge/contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentGateway } from "../../agents/gateway.js";
import type { RotationCoordinator } from "../../agents/authenticator.js";
import type { AuditService } from "../../audit/service.js";
import type { Db } from "../../db/client.js";
import { nodeCredentials } from "../../db/schema/index.js";
import type { Clock } from "../../lib/clock.js";
import { ed25519PublicKeyFromRaw, ed25519Verify } from "../../lib/crypto.js";
import { JobError, type JobDefinition } from "../types.js";

export const ROTATE_CREDENTIALS_JOB = "node.credentials.rotate";

const Input = z.object({ nodeId: z.uuid() });
type Input = z.infer<typeof Input>;

export interface RotateDeps {
  db: Db;
  clock: Clock;
  gateway: AgentGateway;
  rotations: RotationCoordinator;
  audit: AuditService;
  /** How long to wait for the agent to reconnect with the new key. */
  confirmTimeoutMs?: number;
}

/**
 * Staged credential rotation (agent-protocol.md §3.1):
 *  1. `credentials.rotate` → `{publicKey, proof}`; the proof (signature by the NEW key over
 *     `blockforge-rotate:<nodeId>:<commandId>`) is verified and the key stored as `pending`.
 *  2. Wait until the agent reconnects with the new key (the authenticator promotes it to `active`
 *     and retires the old one). If it never does, the old key stays active — the node is never
 *     left without a usable key, and the pending key expires on its own.
 */
export function rotateCredentialsJob(deps: RotateDeps): JobDefinition<Input> {
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 120_000;
  return {
    type: ROTATE_CREDENTIALS_JOB,
    input: Input,
    cancelPermission: "nodes.manage",
    retryLimit: 3,
    retryDelaySeconds: 5,
    steps: [
      {
        key: "request",
        label: "Request a new key from the agent",
        async run(ctx) {
          const { nodeId } = ctx.input;
          const commandId = randomUUID();
          await ctx.log("info", "Sending credentials.rotate to the agent");
          const result = await deps.gateway.send(nodeId, "credentials.rotate", {}, {
            jobId: ctx.jobId,
            userId: ctx.requestedBy,
            signal: ctx.signal,
            timeoutMs: 60_000,
            commandId,
          });
          // Register the pending-key insert synchronously, before any I/O, so an agent that reconnects
          // with the new key right away waits for it instead of being rejected.
          const store = (async () => {
            const key = ed25519PublicKeyFromRaw(result.publicKey);
            const message = Buffer.from(`${ROTATION_PROOF_PREFIX}${nodeId}:${commandId}`, "utf8");
            if (!key || !ed25519Verify(key, message, result.proof)) {
              throw new JobError("ROTATION_PROOF_INVALID", "The agent's proof of possession for the new key is invalid");
            }
            const now = deps.clock.now();
            await deps.db.transaction(async (tx) => {
              // At most one pending key per node: a newer rotation supersedes an unfinished one.
              await tx
                .update(nodeCredentials)
                .set({ status: "revoked", revokedAt: new Date(now) })
                .where(and(eq(nodeCredentials.nodeId, nodeId), eq(nodeCredentials.status, "pending")));
              await tx.insert(nodeCredentials).values({
                id: randomUUID(),
                nodeId,
                publicKey: result.publicKey,
                status: "pending",
                createdAt: new Date(now),
                expiresAt: new Date(now + AGENT_LIMITS.credentialRotationPendingTtlMs),
              });
              await deps.audit.record(
                {
                  actorType: "system",
                  actorId: null,
                  actorName: "job",
                  action: "node.credentials.rotation.pending",
                  targetType: "node",
                  targetId: nodeId,
                  outcome: "success",
                  details: { jobId: ctx.jobId, publicKey: result.publicKey },
                },
                tx,
              );
            });
          })();
          deps.rotations.track(nodeId, store);
          await store;
          ctx.state.publicKey = result.publicKey;
          await ctx.log("info", "New key verified and stored as pending");
        },
      },
      {
        key: "confirm",
        label: "Wait for the agent to reconnect with the new key",
        async run(ctx) {
          const publicKey = String(ctx.state.publicKey ?? "");
          if (!publicKey) throw new JobError("STATE_MISSING", "rotation state lost");
          const deadline = Date.now() + confirmTimeoutMs;
          while (Date.now() < deadline) {
            if (ctx.signal.aborted) throw ctx.signal.reason;
            const [cred] = await deps.db
              .select({ status: nodeCredentials.status })
              .from(nodeCredentials)
              .where(and(eq(nodeCredentials.nodeId, ctx.input.nodeId), eq(nodeCredentials.publicKey, publicKey)))
              .limit(1);
            if (cred?.status === "active") {
              await deps.audit.record({
                actorType: "system",
                actorId: null,
                actorName: "job",
                action: "node.credentials.rotated",
                targetType: "node",
                targetId: ctx.input.nodeId,
                outcome: "success",
                details: { jobId: ctx.jobId, publicKey },
              });
              await ctx.log("info", "Agent authenticated with the new key; previous key retired");
              return;
            }
            if (!cred || cred.status === "revoked") {
              throw new JobError("ROTATION_ABANDONED", "The pending key was superseded or expired; the previous key remains active");
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          throw new JobError(
            "ROTATION_NOT_CONFIRMED",
            "The agent did not reconnect with the new key in time; the previous key remains active",
          );
        },
      },
    ],
    result: (state) => ({ publicKey: state.publicKey ?? null }),
  };
}
