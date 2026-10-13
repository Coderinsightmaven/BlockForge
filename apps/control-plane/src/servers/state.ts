import { canStartOperation, canTransition, type ServerOperation, type ServerState } from "@blockforge/contracts";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db, DbOrTx } from "../db/client.js";
import { jobs, servers } from "../db/schema/index.js";
import type { AfterCommit } from "../db/tx.js";
import type { EventBus } from "../events/bus.js";
import type { Clock } from "../lib/clock.js";
import { invalidState, notFound } from "../lib/errors.js";

export type ServerRow = typeof servers.$inferSelect;

/** State an operation moves the server into while it runs. */
export function transitionalStateFor(op: ServerOperation, from: ServerState): ServerState {
  switch (op) {
    case "provision":
    case "reinstall":
      return "provisioning";
    case "start":
      return "starting";
    case "stop":
      return "stopping";
    case "restart":
      return from === "crashed" ? "starting" : "stopping";
    case "kill":
      return from === "stopping" ? "stopping" : from;
    case "delete":
      return "deleting";
    case "update":
      return "updating";
    case "backup":
      return "backing_up";
    case "restore":
      // From running/degraded the restore job stops the server first (stopping → stopped → restoring).
      return from === "running" || from === "degraded" ? "stopping" : "restoring";
    case "migrate":
      return "migrating";
    case "extensions":
      // Plugin/mod changes leave the lifecycle state alone.
      return from;
  }
}

export interface StateChange {
  serverId: string;
  from: ServerState;
  to: ServerState;
}

/**
 * Server lifecycle bookkeeping: per-server operation locks (`active_operation` / `active_job_id`)
 * and state transitions validated against the contracts state machine. Every change is followed by
 * `server.state.changed` and the `onChange` listeners (realtime fan-out).
 */
export class ServerStateService {
  private readonly listeners: ((serverId: string) => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  onChange(fn: (serverId: string) => void): void {
    this.listeners.push(fn);
  }

  notify(serverId: string): void {
    for (const fn of this.listeners) {
      try {
        fn(serverId);
      } catch (err) {
        this.logger.debug({ err }, "server change listener failed");
      }
    }
  }

  /**
   * Takes the operation lock inside `tx` (row locked) and moves the server into the operation's
   * transitional state. Throws 409 INVALID_STATE when the state or a running operation forbids it.
   */
  async begin(tx: DbOrTx, serverId: string, op: ServerOperation): Promise<{ row: ServerRow; from: ServerState; to: ServerState }> {
    const [row] = await tx.select().from(servers).where(eq(servers.id, serverId)).for("update").limit(1);
    if (!row) throw notFound("Server");
    const from = row.state as ServerState;
    const active = (row.activeOperation as ServerOperation | null) ?? null;
    if (op === "delete" && from === "provisioning" && active) throw invalidState("The server is still being provisioned");
    if (!canStartOperation(op, from, active)) {
      throw invalidState(active ? `Another operation (${active}) is in progress` : `Cannot ${op} a server that is ${from}`, { state: from, activeOperation: active });
    }
    const to = transitionalStateFor(op, from);
    await tx
      .update(servers)
      .set({ activeOperation: op, state: to, updatedAt: new Date(this.clock.now()) })
      .where(eq(servers.id, serverId));
    return { row, from, to };
  }

  /**
   * Takes the operation lock for `op` without a state change (`extensions`), inside `tx` (row locked).
   * `jobId` null = a short synchronous change (released with `unlock`). A lock still held by a job that
   * already ended (crash between its finalize and the release) is taken over. Throws 409 INVALID_STATE
   * like `begin` while another operation runs or the state forbids it.
   */
  async lock(tx: DbOrTx, serverId: string, op: Extract<ServerOperation, "extensions">, jobId: string | null): Promise<ServerRow> {
    const [row] = await tx.select().from(servers).where(eq(servers.id, serverId)).for("update").limit(1);
    if (!row) throw notFound("Server");
    const from = row.state as ServerState;
    let active = (row.activeOperation as ServerOperation | null) ?? null;
    if (active === op && row.activeJobId && row.activeJobId !== jobId) {
      const [j] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, row.activeJobId));
      if (!j || (j.status !== "queued" && j.status !== "running")) active = null;
    }
    if (active === op && jobId !== null && row.activeJobId === jobId) return row;
    if (!canStartOperation(op, from, active)) {
      throw invalidState(active ? `Another operation (${active}) is in progress` : `Cannot change plugins/mods of a server that is ${from}`, { state: from, activeOperation: active });
    }
    await tx.update(servers).set({ activeOperation: op, activeJobId: jobId, updatedAt: new Date(this.clock.now()) }).where(eq(servers.id, serverId));
    return row;
  }

  /** Releases a synchronous (`jobId` null) `lock`. */
  async unlock(serverId: string, op: Extract<ServerOperation, "extensions">): Promise<void> {
    const rows = await this.db
      .update(servers)
      .set({ activeOperation: null, updatedAt: new Date(this.clock.now()) })
      .where(and(eq(servers.id, serverId), eq(servers.activeOperation, op), isNull(servers.activeJobId)))
      .returning({ id: servers.id });
    if (rows.length) this.notify(serverId);
  }

  /** True while `jobId` holds the server's operation lock for `op` (re-checked by long jobs at every step). */
  async holds(serverId: string, op: ServerOperation, jobId: string): Promise<boolean> {
    const [row] = await this.db.select({ op: servers.activeOperation, job: servers.activeJobId }).from(servers).where(eq(servers.id, serverId));
    return row?.op === op && row.job === jobId;
  }

  /**
   * Synchronous locks (no job) left behind by a crashed request are released after `olderThanMs`
   * (a synchronous change takes seconds; a job's lock is released by its finalize).
   */
  async releaseStaleLocks(op: Extract<ServerOperation, "extensions">, olderThanMs: number): Promise<number> {
    const rows = await this.db
      .update(servers)
      .set({ activeOperation: null, updatedAt: new Date(this.clock.now()) })
      .where(and(eq(servers.activeOperation, op), isNull(servers.activeJobId), lt(servers.updatedAt, new Date(this.clock.now() - olderThanMs))))
      .returning({ id: servers.id });
    for (const r of rows) this.notify(r.id);
    return rows.length;
  }

  async attachJob(tx: DbOrTx, serverId: string, jobId: string): Promise<void> {
    await tx.update(servers).set({ activeJobId: jobId }).where(eq(servers.id, serverId));
  }

  /** Releases the lock if it is still held by `jobId` (a pre-empting kill may have taken it over). */
  async end(serverId: string, jobId: string): Promise<boolean> {
    const rows = await this.db
      .update(servers)
      .set({ activeOperation: null, activeJobId: null, updatedAt: new Date(this.clock.now()) })
      .where(and(eq(servers.id, serverId), eq(servers.activeJobId, jobId)))
      .returning({ id: servers.id });
    if (rows.length) this.notify(serverId);
    return rows.length > 0;
  }

  /**
   * Moves the server to `to` if the transition is allowed (same state = no-op). Returns false and
   * logs when the state machine forbids it. `extra` columns are written in the same update.
   */
  async transition(
    serverId: string,
    to: ServerState,
    extra: Partial<ServerRow> = {},
    opts: { tx?: DbOrTx; after?: AfterCommit; reason?: string } = {},
  ): Promise<boolean> {
    const db = opts.tx ?? this.db;
    const [row] = await db.select({ state: servers.state }).from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) return false;
    const from = row.state as ServerState;
    if (from !== to && !canTransition(from, to)) {
      this.logger.warn({ serverId, from, to, reason: opts.reason }, "server state transition rejected by the state machine");
      return false;
    }
    await db
      .update(servers)
      .set({ ...extra, state: to, updatedAt: new Date(this.clock.now()) })
      .where(and(eq(servers.id, serverId), eq(servers.state, from)));
    if (from !== to) {
      await this.bus.publish(
        { type: "server.state.changed", subjectType: "server", subjectId: serverId, data: { from, to, reason: opts.reason ?? null } },
        opts.tx && opts.after ? { tx: opts.tx, after: opts.after } : {},
      );
    }
    if (opts.after) opts.after.add(() => this.notify(serverId));
    else this.notify(serverId);
    return true;
  }
}
