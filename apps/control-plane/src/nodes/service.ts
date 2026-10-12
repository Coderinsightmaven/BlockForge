import type { Node, NodeConnection, NodeStatus } from "@blockforge/contracts";
import { and, count, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { CLOSE, type AgentGateway } from "../agents/gateway.js";
import type { NodeStateTracker } from "../agents/node-state.js";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { alertIncidents, alertRules, nodeCredentials, nodes, resourceReservations, roleBindings, servers } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { EventBus } from "../events/bus.js";
import type { Clock } from "../lib/clock.js";
import { conflict, invalidState, notFound } from "../lib/errors.js";
import type { LatestCache } from "../metrics/latest.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { computeCapacity } from "./capacity.js";

type NodeRow = typeof nodes.$inferSelect;

export interface UpdateNodeInput {
  name?: string | undefined;
  location?: string | null | undefined;
  tags?: string[] | undefined;
  publicAddress?: string | null | undefined;
  privateAddress?: string | null | undefined;
  schedulingEnabled?: boolean | undefined;
  cpuAllocatableMillicores?: number | undefined;
  memoryAllocatableBytes?: number | undefined;
  storageAllocatableBytes?: number | undefined;
  overcommitMemoryRatio?: number | undefined;
  status?: "active" | "draining" | "maintenance" | "disabled" | undefined;
}

export class NodesService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly tracker: NodeStateTracker,
    private readonly gateway: AgentGateway,
    private readonly latest: LatestCache,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
    private readonly hub: RealtimeHub,
    private readonly logger: Logger,
  ) {}

  async rows(ids: "all" | string[]): Promise<NodeRow[]> {
    if (ids !== "all" && ids.length === 0) return [];
    return this.db
      .select()
      .from(nodes)
      .where(ids === "all" ? undefined : inArray(nodes.id, ids))
      .orderBy(nodes.name);
  }

  async row(id: string): Promise<NodeRow> {
    const [row] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!row) throw notFound("Node");
    return row;
  }

  async toDtos(rows: NodeRow[]): Promise<Node[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const now = new Date(this.clock.now());
    const reserved = await this.db
      .select({
        nodeId: resourceReservations.nodeId,
        cpu: sql<string>`coalesce(sum(${resourceReservations.cpuMillicores}), 0)`,
        memory: sql<string>`coalesce(sum(${resourceReservations.memoryBytes}), 0)`,
        storage: sql<string>`coalesce(sum(${resourceReservations.storageBytes}), 0)`,
      })
      .from(resourceReservations)
      .where(
        and(
          inArray(resourceReservations.nodeId, ids),
          or(isNull(resourceReservations.expiresAt), gt(resourceReservations.expiresAt, now)),
        ),
      )
      .groupBy(resourceReservations.nodeId);
    const serverCounts = await this.db
      .select({ nodeId: servers.nodeId, n: count() })
      .from(servers)
      .where(inArray(servers.nodeId, ids))
      .groupBy(servers.nodeId);
    const res = new Map(reserved.map((r) => [r.nodeId, r]));
    const counts = new Map(serverCounts.map((r) => [r.nodeId, Number(r.n)]));
    return rows.map((r) => {
      const rt = this.tracker.get(r.id);
      const rr = res.get(r.id);
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status as NodeStatus,
        connection: (rt?.connection ?? r.connection) as NodeConnection,
        location: r.location,
        tags: r.tags,
        publicAddress: r.publicAddress,
        privateAddress: r.privateAddress,
        schedulingEnabled: r.schedulingEnabled,
        agentVersion: r.agentVersion,
        lastHeartbeatAt: rt?.lastHeartbeatAt ?? r.lastHeartbeatAt?.getTime() ?? null,
        lastConnectedAt: rt?.lastConnectedAt ?? r.lastConnectedAt?.getTime() ?? null,
        clockSkewMs: rt?.clockSkewMs !== null && rt?.clockSkewMs !== undefined ? Math.round(rt.clockSkewMs) : (r.clockSkewMs ?? null),
        facts: r.facts ?? null,
        capacity: computeCapacity(r, r.facts ?? null, {
          cpuMillicores: Number(rr?.cpu ?? 0),
          memoryBytes: Number(rr?.memory ?? 0),
          storageBytes: Number(rr?.storage ?? 0),
        }),
        serverCount: counts.get(r.id) ?? 0,
        latest: this.latest.getNode(r.id),
        createdAt: r.createdAt.getTime(),
      };
    });
  }

  async get(id: string): Promise<Node> {
    const [dto] = await this.toDtos([await this.row(id)]);
    if (!dto) throw notFound("Node");
    return dto;
  }

  /** Pushes `node.updated` to `nodes` (scope-filtered) and `node:<id>` subscribers. */
  async publishUpdated(id: string): Promise<void> {
    const topic = `node:${id}`;
    if (!this.hub.hasSubscribers(topic) && !this.hub.hasSubscribers("nodes")) return;
    try {
      const dto = await this.get(id);
      this.hub.publish(topic, "node.updated", dto);
      this.hub.publish("nodes", "node.updated", dto, { permission: "nodes.view", resource: { type: "node", id } });
    } catch (err) {
      this.logger.debug({ err, nodeId: id }, "node.updated not published");
    }
  }

  async update(id: string, input: UpdateNodeInput, actor: AuditActor): Promise<Node> {
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.select().from(nodes).where(eq(nodes.id, id)).for("update").limit(1);
      if (!row) throw notFound("Node");
      if (row.status === "revoked") throw invalidState("A revoked node cannot be modified");
      if (input.status && row.status === "pending") throw invalidState("Approve the node before changing its status");
      if (input.name && input.name !== row.name) {
        const [dup] = await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.name, input.name)).limit(1);
        if (dup) throw conflict("Another node already uses this name");
      }
      const { overcommitMemoryRatio, ...rest } = input;
      await tx
        .update(nodes)
        .set({
          ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          ...(overcommitMemoryRatio !== undefined ? { overcommitMemoryRatio: overcommitMemoryRatio.toFixed(2) } : {}),
          updatedAt: new Date(this.clock.now()),
          version: row.version + 1,
        })
        .where(eq(nodes.id, id));
      await this.audit.record({ ...actor, action: "node.update", targetType: "node", targetId: id, outcome: "success", details: { ...input } }, tx);
    });
    const row = await this.row(id);
    this.tracker.setStatus(id, row.status as NodeStatus, row.name);
    if (input.status === "disabled") this.gateway.disconnect(id, CLOSE.revoked, "node disabled");
    await this.tracker.evaluate(id);
    void this.publishUpdated(id);
    return this.get(id);
  }

  async approve(id: string, actor: AuditActor): Promise<Node> {
    await withTransaction(this.db, async (tx, after) => {
      const [row] = await tx.select().from(nodes).where(eq(nodes.id, id)).for("update").limit(1);
      if (!row) throw notFound("Node");
      if (row.status !== "pending") throw invalidState(`Node is ${row.status}, not pending approval`);
      await tx.update(nodes).set({ status: "active", updatedAt: new Date(this.clock.now()), version: row.version + 1 }).where(eq(nodes.id, id));
      await this.audit.record({ ...actor, action: "node.approve", targetType: "node", targetId: id, outcome: "success" }, tx);
      await this.bus.publish({ type: "node.approved", subjectType: "node", subjectId: id, data: { name: row.name } }, { tx, after });
    });
    this.tracker.setStatus(id, "active");
    this.gateway.sendWelcome(id, true);
    await this.tracker.evaluate(id);
    void this.publishUpdated(id);
    return this.get(id);
  }

  /** Revokes every credential, closes the session and blocks future authentication. */
  async revoke(id: string, actor: AuditActor): Promise<Node> {
    await withTransaction(this.db, async (tx, after) => {
      const [row] = await tx.select().from(nodes).where(eq(nodes.id, id)).for("update").limit(1);
      if (!row) throw notFound("Node");
      if (row.status === "revoked") throw invalidState("Node is already revoked");
      const now = new Date(this.clock.now());
      await tx.update(nodes).set({ status: "revoked", schedulingEnabled: false, updatedAt: now, version: row.version + 1 }).where(eq(nodes.id, id));
      await tx
        .update(nodeCredentials)
        .set({ status: "revoked", revokedAt: now })
        .where(and(eq(nodeCredentials.nodeId, id), inArray(nodeCredentials.status, ["active", "pending"])));
      await this.audit.record({ ...actor, action: "node.revoke", targetType: "node", targetId: id, outcome: "success" }, tx);
      await this.bus.publish({ type: "node.revoked", subjectType: "node", subjectId: id, data: { name: row.name } }, { tx, after });
    });
    this.tracker.setStatus(id, "revoked");
    this.gateway.disconnect(id, CLOSE.revoked, "node revoked");
    this.latest.removeNode(id);
    await this.tracker.evaluate(id);
    void this.publishUpdated(id);
    return this.get(id);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.select().from(nodes).where(eq(nodes.id, id)).for("update").limit(1);
      if (!row) throw notFound("Node");
      const [hosted] = await tx.select({ n: count() }).from(servers).where(eq(servers.nodeId, id));
      if (Number(hosted?.n ?? 0) > 0) throw conflict("The node still hosts servers; migrate or delete them first");
      const now = new Date(this.clock.now());
      // Expired provisioning holds do not block deletion; live ones do.
      await tx.delete(resourceReservations).where(and(eq(resourceReservations.nodeId, id), lte(resourceReservations.expiresAt, now)));
      const [live] = await tx.select({ n: count() }).from(resourceReservations).where(eq(resourceReservations.nodeId, id));
      if (Number(live?.n ?? 0) > 0) throw conflict("The node has active resource reservations");
      // Scope references are polymorphic (no FK): remove grants and alert rules scoped to this node.
      await tx.delete(roleBindings).where(and(eq(roleBindings.scopeType, "node"), eq(roleBindings.scopeId, id)));
      await tx.delete(alertRules).where(and(eq(alertRules.scopeType, "node"), eq(alertRules.scopeId, id)));
      // Incidents about the node would otherwise stay open forever (and only global viewers could see them).
      await tx
        .update(alertIncidents)
        .set({ status: "resolved", resolvedAt: now })
        .where(and(eq(alertIncidents.subjectType, "node"), eq(alertIncidents.subjectId, id), ne(alertIncidents.status, "resolved")));
      await tx.delete(nodes).where(eq(nodes.id, id));
      await this.audit.record({ ...actor, action: "node.delete", targetType: "node", targetId: id, outcome: "success", details: { name: row.name } }, tx);
    });
    this.gateway.disconnect(id, CLOSE.revoked, "node deleted");
    this.tracker.remove(id);
    this.latest.removeNode(id);
  }
}
