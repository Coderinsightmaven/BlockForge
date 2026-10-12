import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { servers } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";

const TTL_MS = 30_000;
const MAX_ENTRIES = 100_000;

/**
 * Maps workload ids (== server ids) to the node that hosts them. Agent frames that report on a
 * workload the sending node does not own are dropped, so a compromised agent cannot inject
 * metrics, logs or state for servers on other nodes.
 */
export class WorkloadOwnership {
  private readonly cache = new Map<string, { nodeId: string | null; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Returns the subset of `workloadIds` owned by `nodeId`. */
  async owned(nodeId: string, workloadIds: readonly string[]): Promise<Set<string>> {
    const now = this.clock.now();
    const missing = workloadIds.filter((id) => {
      const e = this.cache.get(id);
      return !e || now - e.at > TTL_MS;
    });
    if (missing.length) {
      const rows = await this.db
        .select({ id: servers.id, nodeId: servers.nodeId })
        .from(servers)
        .where(inArray(servers.id, [...new Set(missing)]));
      const found = new Map(rows.map((r) => [r.id, r.nodeId]));
      if (this.cache.size > MAX_ENTRIES) this.cache.clear();
      for (const id of missing) this.cache.set(id, { nodeId: found.get(id) ?? null, at: now });
    }
    return new Set(workloadIds.filter((id) => this.cache.get(id)?.nodeId === nodeId));
  }

  /** Call when a server is created, moved or deleted. */
  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }
}
