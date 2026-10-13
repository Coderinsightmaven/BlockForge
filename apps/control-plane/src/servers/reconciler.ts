import type { NodeConnection, ServerState, WorkloadStatus } from "@blockforge/contracts";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { AgentGateway } from "../agents/gateway.js";
import type { ConnectionChange, NodeStateTracker } from "../agents/node-state.js";
import type { Db } from "../db/client.js";
import { servers } from "../db/schema/index.js";
import type { EventBus } from "../events/bus.js";
import type { Clock } from "../lib/clock.js";
import type { ServerStateService } from "./state.js";

/** States owned by an operation or by provisioning: the reconciler never overrides them. */
const UNMANAGED: readonly ServerState[] = ["provisioning", "provision_failed", "deleting", "updating", "backing_up", "restoring", "migrating"];
const LIVE: readonly ServerState[] = ["running", "degraded", "starting"];

/**
 * Keeps server states in line with what agents report (`workload.state` events and the workload
 * list in every `hello`): unexpected exits become `crashed` (+ `server.crashed`, lastCrashAt,
 * lastExitCode) or `stopped` for clean exits; Docker restarts after a crash pass through `crashed`
 * → `starting`; servers on unreachable nodes become `unreachable` and are resynchronised when the
 * agent reconnects. Servers with an active operation are left to that operation's job.
 */
/** No operation that owns the lifecycle state is running (plugin/mod changes leave it alone). */
const noStateOperation = () => or(isNull(servers.activeOperation), eq(servers.activeOperation, "extensions"));

export class ServerReconciler {
  private readonly oomKilled = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly state: ServerStateService,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  attach(gateway: AgentGateway, tracker: NodeStateTracker): void {
    gateway.on("workloadState", (nodeId, st) => void this.onWorkloadState(nodeId, st).catch((err) => this.logger.warn({ err }, "reconcile failed")));
    gateway.on("workloadOom", (_nodeId, workloadId) => this.oomKilled.add(workloadId));
    gateway.on("workloadsResync", (nodeId, list) => void this.resync(nodeId, list).catch((err) => this.logger.warn({ err }, "resync failed")));
    tracker.onChange((change) => this.onConnection(change));
  }

  async onWorkloadState(nodeId: string, st: WorkloadStatus): Promise<void> {
    const [row] = await this.db
      .select({ id: servers.id, state: servers.state, activeOperation: servers.activeOperation, installedAt: servers.installedAt })
      .from(servers)
      .where(and(eq(servers.id, st.workloadId), eq(servers.nodeId, nodeId)))
      .limit(1);
    // `extensions` (plugin/mod changes) does not own the lifecycle state: the reconciler keeps following the workload.
    if (!row || (row.activeOperation && row.activeOperation !== "extensions") || UNMANAGED.includes(row.state as ServerState)) return;
    const from = row.state as ServerState;
    const oom = Boolean(st.oomKilled) || this.oomKilled.delete(st.workloadId);
    switch (st.state) {
      case "running":
        if (from === "crashed") await this.state.transition(row.id, "starting", {}, { reason: "restarted by the restart policy" });
        if (from !== "running" && from !== "degraded") await this.state.transition(row.id, "running", { lastStartedAt: new Date(this.clock.now()) }, { reason: "workload running" });
        return;
      case "restarting":
        if (LIVE.includes(from)) await this.crash(row.id, st.exitCode ?? null, oom, "restarting after an exit");
        if ((await this.current(row.id)) === "crashed") await this.state.transition(row.id, "starting", {}, { reason: "restart policy" });
        return;
      case "exited":
      case "dead":
      case "missing":
      case "created": {
        if (st.state === "created" && from !== "unreachable") return;
        const clean = (st.exitCode ?? 0) === 0 && !oom && st.state !== "missing" && st.state !== "dead";
        if (LIVE.includes(from) && !clean) await this.crash(row.id, st.exitCode ?? null, oom, `workload ${st.state}`);
        else if (from !== "stopped" && from !== "crashed") {
          await this.state.transition(row.id, "stopped", { lastExitCode: st.exitCode ?? null, lastOomKilled: oom }, { reason: `workload ${st.state}` });
          if (from === "running" || from === "degraded") await this.db.update(servers).set({ desiredState: "stopped" }).where(eq(servers.id, row.id));
        }
        return;
      }
    }
  }

  private async current(id: string): Promise<ServerState | null> {
    const [r] = await this.db.select({ state: servers.state }).from(servers).where(eq(servers.id, id));
    return (r?.state as ServerState | undefined) ?? null;
  }

  private async crash(serverId: string, exitCode: number | null, oom: boolean, reason: string): Promise<void> {
    const now = new Date(this.clock.now());
    if (await this.state.transition(serverId, "crashed", { lastCrashAt: now, lastExitCode: exitCode, lastOomKilled: oom }, { reason })) {
      await this.bus.publish({ type: "server.crashed", subjectType: "server", subjectId: serverId, data: { exitCode, oomKilled: oom } });
    }
  }

  /** `hello`: every reported workload is reconciled; installed servers the agent no longer has are `missing`. */
  async resync(nodeId: string, workloads: WorkloadStatus[]): Promise<void> {
    for (const w of workloads) await this.onWorkloadState(nodeId, w);
    const reported = workloads.map((w) => w.workloadId);
    const others = await this.db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.nodeId, nodeId), noStateOperation(), inArray(servers.state, ["unreachable", "running", "degraded", "starting"]), reported.length ? notInArray(servers.id, reported) : undefined));
    for (const o of others) await this.onWorkloadState(nodeId, { workloadId: o.id, exists: false, state: "missing", restartCount: 0 });
  }

  private async onConnection(change: ConnectionChange): Promise<void> {
    const lost: readonly NodeConnection[] = ["unreachable", "offline"];
    if (!lost.includes(change.to)) return;
    const rows = await this.db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.nodeId, change.nodeId), noStateOperation(), inArray(servers.state, ["running", "degraded", "starting", "stopping", "stopped", "crashed"])));
    for (const r of rows) await this.state.transition(r.id, "unreachable", {}, { reason: `node ${change.to}` });
  }
}
