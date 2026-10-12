import type { NodeConnection } from "@blockforge/contracts";
import { and, count, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { NodeStateTracker } from "../agents/node-state.js";
import type { DbOrTx } from "../db/client.js";
import { allocations, nodes, resourceReservations } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import { computeCapacity } from "../nodes/capacity.js";

export interface PlacementRequest {
  memoryLimitBytes: number;
  cpuLimitMillicores: number | null;
  storageQuotaBytes: number | null;
  placement: { mode: "node"; nodeId: string } | { mode: "auto"; preferTags?: string[] | undefined; location?: string | undefined };
  allocation?: { mode: "auto" } | { mode: "specific"; allocationId: string } | undefined;
  /** Capacity limits become warnings instead of hard failures (admin override; audited by the caller). */
  overrideCapacity?: boolean | undefined;
}

export interface PlacementCandidate {
  nodeId: string;
  nodeName: string;
  fits: boolean;
  /** Hard reasons (why it does not fit) followed by soft notes ("warning: …", "prefers …"). */
  reasons: string[];
  score: number;
  freeAllocations: number;
}

const CONNECTED: readonly NodeConnection[] = ["online", "degraded"];
const GiB = 1024 ** 3;
const fmtGiB = (b: number) => `${(b / GiB).toFixed(1)} GiB`;

/**
 * Scores every candidate node for a new server. Hard constraints: node active, scheduling enabled,
 * agent connected, capacity (allocatable × overcommit − reserved for memory; allocatable − reserved
 * for CPU and storage), a free allocation (or the requested specific one). Soft: preferred tags,
 * location, and remaining headroom (score 0–100). Expired provisioning holds do not count.
 */
export async function placementCandidates(
  tx: DbOrTx,
  tracker: NodeStateTracker,
  clock: Clock,
  req: PlacementRequest,
): Promise<PlacementCandidate[]> {
  const nodeFilter = req.placement.mode === "node" ? eq(nodes.id, req.placement.nodeId) : undefined;
  const rows = await tx.select().from(nodes).where(nodeFilter);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const now = new Date(clock.now());
  const reserved = await tx
    .select({
      nodeId: resourceReservations.nodeId,
      cpu: sql<string>`coalesce(sum(${resourceReservations.cpuMillicores}), 0)`,
      memory: sql<string>`coalesce(sum(${resourceReservations.memoryBytes}), 0)`,
      storage: sql<string>`coalesce(sum(${resourceReservations.storageBytes}), 0)`,
    })
    .from(resourceReservations)
    .where(and(inArray(resourceReservations.nodeId, ids), or(isNull(resourceReservations.expiresAt), gt(resourceReservations.expiresAt, now))))
    .groupBy(resourceReservations.nodeId);
  const res = new Map(reserved.map((r) => [r.nodeId, r]));
  const free = await tx
    .select({ nodeId: allocations.nodeId, n: count() })
    .from(allocations)
    .where(and(inArray(allocations.nodeId, ids), isNull(allocations.serverId)))
    .groupBy(allocations.nodeId);
  const freeMap = new Map(free.map((r) => [r.nodeId, Number(r.n)]));
  let specific: { nodeId: string; free: boolean } | null = null;
  if (req.allocation?.mode === "specific") {
    const [a] = await tx.select({ nodeId: allocations.nodeId, serverId: allocations.serverId }).from(allocations).where(eq(allocations.id, req.allocation.allocationId)).limit(1);
    specific = a ? { nodeId: a.nodeId, free: a.serverId === null } : { nodeId: "", free: false };
  }
  const preferTags = req.placement.mode === "auto" ? (req.placement.preferTags ?? []) : [];
  const location = req.placement.mode === "auto" ? (req.placement.location ?? null) : null;

  const out: PlacementCandidate[] = rows.map((n) => {
    const hard: string[] = [];
    const soft: string[] = [];
    const rr = res.get(n.id);
    const cap = computeCapacity(n, n.facts ?? null, {
      cpuMillicores: Number(rr?.cpu ?? 0),
      memoryBytes: Number(rr?.memory ?? 0),
      storageBytes: Number(rr?.storage ?? 0),
    });
    const connection = (tracker.get(n.id)?.connection ?? n.connection) as NodeConnection;
    if (n.status !== "active") hard.push(`node is ${n.status}`);
    if (!n.schedulingEnabled) hard.push("scheduling is disabled on this node");
    if (!CONNECTED.includes(connection)) hard.push(`node agent is ${connection}`);
    if (connection === "degraded") soft.push("warning: node is degraded");
    const capacityIssues: string[] = [];
    const memFree = cap.memoryAllocatableBytes * cap.overcommitMemoryRatio - cap.memoryReservedBytes;
    if (memFree < req.memoryLimitBytes) capacityIssues.push(`not enough memory (${fmtGiB(Math.max(0, memFree))} free, ${fmtGiB(req.memoryLimitBytes)} requested)`);
    const cpuReq = req.cpuLimitMillicores ?? 0;
    const cpuFree = cap.cpuAllocatableMillicores - cap.cpuReservedMillicores;
    if (cpuReq > 0 && cpuFree < cpuReq) capacityIssues.push(`not enough CPU (${Math.max(0, cpuFree)}m free, ${cpuReq}m requested)`);
    const storageFree = cap.storageAllocatableBytes - cap.storageReservedBytes;
    if (req.storageQuotaBytes !== null && storageFree < req.storageQuotaBytes) {
      capacityIssues.push(`not enough storage (${fmtGiB(Math.max(0, storageFree))} free, ${fmtGiB(req.storageQuotaBytes)} requested)`);
    }
    if (req.overrideCapacity) soft.push(...capacityIssues.map((c) => `warning (override): ${c}`));
    else hard.push(...capacityIssues);
    const freeAllocations = freeMap.get(n.id) ?? 0;
    if (specific) {
      if (specific.nodeId !== n.id) hard.push("the requested allocation is not on this node");
      else if (!specific.free) hard.push("the requested allocation is already in use");
    } else if (freeAllocations === 0) hard.push("no free allocation on this node");

    let score = 0;
    if (cap.memoryAllocatableBytes > 0) score += 50 * Math.max(0, Math.min(1, (memFree - req.memoryLimitBytes) / (cap.memoryAllocatableBytes * cap.overcommitMemoryRatio)));
    if (cap.cpuAllocatableMillicores > 0) score += 20 * Math.max(0, Math.min(1, (cpuFree - cpuReq) / cap.cpuAllocatableMillicores));
    if (preferTags.length) {
      const matched = preferTags.filter((t) => n.tags.includes(t));
      score += 20 * (matched.length / preferTags.length);
      if (matched.length < preferTags.length) soft.push(`prefers tags ${preferTags.filter((t) => !n.tags.includes(t)).join(", ")} (missing)`);
    } else score += 20;
    if (location) {
      if (n.location === location) score += 10;
      else soft.push(`prefers location ${location}`);
    } else score += 10;
    return { nodeId: n.id, nodeName: n.name, fits: hard.length === 0, reasons: [...hard, ...soft], score: Math.round(score * 10) / 10, freeAllocations };
  });
  return out.sort((a, b) => Number(b.fits) - Number(a.fits) || b.score - a.score || a.nodeName.localeCompare(b.nodeName));
}

/** Serialises placement decisions per node inside a transaction (two creates cannot overbook one node). */
export async function lockNodeForPlacement(tx: DbOrTx, nodeId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`placement:${nodeId}`}, 0))`);
}
