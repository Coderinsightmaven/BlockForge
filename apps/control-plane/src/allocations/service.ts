import { randomUUID } from "node:crypto";
import { expandPortList, type Allocation } from "@blockforge/contracts";
import { and, asc, count, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentGateway } from "../agents/gateway.js";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db, DbOrTx } from "../db/client.js";
import { allocations, nodes, servers } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import { badRequest, conflict, invalidState, notFound, validationDetails } from "../lib/errors.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";

type AllocationRow = typeof allocations.$inferSelect;
const PortCursor = z.object({ p: z.number().int(), id: z.uuid() });

/** Ports below this are privileged on most systems; containers bind them through Docker, but warn anyway. */
const PRIVILEGED_PORT_LIMIT = 1024;

export interface ServerAllocationChange {
  allocation: Allocation;
  restartRequired: boolean;
}

/** Node IP:port pools and their assignment to servers (Pterodactyl "allocations"). */
export class AllocationsService {
  constructor(
    private readonly db: Db,
    private readonly gateway: AgentGateway,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async toDtos(rows: AllocationRow[], tx: DbOrTx = this.db): Promise<Allocation[]> {
    const serverIds = [...new Set(rows.map((r) => r.serverId).filter((x): x is string => Boolean(x)))];
    const names = new Map<string, string>();
    if (serverIds.length) {
      for (const s of await tx.select({ id: servers.id, name: servers.name }).from(servers).where(inArray(servers.id, serverIds))) names.set(s.id, s.name);
    }
    return rows.map((r) => ({
      id: r.id,
      nodeId: r.nodeId,
      ip: r.ip,
      port: r.port,
      alias: r.alias,
      notes: r.notes,
      serverId: r.serverId,
      serverName: r.serverId ? (names.get(r.serverId) ?? null) : null,
      primary: r.isPrimary,
      createdAt: r.createdAt.getTime(),
    }));
  }

  async listForNode(nodeId: string, q: { limit: number; cursor?: string | undefined; free?: boolean | undefined }): Promise<{ items: Allocation[]; nextCursor: string | null }> {
    const cursor = decodeCursor(PortCursor, q.cursor);
    const conds: SQL[] = [eq(allocations.nodeId, nodeId)];
    if (q.free === true) conds.push(isNull(allocations.serverId));
    if (q.free === false) conds.push(sql`${allocations.serverId} IS NOT NULL`);
    if (cursor) conds.push(or(gt(allocations.port, cursor.p), and(eq(allocations.port, cursor.p), gt(allocations.id, cursor.id))) as SQL);
    const rows = await this.db
      .select()
      .from(allocations)
      .where(and(...conds))
      .orderBy(asc(allocations.port), asc(allocations.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: await this.toDtos(page), nextCursor: rows.length > q.limit && last ? encodeCursor({ p: last.port, id: last.id }) : null };
  }

  async create(nodeId: string, input: { ip: string; ports: string; alias: string | null }, actor: AuditActor): Promise<{ created: number; skipped: number[]; warnings: string[] }> {
    const [node] = await this.db.select({ id: nodes.id, status: nodes.status }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw notFound("Node");
    if (node.status === "revoked") throw invalidState("A revoked node cannot get allocations");
    let ports: number[];
    try {
      ports = expandPortList(input.ports);
    } catch (err) {
      throw badRequest((err as Error).message, validationDetails((err as Error).message, "ports"));
    }
    if (ports.length === 0) throw badRequest("No ports given", validationDetails("no ports", "ports"));
    const inserted = await this.db
      .insert(allocations)
      .values(ports.map((port) => ({ id: randomUUID(), nodeId, ip: input.ip, port, alias: input.alias })))
      .onConflictDoNothing()
      .returning({ port: allocations.port });
    const createdPorts = new Set(inserted.map((r) => r.port));
    const skipped = ports.filter((p) => !createdPorts.has(p));
    const warnings: string[] = [];
    const privileged = ports.filter((p) => p < PRIVILEGED_PORT_LIMIT);
    if (privileged.length) warnings.push(`Ports below ${PRIVILEGED_PORT_LIMIT} (${privileged.slice(0, 10).join(", ")}) are privileged and often used by system services.`);
    warnings.push(...(await this.portWarnings(nodeId, [...createdPorts])));
    await this.audit.record({
      ...actor,
      action: "allocations.create",
      targetType: "node",
      targetId: nodeId,
      outcome: "success",
      details: { ip: input.ip, ports: input.ports, created: createdPorts.size, skipped: skipped.length },
    });
    return { created: createdPorts.size, skipped, warnings };
  }

  /** Ports the agent reports as already listening on the host (best effort; silent when offline). */
  async portWarnings(nodeId: string, ports: readonly number[]): Promise<string[]> {
    if (!ports.length || !this.gateway.isReady(nodeId)) return [];
    try {
      const res = await this.gateway.send(nodeId, "node.ports", {}, { timeoutMs: 5000 });
      const used = new Set([...res.tcp, ...res.udp]);
      const clash = ports.filter((p) => used.has(p));
      return clash.length ? [`Ports ${clash.slice(0, 20).join(", ")} are already in use on the node (likely by other software).`] : [];
    } catch (err) {
      this.logger.debug({ err, nodeId }, "node.ports unavailable");
      return [];
    }
  }

  async row(id: string): Promise<AllocationRow> {
    const [row] = await this.db.select().from(allocations).where(eq(allocations.id, id)).limit(1);
    if (!row) throw notFound("Allocation");
    return row;
  }

  async update(id: string, input: { alias?: string | null | undefined; notes?: string | null | undefined }, actor: AuditActor): Promise<Allocation> {
    const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const [row] = await this.db.update(allocations).set(set).where(eq(allocations.id, id)).returning();
    if (!row) throw notFound("Allocation");
    await this.audit.record({ ...actor, action: "allocations.update", targetType: "node", targetId: row.nodeId, outcome: "success", details: { allocationId: id, ...input } });
    const [dto] = await this.toDtos([row]);
    return dto as Allocation;
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const deleted = await this.db.delete(allocations).where(and(eq(allocations.id, id), isNull(allocations.serverId))).returning();
    if (!deleted.length) {
      await this.row(id);
      throw conflict("The allocation is assigned to a server");
    }
    await this.audit.record({ ...actor, action: "allocations.delete", targetType: "node", targetId: deleted[0]!.nodeId, outcome: "success", details: { allocationId: id, port: deleted[0]!.port } });
  }

  // --- Server-side ------------------------------------------------------------------------

  async forServer(serverId: string, tx: DbOrTx = this.db): Promise<AllocationRow[]> {
    return tx.select().from(allocations).where(eq(allocations.serverId, serverId)).orderBy(sql`${allocations.isPrimary} DESC`, asc(allocations.port));
  }

  /** Assigns the next free allocation of the server's node (prefers the primary's IP). */
  async assign(serverId: string, actor: AuditActor): Promise<ServerAllocationChange> {
    const row = await withTransaction(this.db, async (tx) => {
      const [srv] = await tx.select().from(servers).where(eq(servers.id, serverId)).for("update").limit(1);
      if (!srv) throw notFound("Server");
      const current = await this.forServer(serverId, tx);
      const additional = current.filter((a) => !a.isPrimary).length;
      if (additional >= srv.allocationLimit) throw conflict(`The server may use at most ${srv.allocationLimit} additional allocation(s)`);
      const primaryIp = current.find((a) => a.isPrimary)?.ip ?? null;
      const [free] = await tx
        .select()
        .from(allocations)
        .where(and(eq(allocations.nodeId, srv.nodeId), isNull(allocations.serverId)))
        .orderBy(primaryIp ? sql`(${allocations.ip} = ${primaryIp}::inet) DESC` : sql`1`, asc(allocations.port))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!free) throw conflict("No free allocation is left on this server's node");
      const [updated] = await tx.update(allocations).set({ serverId, isPrimary: false }).where(eq(allocations.id, free.id)).returning();
      await this.audit.record({ ...actor, action: "server.allocation.assign", targetType: "server", targetId: serverId, outcome: "success", details: { allocationId: free.id, ip: free.ip, port: free.port } }, tx);
      return updated as AllocationRow;
    });
    const [dto] = await this.toDtos([row]);
    return { allocation: dto as Allocation, restartRequired: true };
  }

  async updateForServer(serverId: string, allocationId: string, input: { notes?: string | null | undefined; primary?: true | undefined }, actor: AuditActor): Promise<ServerAllocationChange> {
    let restartRequired = false;
    const row = await withTransaction(this.db, async (tx) => {
      const [alloc] = await tx.select().from(allocations).where(and(eq(allocations.id, allocationId), eq(allocations.serverId, serverId))).for("update").limit(1);
      if (!alloc) throw notFound("Allocation");
      if (input.primary && !alloc.isPrimary) {
        await tx.update(allocations).set({ isPrimary: false }).where(and(eq(allocations.serverId, serverId), eq(allocations.isPrimary, true)));
        await tx.update(allocations).set({ isPrimary: true }).where(eq(allocations.id, allocationId));
        restartRequired = true;
      }
      if (input.notes !== undefined) await tx.update(allocations).set({ notes: input.notes }).where(eq(allocations.id, allocationId));
      const [fresh] = await tx.select().from(allocations).where(eq(allocations.id, allocationId));
      await this.audit.record({ ...actor, action: "server.allocation.update", targetType: "server", targetId: serverId, outcome: "success", details: { allocationId, primary: input.primary ?? false } }, tx);
      return fresh as AllocationRow;
    });
    const [dto] = await this.toDtos([row]);
    return { allocation: dto as Allocation, restartRequired };
  }

  async unassign(serverId: string, allocationId: string, actor: AuditActor): Promise<{ restartRequired: boolean }> {
    await withTransaction(this.db, async (tx) => {
      const [alloc] = await tx.select().from(allocations).where(and(eq(allocations.id, allocationId), eq(allocations.serverId, serverId))).for("update").limit(1);
      if (!alloc) throw notFound("Allocation");
      if (alloc.isPrimary) throw conflict("The primary allocation cannot be removed; make another allocation primary first");
      await tx.update(allocations).set({ serverId: null, isPrimary: false, notes: null }).where(eq(allocations.id, allocationId));
      await this.audit.record({ ...actor, action: "server.allocation.remove", targetType: "server", targetId: serverId, outcome: "success", details: { allocationId, port: alloc.port } }, tx);
    });
    return { restartRequired: true };
  }

  /** Releases every allocation of a server (deletion). */
  async releaseAll(serverId: string, tx: DbOrTx): Promise<void> {
    await tx.update(allocations).set({ serverId: null, isPrimary: false, notes: null }).where(eq(allocations.serverId, serverId));
  }

  async freeCount(nodeIds: readonly string[]): Promise<Map<string, number>> {
    if (!nodeIds.length) return new Map();
    const rows = await this.db
      .select({ nodeId: allocations.nodeId, n: count() })
      .from(allocations)
      .where(and(inArray(allocations.nodeId, [...nodeIds]), isNull(allocations.serverId)))
      .groupBy(allocations.nodeId);
    return new Map(rows.map((r) => [r.nodeId, Number(r.n)]));
  }
}
