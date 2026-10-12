import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { servers } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";

const TTL_MS = 60_000;
const MAX_ENTRIES = 50_000;
/** Unknown ids looked up per call; a frame naming more unknown workloads is answered for the first N only. */
const MAX_LOOKUPS_PER_CALL = 64;

/**
 * Maps workload ids (== server ids) to the node that hosts them. Agent frames that report on a
 * workload the sending node does not own are dropped, so a compromised agent cannot inject
 * metrics, logs or state for servers on other nodes.
 *
 * Only *positive* answers are cached (an agent cannot plant "nobody owns X" entries that would
 * silence the real owner); entries are invalidated when a server is created, moved or deleted,
 * expire after a minute as a safety net, and the cache is LRU-bounded.
 */
export class WorkloadOwnership {
  private readonly cache = new Map<string, { nodeId: string; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Returns the subset of `workloadIds` owned by `nodeId`. */
  async owned(nodeId: string, workloadIds: readonly string[]): Promise<Set<string>> {
    const now = this.clock.now();
    const result = new Set<string>();
    const missing: string[] = [];
    for (const id of new Set(workloadIds)) {
      const e = this.cache.get(id);
      if (e && now - e.at <= TTL_MS) {
        if (e.nodeId === nodeId) result.add(id);
      } else if (missing.length < MAX_LOOKUPS_PER_CALL) {
        missing.push(id);
      }
    }
    if (missing.length) {
      const rows = await this.db.select({ id: servers.id, nodeId: servers.nodeId }).from(servers).where(inArray(servers.id, missing));
      for (const r of rows) {
        this.cache.delete(r.id);
        this.cache.set(r.id, { nodeId: r.nodeId, at: now });
        if (r.nodeId === nodeId) result.add(r.id);
      }
      while (this.cache.size > MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return result;
  }

  /** Call when a server is created, moved or deleted. */
  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }

  get size(): number {
    return this.cache.size;
  }
}
