import type { NodeStatus } from "@blockforge/contracts";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agentAuthJti, nodeCredentials, nodes } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import { ed25519PublicKeyFromRaw } from "../lib/crypto.js";
import { AgentAuthError, checkTokenTimes, parseAgentAuthorization, verifyTokenSignature } from "./token.js";

export interface AuthenticatedAgent {
  nodeId: string;
  status: NodeStatus;
  credentialId: string;
  /** True when this authentication promoted a pending (rotated) key to active. */
  promoted: boolean;
}

/** Node statuses whose agents may not authenticate at all. */
const REJECTED_STATUSES: readonly string[] = ["revoked", "disabled"];

/**
 * Tracks in-flight staged rotations so an agent reconnecting with its *next* key immediately after
 * returning the rotation result does not race the insert of the pending credential.
 */
export class RotationCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  track(nodeId: string, work: Promise<unknown>): void {
    const settled = work.catch(() => undefined).finally(() => {
      if (this.inFlight.get(nodeId) === settled) this.inFlight.delete(nodeId);
    });
    this.inFlight.set(nodeId, settled);
  }

  async waitFor(nodeId: string): Promise<boolean> {
    const p = this.inFlight.get(nodeId);
    if (!p) return false;
    await p;
    return true;
  }
}

/**
 * Verifies `BFAgent` tokens (agent-protocol.md §3): shape → times → node status → signature over
 * an active or unexpired pending key → durable jti insert (replay = conflict). The first successful
 * authentication with a pending key atomically promotes it and retires the previous active key.
 */
export class AgentAuthenticator {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly rotations: RotationCoordinator,
    private readonly logger: Logger,
  ) {}

  async authenticate(header: string | undefined): Promise<AuthenticatedAgent> {
    const token = parseAgentAuthorization(header);
    const now = this.clock.now();
    const timeFailure = checkTokenTimes(token.claims, now);
    if (timeFailure) throw new AgentAuthError(timeFailure);
    const nodeId = token.claims.nid;

    const [node] = await this.db.select({ id: nodes.id, status: nodes.status }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AgentAuthError("unknown_node");
    if (REJECTED_STATUSES.includes(node.status)) throw new AgentAuthError("node_rejected");

    let match = await this.matchCredential(nodeId, token, now);
    if (!match && (await this.rotations.waitFor(nodeId))) match = await this.matchCredential(nodeId, token, now);
    if (!match) throw new AgentAuthError("bad_signature");

    const promoted = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(agentAuthJti)
        .values({ jti: token.claims.jti, nodeId, expiresAt: new Date(token.claims.exp) })
        .onConflictDoNothing()
        .returning({ jti: agentAuthJti.jti });
      if (inserted.length === 0) throw new AgentAuthError("replayed");
      if (match.status !== "pending") return false;
      const at = new Date(now);
      // Retire the old key first so the "one active key" partial unique index holds.
      await tx
        .update(nodeCredentials)
        .set({ status: "rotated", revokedAt: at })
        .where(and(eq(nodeCredentials.nodeId, nodeId), eq(nodeCredentials.status, "active")));
      const updated = await tx
        .update(nodeCredentials)
        .set({ status: "active", activatedAt: at, expiresAt: null })
        .where(and(eq(nodeCredentials.id, match.id), eq(nodeCredentials.status, "pending")))
        .returning({ id: nodeCredentials.id });
      if (updated.length === 0) throw new AgentAuthError("bad_signature");
      return true;
    });
    if (promoted) this.logger.info({ nodeId, credentialId: match.id }, "rotated agent key promoted to active");
    return { nodeId, status: node.status as NodeStatus, credentialId: match.id, promoted };
  }

  private async matchCredential(nodeId: string, token: ReturnType<typeof parseAgentAuthorization>, now: number) {
    const creds = await this.db
      .select({ id: nodeCredentials.id, publicKey: nodeCredentials.publicKey, status: nodeCredentials.status, expiresAt: nodeCredentials.expiresAt })
      .from(nodeCredentials)
      .where(and(eq(nodeCredentials.nodeId, nodeId), inArray(nodeCredentials.status, ["active", "pending"])));
    for (const c of creds) {
      if (c.status === "pending" && (!c.expiresAt || c.expiresAt.getTime() <= now)) continue;
      const key = ed25519PublicKeyFromRaw(c.publicKey);
      if (key && verifyTokenSignature(token, key)) return c;
    }
    return null;
  }

  /** Deletes expired replay-cache rows and expired pending credentials. */
  async prune(): Promise<void> {
    const now = new Date(this.clock.now());
    await this.db.delete(agentAuthJti).where(lt(agentAuthJti.expiresAt, now));
    await this.db
      .update(nodeCredentials)
      .set({ status: "revoked", revokedAt: now })
      .where(and(eq(nodeCredentials.status, "pending"), lt(nodeCredentials.expiresAt, now)));
  }
}
