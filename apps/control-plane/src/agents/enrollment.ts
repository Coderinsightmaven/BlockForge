import { randomBytes, randomUUID } from "node:crypto";
import {
  AGENT_PROTOCOL_VERSION,
  ENROLLMENT_TOKEN_PATTERN,
  type CreatedEnrollmentToken as CreatedEnrollmentTokenSchema,
  type EnrollRequest,
  type EnrollResponse,
  type EnrollmentToken,
} from "@blockforge/contracts";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { enrollmentTokens, nodeCredentials, nodes, users } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { EventBus } from "../events/bus.js";
import type { Clock } from "../lib/clock.js";
import { b64url, ed25519PublicKeyFromRaw, safeEqual, sha256Hex } from "../lib/crypto.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import type { z } from "zod";
import type { NodeStateTracker } from "./node-state.js";

type CreatedEnrollmentToken = z.infer<typeof CreatedEnrollmentTokenSchema>;

export interface EnrollmentConfig {
  agentUrl: string;
  heartbeatIntervalMs: number;
  metricsIntervalMs: number;
}

const invalidToken = () =>
  new AppError(401, "ENROLLMENT_TOKEN_INVALID", "Enrollment token is invalid, expired or already used");

/** Lowercase slug matching the contracts' Slug pattern (3–48 chars). */
export function slugify(name: string): string {
  let s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (s.length < 3) s = `node-${s || "x"}`.replace(/-+$/g, "");
  return s;
}

export class EnrollmentService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
    private readonly tracker: NodeStateTracker,
    private readonly signingPublicKey: string,
    private readonly config: EnrollmentConfig,
    private readonly logger: Logger,
  ) {}

  private toDto(row: typeof enrollmentTokens.$inferSelect, createdByEmail: string | null): EnrollmentToken {
    return {
      id: row.id,
      tokenId: row.tokenId,
      label: row.label,
      expiresAt: row.expiresAt.getTime(),
      usedAt: row.usedAt?.getTime() ?? null,
      usedByNodeId: row.usedByNodeId,
      requiresApproval: row.requiresApproval,
      createdAt: row.createdAt.getTime(),
      createdBy: createdByEmail,
    };
  }

  installCommand(secretToken: string): string {
    const url = this.config.agentUrl;
    const insecure = url.startsWith("http://") ? " --insecure-allow-http" : "";
    return `blockforge-agent enroll --url ${url} --token ${secretToken}${insecure}`;
  }

  async create(
    input: { label: string; expiresInMinutes: number; requiresApproval: boolean; location: string | null; tags: string[] },
    actor: AuditActor,
  ): Promise<CreatedEnrollmentToken> {
    const id = randomUUID();
    const tokenId = randomBytes(8).toString("hex");
    const secret = b64url(randomBytes(32));
    const secretToken = `bfe_${tokenId}_${secret}`;
    const now = this.clock.now();
    const [row] = await withTransaction(this.db, async (tx) => {
      const inserted = await tx
        .insert(enrollmentTokens)
        .values({
          id,
          tokenId,
          secretHash: sha256Hex(secret),
          label: input.label,
          createdBy: actor.actorId,
          createdAt: new Date(now),
          expiresAt: new Date(now + input.expiresInMinutes * 60_000),
          requiresApproval: input.requiresApproval,
          tags: input.tags,
          location: input.location,
        })
        .returning();
      await this.audit.record(
        {
          ...actor,
          action: "node.enrollment_token.create",
          targetType: "enrollment_token",
          targetId: id,
          outcome: "success",
          details: { tokenId, label: input.label, expiresInMinutes: input.expiresInMinutes, requiresApproval: input.requiresApproval },
        },
        tx,
      );
      return inserted;
    });
    if (!row) throw new Error("enrollment token insert failed");
    return { token: this.toDto(row, actor.actorName), secretToken, installCommand: this.installCommand(secretToken) };
  }

  async list(): Promise<EnrollmentToken[]> {
    const rows = await this.db
      .select({ token: enrollmentTokens, email: users.email })
      .from(enrollmentTokens)
      .leftJoin(users, eq(users.id, enrollmentTokens.createdBy))
      .orderBy(desc(enrollmentTokens.createdAt))
      .limit(200);
    return rows.map((r) => this.toDto(r.token, r.email ?? null));
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const deleted = await tx.delete(enrollmentTokens).where(eq(enrollmentTokens.id, id)).returning({ tokenId: enrollmentTokens.tokenId });
      if (deleted.length === 0) throw notFound("Enrollment token");
      await this.audit.record(
        { ...actor, action: "node.enrollment_token.delete", targetType: "enrollment_token", targetId: id, outcome: "success", details: { tokenId: deleted[0]?.tokenId } },
        tx,
      );
    });
  }

  /** `POST /agent/v1/enroll`: redeems a single-use token and registers the node + its public key. */
  async enroll(req: EnrollRequest, ip: string | null): Promise<EnrollResponse> {
    if (req.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      throw badRequest(`Unsupported protocol version ${req.protocolVersion} (expected ${AGENT_PROTOCOL_VERSION})`);
    }
    if (!ed25519PublicKeyFromRaw(req.publicKey)) throw badRequest("publicKey is not a valid Ed25519 public key");
    const m = ENROLLMENT_TOKEN_PATTERN.exec(req.token);
    if (!m) throw invalidToken();
    const [, tokenId = "", secret = ""] = m;
    const now = this.clock.now();
    const nodeId = randomUUID();

    const result = await withTransaction(this.db, async (tx, after) => {
      const [token] = await tx.select().from(enrollmentTokens).where(eq(enrollmentTokens.tokenId, tokenId)).for("update").limit(1);
      // Same error for unknown, wrong secret, used and expired (deliberately indistinguishable).
      const secretOk = token ? safeEqual(sha256Hex(secret), token.secretHash) : (safeEqual(sha256Hex(secret), "0".repeat(64)), false);
      if (!token || !secretOk || token.usedAt || token.expiresAt.getTime() <= now) {
        await this.audit.record(
          {
            actorType: "node",
            actorId: null,
            actorName: req.nodeName ?? req.facts.hostname,
            ip,
            action: "node.enroll",
            outcome: "denied",
            details: { tokenId, reason: !token ? "unknown token" : !secretOk ? "wrong secret" : token.usedAt ? "already used" : "expired" },
          },
        );
        return null;
      }
      const [dupKey] = await tx
        .select({ id: nodeCredentials.id })
        .from(nodeCredentials)
        .where(and(eq(nodeCredentials.publicKey, req.publicKey), inArray(nodeCredentials.status, ["active", "pending"])))
        .limit(1);
      if (dupKey) throw conflict("This public key is already registered to a node");

      const baseName = (req.nodeName ?? req.facts.hostname).trim().slice(0, 80) || "node";
      const baseSlug = slugify(baseName);
      const taken = await tx
        .select({ name: nodes.name, slug: nodes.slug })
        .from(nodes)
        .where(or(like(nodes.name, `${baseName.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), like(nodes.slug, `${baseSlug}%`)));
      const names = new Set(taken.map((t) => t.name));
      const slugs = new Set(taken.map((t) => t.slug));
      let name = baseName;
      let slug = baseSlug;
      for (let i = 2; names.has(name) || slugs.has(slug); i++) {
        name = `${baseName.slice(0, 74)}-${i}`;
        slug = `${baseSlug.slice(0, 44)}-${i}`;
      }
      const status = token.requiresApproval ? "pending" : "active";
      const [row] = await tx
        .insert(nodes)
        .values({
          id: nodeId,
          name,
          slug,
          status,
          connection: "offline",
          location: token.location,
          tags: token.tags,
          facts: req.facts,
          agentVersion: req.agentVersion,
          lastSeenIp: ip,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        })
        .returning();
      await tx.insert(nodeCredentials).values({ id: randomUUID(), nodeId, publicKey: req.publicKey, status: "active", activatedAt: new Date(now) });
      await tx.update(enrollmentTokens).set({ usedAt: new Date(now), usedByNodeId: nodeId }).where(eq(enrollmentTokens.id, token.id));
      await this.audit.record(
        {
          actorType: "node",
          actorId: nodeId,
          actorName: name,
          ip,
          action: "node.enroll",
          targetType: "node",
          targetId: nodeId,
          outcome: "success",
          details: { tokenId, status, agentVersion: req.agentVersion, hostname: req.facts.hostname },
        },
        tx,
      );
      await this.bus.publish({ type: "node.enrolled", subjectType: "node", subjectId: nodeId, data: { status, name } }, { tx, after });
      return { row, status };
    });
    if (!result?.row) throw invalidToken();
    this.tracker.upsertFromRow(result.row);
    this.logger.info({ nodeId, name: result.row.name, status: result.status }, "node enrolled");
    return {
      nodeId,
      approved: result.status === "active",
      controlPlaneSigningKey: this.signingPublicKey,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      metricsIntervalMs: this.config.metricsIntervalMs,
    };
  }
}
