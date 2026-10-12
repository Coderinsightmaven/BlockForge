import type { MetricSeriesId } from "@blockforge/contracts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SeriesQueryError extends Error {}

function uuid(id: string | undefined, what: string): string {
  if (!id || !UUID_RE.test(id)) throw new SeriesQueryError(`${what} must be a UUID`);
  return id;
}

/** One PromQL query whose result lines get fixed labels plus the listed source labels. */
export interface SubQuery {
  promql: string;
  labels: Record<string, string>;
  keep: readonly string[];
}

export interface SeriesTarget {
  nodeId?: string | undefined;
  serverId?: string | undefined;
  /** For `global.*`: "all" or the node ids the user may see (already validated UUIDs). */
  nodeIds?: "all" | readonly string[];
}

/** Interfaces excluded from global network totals (loopback, container bridges/veths). */
const VIRTUAL_IFACES = 'iface!~"lo|docker.*|veth.*|br-.*|cni.*|flannel.*|virbr.*"';

/** Rate window: at least 1 minute and two steps, so `rate()` always spans several samples. */
export function rateWindow(stepMs: number): string {
  return `${Math.max(60, Math.ceil((2 * stepMs) / 1000))}s`;
}

/**
 * Maps a whitelisted series id to fixed PromQL templates. Only validated UUIDs are ever
 * interpolated (as label values); nothing user-controlled reaches the query language.
 */
export function buildSeriesQueries(series: MetricSeriesId, target: SeriesTarget, stepMs: number): SubQuery[] {
  const w = rateWindow(stepMs);
  const scope = series.split(".")[0];
  if (scope === "node") {
    const n = `node="${uuid(target.nodeId, "nodeId")}"`;
    switch (series) {
      case "node.cpu.usage":
        return [{ promql: `bf_node_cpu_usage_percent{${n}}`, labels: { kind: "usage" }, keep: [] }];
      case "node.cpu.core":
        return [{ promql: `bf_node_cpu_core_usage_percent{${n}}`, labels: {}, keep: ["core"] }];
      case "node.load":
        return (["load1", "load5", "load15"] as const).map((k) => ({ promql: `bf_node_${k}{${n}}`, labels: { kind: k }, keep: [] }));
      case "node.memory":
        return (["used", "available", "cached", "buffers", "total"] as const).map((k) => ({
          promql: `bf_node_memory_${k}_bytes{${n}}`,
          labels: { kind: k },
          keep: [],
        }));
      case "node.swap.used":
        return [{ promql: `bf_node_swap_used_bytes{${n}}`, labels: { kind: "used" }, keep: [] }];
      case "node.fs.used":
        return [{ promql: `bf_node_fs_used_bytes{${n}}`, labels: {}, keep: ["mount"] }];
      case "node.disk.throughput":
        return (["read", "write"] as const).map((d) => ({
          promql: `bf_node_disk_${d}_bytes_per_second{${n}}`,
          labels: { direction: d },
          keep: ["device"],
        }));
      case "node.disk.latency":
        return [{ promql: `bf_node_disk_latency_ms{${n}}`, labels: {}, keep: ["device"] }];
      case "node.net.throughput":
        return (["rx", "tx"] as const).map((d) => ({
          promql: `bf_node_net_${d}_bytes_per_second{${n}}`,
          labels: { direction: d },
          keep: ["iface"],
        }));
      case "node.net.errors":
        return (["rx_errors", "tx_errors", "rx_dropped", "tx_dropped"] as const).map((k) => ({
          promql: `rate(bf_node_net_${k}_total{${n}}[${w}])`,
          labels: { kind: k },
          keep: ["iface"],
        }));
    }
  }
  if (scope === "server") {
    const s = `server="${uuid(target.serverId, "serverId")}"`;
    switch (series) {
      case "server.cpu":
        return [{ promql: `bf_server_cpu_percent{${s}}`, labels: { kind: "usage" }, keep: [] }];
      case "server.memory":
        return (["usage", "limit", "cache"] as const).map((k) => ({ promql: `bf_server_memory_${k}_bytes{${s}}`, labels: { kind: k }, keep: [] }));
      case "server.jvm.heap":
        return (["used", "committed", "max"] as const).map((k) => ({ promql: `bf_server_jvm_heap_${k}_bytes{${s}}`, labels: { kind: k }, keep: [] }));
      case "server.jvm.gc":
        return [{ promql: `rate(bf_server_jvm_gc_time_ms_total{${s}}[${w}])`, labels: { kind: "gc" }, keep: [] }];
      case "server.net.throughput":
        return (["rx", "tx"] as const).map((d) => ({ promql: `bf_server_net_${d}_bytes_per_second{${s}}`, labels: { direction: d }, keep: [] }));
      case "server.disk.throughput":
        return (["read", "write"] as const).map((d) => ({ promql: `bf_server_disk_${d}_bytes_per_second{${s}}`, labels: { direction: d }, keep: [] }));
      case "server.players":
        return [
          { promql: `bf_server_players_online{${s}}`, labels: { kind: "online" }, keep: [] },
          { promql: `bf_server_players_max{${s}}`, labels: { kind: "max" }, keep: [] },
        ];
    }
  }
  if (scope === "global") {
    const ids = target.nodeIds ?? "all";
    if (ids !== "all") for (const id of ids) uuid(id, "nodeId");
    const sel = (extra?: string) => {
      const parts = [ids === "all" ? null : `node=~"${ids.join("|")}"`, extra ?? null].filter(Boolean);
      return parts.length ? `{${parts.join(",")}}` : "";
    };
    switch (series) {
      case "global.cpu.usage":
        // Weighted by logical cores so a 64-core node counts 16× a 4-core node.
        return [
          {
            promql: `sum(bf_node_cpu_usage_percent${sel()} * on(node) bf_node_cpu_logical_cores${sel()}) / sum(bf_node_cpu_logical_cores${sel()})`,
            labels: { kind: "usage" },
            keep: [],
          },
        ];
      case "global.memory":
        return (["used", "available", "total"] as const).map((k) => ({
          promql: `sum(bf_node_memory_${k}_bytes${sel()})`,
          labels: { kind: k },
          keep: [],
        }));
      case "global.net.throughput":
        return (["rx", "tx"] as const).map((d) => ({
          promql: `sum(bf_node_net_${d}_bytes_per_second${sel(VIRTUAL_IFACES)})`,
          labels: { direction: d },
          keep: [],
        }));
      case "global.disk.throughput":
        return (["read", "write"] as const).map((d) => ({
          promql: `sum(bf_node_disk_${d}_bytes_per_second${sel()})`,
          labels: { direction: d },
          keep: [],
        }));
      case "global.players":
        return [{ promql: `sum(bf_server_players_online${sel()})`, labels: { kind: "online" }, keep: [] }];
    }
  }
  throw new SeriesQueryError(`unsupported series ${series}`);
}

/** Step ≈ range/300, at least 5 s, whole seconds, and never more than 2000 points. */
export function chooseStepMs(from: number, to: number, requested?: number): number {
  const range = Math.max(0, to - from);
  let step = requested ?? Math.ceil(range / 300);
  step = Math.max(step, 5000, Math.ceil(range / 2000));
  return Math.ceil(step / 1000) * 1000;
}

/** Grid of timestamps aligned to the step (start rounded down, end rounded down to the last step ≤ to). */
export function stepGrid(from: number, to: number, stepMs: number): number[] {
  const start = Math.floor(from / stepMs) * stepMs;
  const out: number[] = [];
  for (let t = start; t <= to; t += stepMs) out.push(t);
  return out;
}

/** Places VictoriaMetrics `[unixSeconds, "value"]` points on the grid; missing points become null. */
export function fillGrid(grid: readonly number[], values: readonly (readonly [number, string])[]): [number, number | null][] {
  const byTs = new Map<number, number>();
  for (const [ts, v] of values) {
    const n = Number(v);
    if (Number.isFinite(n)) byTs.set(Math.round(ts * 1000), n);
  }
  return grid.map((t) => [t, byTs.has(t) ? (byTs.get(t) as number) : null]);
}
