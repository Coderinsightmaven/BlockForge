import type { NodeConnection, OverviewSummary } from "@blockforge/contracts";
import { and, count, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { NodeStateTracker } from "../agents/node-state.js";
import type { Db } from "../db/client.js";
import { alertIncidents, jobs, nodes, resourceReservations, servers } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import type { LatestCache } from "../metrics/latest.js";
import { dataRootFilesystem } from "../nodes/capacity.js";
import { computeCapacity } from "../nodes/capacity.js";
import { incidentScopeFilter } from "../alerts/scope.js";
import { permittedScopes, type Principal } from "../rbac/authorize.js";
import type { RbacService } from "../rbac/service.js";

const DAY_MS = 24 * 60 * 60_000;
const VIRTUAL_IFACE_RE = /^(lo|docker|veth|br-|cni|flannel|virbr)/;
/** Nodes whose capacity counts towards the fleet totals. */
const CAPACITY_STATUSES = ["active", "draining", "maintenance"];

/**
 * `GET /overview`: fleet summary scoped to what the user can see (monitoring.view). Allocated
 * (reservations) and used (live samples) are reported separately; values without fresh telemetry
 * are null, and modules that do not exist yet (backups, updates) report null rather than zeros.
 */
export class OverviewService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly rbac: RbacService,
    private readonly tracker: NodeStateTracker,
    private readonly latest: LatestCache,
  ) {}

  async summary(principal: Principal): Promise<OverviewSummary> {
    const now = this.clock.now();
    const scopes = permittedScopes(principal, "monitoring.view");
    const nodeIds = await this.rbac.visibleNodeIds(scopes);
    const serverIds = await this.rbac.visibleServerIds(scopes);

    const nodeRows =
      nodeIds === "all"
        ? await this.db.select().from(nodes)
        : nodeIds.length
          ? await this.db.select().from(nodes).where(inArray(nodes.id, nodeIds))
          : [];
    const nodeCounts = { total: nodeRows.length, online: 0, degraded: 0, unreachable: 0, offline: 0, pending: 0 };
    for (const n of nodeRows) {
      if (n.status === "pending") nodeCounts.pending++;
      const c = (this.tracker.get(n.id)?.connection ?? n.connection) as NodeConnection;
      nodeCounts[c]++;
    }

    const serverFilter = serverIds === "all" ? undefined : serverIds.length ? inArray(servers.id, serverIds) : sql`false`;
    const stateRows = await this.db.select({ state: servers.state, n: count() }).from(servers).where(serverFilter).groupBy(servers.state);
    const byState: Record<string, number> = {};
    let serverTotal = 0;
    for (const r of stateRows) {
      byState[r.state] = Number(r.n);
      serverTotal += Number(r.n);
    }

    // Players: SLP counts from fresh workload samples of visible servers.
    const visibleServerSet = serverIds === "all" ? null : new Set(serverIds);
    let playersOnline = 0;
    let reportingServers = 0;
    for (const w of this.latest.freshWorkloads()) {
      if (visibleServerSet && !visibleServerSet.has(w.serverId)) continue;
      if (w.sample.minecraft) {
        playersOnline += w.sample.minecraft.playersOnline;
        reportingServers++;
      }
    }

    // Capacity vs allocation vs live usage.
    const capacityNodes = nodeRows.filter((n) => CAPACITY_STATUSES.includes(n.status));
    const capIds = capacityNodes.map((n) => n.id);
    const reservedRows = capIds.length
      ? await this.db
          .select({
            nodeId: resourceReservations.nodeId,
            cpu: sql<string>`coalesce(sum(${resourceReservations.cpuMillicores}), 0)`,
            memory: sql<string>`coalesce(sum(${resourceReservations.memoryBytes}), 0)`,
            storage: sql<string>`coalesce(sum(${resourceReservations.storageBytes}), 0)`,
          })
          .from(resourceReservations)
          .where(
            and(
              inArray(resourceReservations.nodeId, capIds),
              or(isNull(resourceReservations.expiresAt), gt(resourceReservations.expiresAt, new Date(now))),
            ),
          )
          .groupBy(resourceReservations.nodeId)
      : [];
    const reserved = new Map(reservedRows.map((r) => [r.nodeId, r]));
    let cpuCapacity = 0;
    let cpuAllocated = 0;
    let memAllocated = 0;
    let memTotal = 0;
    let weightedCpu = 0;
    let weight = 0;
    let memUsed: number | null = null;
    let memAvailable: number | null = null;
    let storageTotal: number | null = null;
    let storageUsed: number | null = null;
    let rx: number | null = null;
    let tx: number | null = null;
    for (const n of capacityNodes) {
      const rr = reserved.get(n.id);
      const cap = computeCapacity(n, n.facts ?? null, {
        cpuMillicores: Number(rr?.cpu ?? 0),
        memoryBytes: Number(rr?.memory ?? 0),
        storageBytes: Number(rr?.storage ?? 0),
      });
      cpuCapacity += cap.cpuAllocatableMillicores;
      cpuAllocated += cap.cpuReservedMillicores;
      memAllocated += cap.memoryReservedBytes;
      const sample = this.latest.getNode(n.id);
      memTotal += sample?.memory.totalBytes ?? n.facts?.memoryTotalBytes ?? 0;
      if (!sample) continue;
      const cores = n.facts?.cpuLogicalCores ?? sample.cpu.perCorePct?.length ?? 1;
      weightedCpu += sample.cpu.usagePct * cores;
      weight += cores;
      memUsed = (memUsed ?? 0) + sample.memory.usedBytes;
      memAvailable = (memAvailable ?? 0) + sample.memory.availableBytes;
      const fs = n.facts ? dataRootFilesystem(n.facts.dataRoot, sample.filesystems) : null;
      if (fs) {
        storageTotal = (storageTotal ?? 0) + fs.totalBytes;
        storageUsed = (storageUsed ?? 0) + fs.usedBytes;
      }
      for (const nic of sample.network) {
        if (VIRTUAL_IFACE_RE.test(nic.iface)) continue;
        rx = (rx ?? 0) + nic.rxBytesPerSec;
        tx = (tx ?? 0) + nic.txBytesPerSec;
      }
    }

    // Active alerts, filtered by subject scope in SQL (one aggregate query, no per-incident lookups).
    const alertRows = await this.db
      .select({ severity: alertIncidents.severity, n: count() })
      .from(alertIncidents)
      .where(and(ne(alertIncidents.status, "resolved"), incidentScopeFilter(nodeIds, serverIds)))
      .groupBy(alertIncidents.severity);
    const activeAlerts = { critical: 0, warning: 0, info: 0 };
    for (const a of alertRows) {
      if (a.severity === "critical" || a.severity === "warning" || a.severity === "info") activeAlerts[a.severity] = Number(a.n);
    }

    const since = new Date(now - DAY_MS);
    const crashRows = await this.db
      .select({ id: servers.id, name: servers.name, at: servers.lastCrashAt, exitCode: servers.lastExitCode })
      .from(servers)
      .where(and(gt(servers.lastCrashAt, since), serverFilter))
      .orderBy(desc(servers.lastCrashAt))
      .limit(10);

    const jobScopes = permittedScopes(principal, "jobs.view");
    const jobNodeIds = await this.rbac.visibleNodeIds(jobScopes);
    const jobServerIds = await this.rbac.visibleServerIds(jobScopes);
    const jobVisibility =
      jobScopes.all
        ? undefined
        : or(
            jobNodeIds !== "all" && jobNodeIds.length ? and(eq(jobs.targetType, "node"), inArray(jobs.targetId, jobNodeIds)) : sql`false`,
            jobServerIds !== "all" && jobServerIds.length ? and(eq(jobs.targetType, "server"), inArray(jobs.targetId, jobServerIds)) : sql`false`,
          );
    const failedJobs = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "failed"), gt(jobs.finishedAt, since), jobVisibility))
      .orderBy(desc(jobs.finishedAt))
      .limit(10);
    const targetNames = await this.targetNames(failedJobs);

    return {
      generatedAt: now,
      nodes: nodeCounts,
      servers: { total: serverTotal, byState },
      players: { online: playersOnline, reportingServers },
      cpu: { capacityMillicores: cpuCapacity, allocatedMillicores: cpuAllocated, usagePct: weight > 0 ? weightedCpu / weight : null },
      memory: { totalBytes: memTotal, allocatedBytes: memAllocated, usedBytes: memUsed, availableBytes: memAvailable },
      storage: { totalBytes: storageTotal, usedBytes: storageUsed },
      network: { rxBytesPerSec: rx, txBytesPerSec: tx },
      backups: null,
      pendingUpdates: null,
      activeAlerts,
      recentCrashes: crashRows
        .filter((c) => c.at)
        .map((c) => ({ serverId: c.id, serverName: c.name, at: (c.at as Date).getTime(), exitCode: c.exitCode })),
      recentFailedJobs: failedJobs.map((j) => ({
        jobId: j.id,
        type: j.type,
        targetName: j.targetId ? (targetNames.get(`${j.targetType}:${j.targetId}`) ?? null) : null,
        at: (j.finishedAt ?? j.createdAt).getTime(),
        message: j.error?.message ?? "failed",
      })),
    };
  }

  private async targetNames(rows: { targetType: string | null; targetId: string | null }[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = (t: string) => [...new Set(rows.filter((r) => r.targetType === t && r.targetId).map((r) => r.targetId as string))];
    const nodeIds = ids("node");
    const serverIds = ids("server");
    if (nodeIds.length) for (const r of await this.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, nodeIds))) out.set(`node:${r.id}`, r.name);
    if (serverIds.length)
      for (const r of await this.db.select({ id: servers.id, name: servers.name }).from(servers).where(inArray(servers.id, serverIds)))
        out.set(`server:${r.id}`, r.name);
    return out;
  }

}
