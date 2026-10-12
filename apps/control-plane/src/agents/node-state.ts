import type { NodeConnection, NodeFacts, NodeStatus } from "@blockforge/contracts";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { nodes } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import { deriveConnection } from "./connection.js";

export interface NodeRuntime {
  id: string;
  name: string;
  status: NodeStatus;
  connection: NodeConnection;
  facts: NodeFacts | null;
  lastHeartbeatAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastDisconnectClean: boolean;
  clockSkewMs: number | null;
  /** Recent `agent.warning` events (most recent last, bounded). */
  warnings: { at: number; code: string; message: string }[];
}

export interface ConnectionChange {
  nodeId: string;
  from: NodeConnection;
  to: NodeConnection;
}

/**
 * In-memory view of every node's connectivity, loaded from the database at start-up and kept current
 * by the gateway. `evaluate` applies the state machine; changes are persisted and reported to
 * `onChange` listeners (domain event + realtime fan-out are wired in app.ts).
 */
export class NodeStateTracker {
  private readonly nodes = new Map<string, NodeRuntime>();
  private readonly listeners: ((change: ConnectionChange, node: NodeRuntime) => void | Promise<void>)[] = [];
  private heartbeatPersistedAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: { heartbeatIntervalMs: number; offlineAfterMs: number },
    private readonly sessionReady: (nodeId: string) => boolean,
  ) {}

  onChange(fn: (change: ConnectionChange, node: NodeRuntime) => void | Promise<void>): void {
    this.listeners.push(fn);
  }

  async load(): Promise<void> {
    const rows = await this.db.select().from(nodes);
    this.nodes.clear();
    for (const r of rows) this.upsertFromRow(r);
  }

  upsertFromRow(r: typeof nodes.$inferSelect): NodeRuntime {
    const existing = this.nodes.get(r.id);
    const rt: NodeRuntime = {
      id: r.id,
      name: r.name,
      status: r.status as NodeStatus,
      connection: (existing?.connection ?? r.connection) as NodeConnection,
      facts: r.facts ?? null,
      lastHeartbeatAt: existing?.lastHeartbeatAt ?? r.lastHeartbeatAt?.getTime() ?? null,
      lastConnectedAt: existing?.lastConnectedAt ?? r.lastConnectedAt?.getTime() ?? null,
      // After a control-plane restart the old session is gone: treat the last heartbeat as the disconnect time.
      lastDisconnectedAt: existing?.lastDisconnectedAt ?? r.lastDisconnectedAt?.getTime() ?? r.lastHeartbeatAt?.getTime() ?? null,
      lastDisconnectClean: existing?.lastDisconnectClean ?? r.lastDisconnectClean,
      clockSkewMs: existing?.clockSkewMs ?? r.clockSkewMs ?? null,
      warnings: existing?.warnings ?? [],
    };
    this.nodes.set(r.id, rt);
    return rt;
  }

  get(nodeId: string): NodeRuntime | undefined {
    return this.nodes.get(nodeId);
  }

  all(): NodeRuntime[] {
    return [...this.nodes.values()];
  }

  remove(nodeId: string): void {
    this.nodes.delete(nodeId);
    this.heartbeatPersistedAt.delete(nodeId);
  }

  setStatus(nodeId: string, status: NodeStatus, name?: string): void {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    n.status = status;
    if (name) n.name = name;
  }

  async connected(
    nodeId: string,
    info: { facts: NodeFacts; agentVersion: string; clockSkewMs: number; ip: string | null },
  ): Promise<void> {
    const now = this.clock.now();
    const n = this.nodes.get(nodeId);
    if (n) {
      n.facts = info.facts;
      n.lastConnectedAt = now;
      n.lastHeartbeatAt = now;
      n.clockSkewMs = info.clockSkewMs;
    }
    await this.db
      .update(nodes)
      .set({
        facts: info.facts,
        agentVersion: info.agentVersion,
        lastConnectedAt: new Date(now),
        lastHeartbeatAt: new Date(now),
        clockSkewMs: Math.round(info.clockSkewMs),
        lastSeenIp: info.ip,
        updatedAt: new Date(now),
      })
      .where(eq(nodes.id, nodeId));
    this.heartbeatPersistedAt.set(nodeId, now);
    await this.evaluate(nodeId);
  }

  async heartbeat(nodeId: string, clockSkewMs: number): Promise<void> {
    const now = this.clock.now();
    const n = this.nodes.get(nodeId);
    if (!n) return;
    n.lastHeartbeatAt = now;
    n.clockSkewMs = clockSkewMs;
    // Persist at most once per heartbeat interval.
    const last = this.heartbeatPersistedAt.get(nodeId) ?? 0;
    if (now - last >= this.opts.heartbeatIntervalMs) {
      this.heartbeatPersistedAt.set(nodeId, now);
      await this.db
        .update(nodes)
        .set({ lastHeartbeatAt: new Date(now), clockSkewMs: Math.round(clockSkewMs) })
        .where(eq(nodes.id, nodeId));
    }
    if (n.connection !== "online") await this.evaluate(nodeId);
  }

  async disconnected(nodeId: string, clean: boolean): Promise<void> {
    const now = this.clock.now();
    const n = this.nodes.get(nodeId);
    if (n) {
      n.lastDisconnectedAt = now;
      n.lastDisconnectClean = clean;
    }
    await this.db
      .update(nodes)
      .set({ lastDisconnectedAt: new Date(now), lastDisconnectClean: clean })
      .where(eq(nodes.id, nodeId));
    await this.evaluate(nodeId);
  }

  recordWarning(nodeId: string, code: string, message: string): void {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    n.warnings.push({ at: this.clock.now(), code, message: message.slice(0, 1024) });
    if (n.warnings.length > 20) n.warnings.splice(0, n.warnings.length - 20);
  }

  /** Re-derives a node's connection state; persists and notifies on change. */
  async evaluate(nodeId: string): Promise<NodeConnection | null> {
    const n = this.nodes.get(nodeId);
    if (!n) return null;
    const next = deriveConnection({
      status: n.status,
      sessionReady: this.sessionReady(nodeId),
      lastHeartbeatAt: n.lastHeartbeatAt,
      lastConnectedAt: n.lastConnectedAt,
      lastDisconnectedAt: n.lastDisconnectedAt,
      lastDisconnectClean: n.lastDisconnectClean,
      clockSkewMs: n.clockSkewMs,
      runtimeHealthy: n.facts ? Boolean(n.facts.containerRuntime?.healthy) : null,
      now: this.clock.now(),
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
      offlineAfterMs: this.opts.offlineAfterMs,
    });
    if (next === n.connection) return next;
    const change: ConnectionChange = { nodeId, from: n.connection, to: next };
    n.connection = next;
    await this.db.update(nodes).set({ connection: next }).where(eq(nodes.id, nodeId));
    this.logger.info(change, "node connection changed");
    for (const fn of this.listeners) {
      try {
        await fn(change, n);
      } catch (err) {
        this.logger.error({ err, nodeId }, "connection change listener failed");
      }
    }
    return next;
  }

  /** Periodic sweep over all nodes (missed heartbeats, offline transitions). */
  async sweep(): Promise<void> {
    for (const id of [...this.nodes.keys()]) await this.evaluate(id);
  }
}
