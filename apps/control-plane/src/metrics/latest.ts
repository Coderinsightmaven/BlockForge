import type { NodeMetricSample, WorkloadMetricSample } from "@blockforge/contracts";
import type { Clock } from "../lib/clock.js";

interface Entry<T> {
  sample: T;
  receivedAt: number;
}

export interface WorkloadEntry {
  serverId: string;
  nodeId: string;
  sample: WorkloadMetricSample;
  receivedAt: number;
}

/**
 * Most recent sample per node and per workload, held in memory. A sample counts as "fresh" for
 * 3 × the metrics interval after it was *received* (receipt time, not the agent's clock, so a
 * skewed agent clock cannot make stale data look live). Stale samples are reported as missing.
 */
export class LatestCache {
  private readonly nodes = new Map<string, Entry<NodeMetricSample>>();
  private readonly workloads = new Map<string, WorkloadEntry>();

  constructor(
    private readonly clock: Clock,
    private readonly metricsIntervalMs: number,
  ) {}

  get freshnessMs(): number {
    return 3 * this.metricsIntervalMs;
  }

  private fresh(receivedAt: number): boolean {
    return this.clock.now() - receivedAt <= this.freshnessMs;
  }

  setNode(nodeId: string, sample: NodeMetricSample): void {
    this.nodes.set(nodeId, { sample, receivedAt: this.clock.now() });
  }

  getNode(nodeId: string): NodeMetricSample | null {
    const e = this.nodes.get(nodeId);
    return e && this.fresh(e.receivedAt) ? e.sample : null;
  }

  freshNodes(): Map<string, NodeMetricSample> {
    const out = new Map<string, NodeMetricSample>();
    for (const [id, e] of this.nodes) if (this.fresh(e.receivedAt)) out.set(id, e.sample);
    return out;
  }

  setWorkload(serverId: string, nodeId: string, sample: WorkloadMetricSample): void {
    this.workloads.set(serverId, { serverId, nodeId, sample, receivedAt: this.clock.now() });
  }

  getWorkload(serverId: string): WorkloadMetricSample | null {
    const e = this.workloads.get(serverId);
    return e && this.fresh(e.receivedAt) ? e.sample : null;
  }

  freshWorkloads(): WorkloadEntry[] {
    return [...this.workloads.values()].filter((e) => this.fresh(e.receivedAt));
  }

  /** Drops samples older than `maxAgeMs` (stale entries of nodes/servers that stopped reporting). */
  prune(maxAgeMs: number): number {
    const cutoff = this.clock.now() - maxAgeMs;
    let removed = 0;
    for (const [id, e] of this.nodes) {
      if (e.receivedAt < cutoff) {
        this.nodes.delete(id);
        removed++;
      }
    }
    for (const [id, e] of this.workloads) {
      if (e.receivedAt < cutoff) {
        this.workloads.delete(id);
        removed++;
      }
    }
    return removed;
  }

  removeWorkload(serverId: string): void {
    this.workloads.delete(serverId);
  }

  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
    for (const [id, e] of this.workloads) if (e.nodeId === nodeId) this.workloads.delete(id);
  }
}
