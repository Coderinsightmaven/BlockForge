import { canStartOperation, canTransition, type ServerOperation, type ServerState } from "@blockforge/contracts";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
   * The operation actually in progress: a lock still held by a job that already ended (its finalize
   * failed or never ran) or an `extensions` lock without any holder (its job row was deleted) is stale
   * and may be taken over.
   */
  private async liveOperation(tx: DbOrTx, row: ServerRow): Promise<ServerOperation | null> {
    const active = (row.activeOperation as ServerOperation | null) ?? null;
    if (!active) return null;
    if (row.activeJobId) {
      const [j] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, row.activeJobId));
      if (!j || (j.status !== "queued" && j.status !== "running")) return null;
    } else if (active === "extensions" && !row.operationToken) return null;
    return active;
  }

  /**
   * Takes the operation lock inside `tx` (row locked) and moves the server into the operation's
   * transitional state. Throws 409 INVALID_STATE when the state or a running operation forbids it.
   * Stop/restart/kill on a running server may pre-empt an `extensions` operation (contracts
   * `canStartOperation`); its holder notices the lost lock at its next re-check.
   */
  async begin(tx: DbOrTx, serverId: string, op: ServerOperation): Promise<{ row: ServerRow; from: ServerState; to: ServerState }> {
    const [row] = await tx.select().from(servers).where(eq(servers.id, serverId)).for("update").limit(1);
    if (!row) throw notFound("Server");
    const from = row.state as ServerState;
    const active = await this.liveOperation(tx, row);
    if (op === "delete" && from === "provisioning" && active) throw invalidState("The server is still being provisioned");
    if (!canStartOperation(op, from, active)) {
      throw invalidState(active ? `Another operation (${active}) is in progress` : `Cannot ${op} a server that is ${from}`, { state: from, activeOperation: active });
    }
    const to = transitionalStateFor(op, from);
    const now = new Date(this.clock.now());
    await tx
      .update(servers)
      .set({ activeOperation: op, activeJobId: null, operationToken: null, operationStartedAt: now, state: to, updatedAt: now })
      .where(eq(servers.id, serverId));
    return { row, from, to };
  }

  /**
   * Takes the operation lock for `op` without a state change (`extensions`), inside `tx` (row locked),
   * for a synchronous holder: returns its token (release with `unlock(serverId, token)`). A job takes it
   * the same way and then `attachJob`s itself in the same transaction (the token is cleared). Throws 409
   * INVALID_STATE like `begin` while another operation runs or the state forbids it.
   */
  async lock(tx: DbOrTx, serverId: string, op: Extract<ServerOperation, "extensions">): Promise<string> {
    const [row] = await tx.select().from(servers).where(eq(servers.id, serverId)).for("update").limit(1);
    if (!row) throw notFound("Server");
    const from = row.state as ServerState;
    const active = await this.liveOperation(tx, row);
    if (!canStartOperation(op, from, active)) {
      throw invalidState(active ? `Another operation (${active}) is in progress` : `Cannot change plugins/mods of a server that is ${from}`, { state: from, activeOperation: active });
    }
    const token = randomUUID();
    const now = new Date(this.clock.now());
    await tx.update(servers).set({ activeOperation: op, activeJobId: null, operationToken: token, operationStartedAt: now, updatedAt: now }).where(eq(servers.id, serverId));
    return token;
  }

  /**
   * Lifecycle states in which a pre-empted plugin/mod change may still touch the files: only `stopped`.
   * Not `crashed`: the agent's on-failure restart policy restarts a crashed container on its own (desired
   * state stays running) and the reconciler follows it without touching the lock.
   */
  static readonly CLEANUP_STATES: readonly ServerState[] = ["stopped"];

  /**
   * A cleanup hold for a plugin/mod change that lost its lock: an `extensions` hold under the caller's
   * `token` (recorded by the caller before this call, so a crash after the commit can re-adopt it), taken
   * only when no other operation holds the lock and the server is stopped. A row that already holds this
   * exact token (an interrupted cleanup) is re-adopted while the server is stopped, else released. Returns
   * whether the hold is held.
   */
  async lockForCleanup(serverId: string, token: string): Promise<boolean> {
    const taken = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(servers).where(eq(servers.id, serverId)).for("update").limit(1);
      if (!row) return false;
      const stopped = ServerStateService.CLEANUP_STATES.includes(row.state as ServerState);
      if (row.activeOperation === "extensions" && row.operationToken === token) {
        if (stopped) return true;
        await tx.update(servers).set({ activeOperation: null, operationToken: null, operationStartedAt: null, updatedAt: new Date(this.clock.now()) }).where(eq(servers.id, serverId));
        return false;
      }
      if (await this.liveOperation(tx, row)) return false;
      if (!stopped) return false;
      const now = new Date(this.clock.now());
      await tx.update(servers).set({ activeOperation: "extensions", activeJobId: null, operationToken: token, operationStartedAt: now, updatedAt: now }).where(eq(servers.id, serverId));
      return true;
    });
    this.notify(serverId);
    return taken;
  }

  /** True while the cleanup hold `token` is held and the server is still stopped (checked before every file operation). */
  async cleanupHeld(serverId: string, token: string): Promise<boolean> {
    const [row] = await this.db.select({ token: servers.operationToken, state: servers.state }).from(servers).where(eq(servers.id, serverId));
    return row?.token === token && ServerStateService.CLEANUP_STATES.includes(row.state as ServerState);
  }

  /** Releases a synchronous hold taken by `lock` (only its own: a pre-empting power action keeps its lock). */
  async unlock(serverId: string, token: string): Promise<void> {
    const rows = await this.db
      .update(servers)
      .set({ activeOperation: null, operationToken: null, operationStartedAt: null, updatedAt: new Date(this.clock.now()) })
      .where(and(eq(servers.id, serverId), eq(servers.operationToken, token)))
      .returning({ id: servers.id });
    if (rows.length) this.notify(serverId);
  }

  /** True while the synchronous holder `token` still holds the lock (not pre-empted). */
  async holdsToken(serverId: string, token: string): Promise<boolean> {
    const [row] = await this.db.select({ token: servers.operationToken }).from(servers).where(eq(servers.id, serverId));
    return row?.token === token;
  }

  /** True while `jobId` holds the server's operation lock for `op` (re-checked by long jobs at every step). */
  async holds(serverId: string, op: ServerOperation, jobId: string): Promise<boolean> {
    const [row] = await this.db.select({ op: servers.activeOperation, job: servers.activeJobId }).from(servers).where(eq(servers.id, serverId));
    return row?.op === op && row.job === jobId;
  }

  /**
   * Releases `op` locks nobody holds any more: held by a job that already ended (or was deleted), or a
   * synchronous hold older than `olderThanMs` (left behind by a crashed request; they take seconds).
   */
  async releaseStaleLocks(op: Extract<ServerOperation, "extensions">, olderThanMs: number): Promise<number> {
    const cutoff = new Date(this.clock.now() - olderThanMs).toISOString();
    const rows = await this.db
      .update(servers)
      .set({ activeOperation: null, activeJobId: null, operationToken: null, operationStartedAt: null, updatedAt: new Date(this.clock.now()) })
      .where(
        and(
          eq(servers.activeOperation, op),
          sql`(
            (${servers.activeJobId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${jobs} j WHERE j.id = ${servers.activeJobId} AND j.status IN ('queued', 'running')))
            OR (${servers.activeJobId} IS NULL AND ${servers.operationToken} IS NULL)
            OR (${servers.activeJobId} IS NULL AND ${servers.operationToken} IS NOT NULL AND ${servers.operationStartedAt} < ${cutoff}::timestamptz)
          )`,
        ),
      )
      .returning({ id: servers.id });
    for (const r of rows) this.notify(r.id);
    return rows.length;
  }

  /** Records the job holding the lock taken in the same transaction (clears a synchronous token). */
  async attachJob(tx: DbOrTx, serverId: string, jobId: string): Promise<void> {
    await tx.update(servers).set({ activeJobId: jobId, operationToken: null }).where(eq(servers.id, serverId));
  }

  /** Releases the lock if it is still held by `jobId` (a pre-empting kill may have taken it over). */
  async end(serverId: string, jobId: string): Promise<boolean> {
    const rows = await this.db
      .update(servers)
      .set({ activeOperation: null, activeJobId: null, operationToken: null, operationStartedAt: null, updatedAt: new Date(this.clock.now()) })
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
