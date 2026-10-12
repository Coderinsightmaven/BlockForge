import type { NodeMetricSample, WorkloadMetricSample } from "@blockforge/contracts";

/**
 * Prometheus text exposition lines (`name{labels} value timestamp_ms`) for VictoriaMetrics'
 * `/api/v1/import/prometheus`. Label values originating from agents (mounts, devices, interfaces)
 * are untrusted: control characters are stripped, values truncated and escaped per the format.
 */
const MAX_LABEL_LENGTH = 128;

export function escapeLabelValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_LABEL_LENGTH);
  return clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function metricLine(name: string, labels: Record<string, string>, value: number | undefined, tsMs: number): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return `${name}{${parts.join(",")}} ${value} ${Math.round(tsMs)}`;
}

class LineBuilder {
  readonly lines: string[] = [];
  constructor(private readonly ts: number) {}
  add(name: string, labels: Record<string, string>, value: number | undefined): void {
    const line = metricLine(name, labels, value, this.ts);
    if (line) this.lines.push(line);
  }
}

/**
 * @param tsOffsetMs added to the agent timestamp to correct measured clock skew
 *                   (offset = −skew, where skew = agentClock − controlPlaneClock).
 */
export function encodeNodeSample(
  nodeId: string,
  s: NodeMetricSample,
  opts: { tsOffsetMs?: number; logicalCores?: number } = {},
): string[] {
  const b = new LineBuilder(s.ts + (opts.tsOffsetMs ?? 0));
  const node = { node: nodeId };
  b.add("bf_node_cpu_usage_percent", node, s.cpu.usagePct);
  s.cpu.perCorePct?.forEach((v, i) => b.add("bf_node_cpu_core_usage_percent", { ...node, core: String(i) }, v));
  b.add("bf_node_load1", node, s.cpu.load1);
  b.add("bf_node_load5", node, s.cpu.load5);
  b.add("bf_node_load15", node, s.cpu.load15);
  b.add("bf_node_cpu_iowait_percent", node, s.cpu.iowaitPct);
  b.add("bf_node_cpu_steal_percent", node, s.cpu.stealPct);
  b.add("bf_node_cpu_logical_cores", node, opts.logicalCores);
  b.add("bf_node_memory_total_bytes", node, s.memory.totalBytes);
  b.add("bf_node_memory_used_bytes", node, s.memory.usedBytes);
  b.add("bf_node_memory_available_bytes", node, s.memory.availableBytes);
  b.add("bf_node_memory_cached_bytes", node, s.memory.cachedBytes);
  b.add("bf_node_memory_buffers_bytes", node, s.memory.buffersBytes);
  b.add("bf_node_swap_total_bytes", node, s.memory.swapTotalBytes);
  b.add("bf_node_swap_used_bytes", node, s.memory.swapUsedBytes);
  for (const fs of s.filesystems) {
    const l = { ...node, mount: fs.mount };
    b.add("bf_node_fs_total_bytes", l, fs.totalBytes);
    b.add("bf_node_fs_used_bytes", l, fs.usedBytes);
    b.add("bf_node_fs_free_bytes", l, fs.freeBytes);
    b.add("bf_node_fs_inodes_total", l, fs.inodesTotal);
    b.add("bf_node_fs_inodes_used", l, fs.inodesUsed);
  }
  for (const d of s.diskIo) {
    const l = { ...node, device: d.device };
    b.add("bf_node_disk_read_bytes_per_second", l, d.readBytesPerSec);
    b.add("bf_node_disk_write_bytes_per_second", l, d.writeBytesPerSec);
    b.add("bf_node_disk_read_ops_per_second", l, d.readOpsPerSec);
    b.add("bf_node_disk_write_ops_per_second", l, d.writeOpsPerSec);
    b.add("bf_node_disk_busy_percent", l, d.busyPct);
    b.add("bf_node_disk_latency_ms", l, d.avgLatencyMs);
  }
  for (const n of s.network) {
    const l = { ...node, iface: n.iface };
    b.add("bf_node_net_rx_bytes_per_second", l, n.rxBytesPerSec);
    b.add("bf_node_net_tx_bytes_per_second", l, n.txBytesPerSec);
    b.add("bf_node_net_rx_packets_per_second", l, n.rxPacketsPerSec);
    b.add("bf_node_net_tx_packets_per_second", l, n.txPacketsPerSec);
    b.add("bf_node_net_rx_errors_total", l, n.rxErrorsTotal);
    b.add("bf_node_net_tx_errors_total", l, n.txErrorsTotal);
    b.add("bf_node_net_rx_dropped_total", l, n.rxDroppedTotal);
    b.add("bf_node_net_tx_dropped_total", l, n.txDroppedTotal);
  }
  if (s.tcp) {
    b.add("bf_node_tcp_established", node, s.tcp.established);
    b.add("bf_node_tcp_total", node, s.tcp.total);
  }
  return b.lines;
}

export function encodeWorkloadSample(
  serverId: string,
  nodeId: string,
  s: WorkloadMetricSample,
  opts: { tsOffsetMs?: number } = {},
): string[] {
  const b = new LineBuilder(s.ts + (opts.tsOffsetMs ?? 0));
  const l = { server: serverId, node: nodeId };
  b.add("bf_server_running", l, s.running ? 1 : 0);
  b.add("bf_server_cpu_percent", l, s.cpuPct);
  b.add("bf_server_cpu_throttled_periods_total", l, s.cpuThrottledPeriodsTotal);
  b.add("bf_server_memory_usage_bytes", l, s.memoryUsageBytes);
  b.add("bf_server_memory_limit_bytes", l, s.memoryLimitBytes);
  b.add("bf_server_memory_cache_bytes", l, s.memoryCacheBytes);
  b.add("bf_server_net_rx_bytes_per_second", l, s.netRxBytesPerSec);
  b.add("bf_server_net_tx_bytes_per_second", l, s.netTxBytesPerSec);
  b.add("bf_server_disk_read_bytes_per_second", l, s.blkReadBytesPerSec);
  b.add("bf_server_disk_write_bytes_per_second", l, s.blkWriteBytesPerSec);
  b.add("bf_server_pids", l, s.pids);
  b.add("bf_server_disk_usage_bytes", l, s.diskUsageBytes);
  if (s.jvm) {
    b.add("bf_server_jvm_heap_used_bytes", l, s.jvm.heapUsedBytes);
    b.add("bf_server_jvm_heap_committed_bytes", l, s.jvm.heapCommittedBytes);
    b.add("bf_server_jvm_heap_max_bytes", l, s.jvm.heapMaxBytes);
    b.add("bf_server_jvm_nonheap_used_bytes", l, s.jvm.nonHeapUsedBytes);
    b.add("bf_server_jvm_gc_count_total", l, s.jvm.gcCountTotal);
    b.add("bf_server_jvm_gc_time_ms_total", l, s.jvm.gcTimeMsTotal);
    b.add("bf_server_jvm_threads", l, s.jvm.threads);
  }
  if (s.minecraft) {
    b.add("bf_server_players_online", l, s.minecraft.playersOnline);
    b.add("bf_server_players_max", l, s.minecraft.playersMax);
    b.add("bf_server_slp_latency_ms", l, s.minecraft.latencyMs);
  }
  return b.lines;
}
