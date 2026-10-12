import { METRIC_SERIES, MetricsFrame, type MetricSeriesId } from "@blockforge/contracts";
import { describe, expect, it } from "vitest";
import { encodeNodeSample, encodeWorkloadSample, escapeLabelValue, metricLine } from "../../src/metrics/encode.js";
import { LatestCache } from "../../src/metrics/latest.js";
import { buildSeriesQueries, chooseStepMs, fillGrid, rateWindow, SeriesQueryError, stepGrid } from "../../src/metrics/series.js";
import { loadFixture } from "../support/fake-agent.js";

const NODE = "6f1c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c";
const SERVER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("Prometheus text encoding", () => {
  const frame = MetricsFrame.parse(loadFixture("metrics.json"));

  it("encodes node samples with bf_node_* names, labels and millisecond timestamps", () => {
    const lines = encodeNodeSample(NODE, frame.node, { logicalCores: 64 });
    expect(lines).toContain(`bf_node_cpu_usage_percent{node="${NODE}"} 37.5 1760000000000`);
    expect(lines).toContain(`bf_node_cpu_core_usage_percent{node="${NODE}",core="3"} 36.7 1760000000000`);
    expect(lines).toContain(`bf_node_fs_used_bytes{node="${NODE}",mount="/"} 250051221504 1760000000000`);
    expect(lines).toContain(`bf_node_disk_latency_ms{node="${NODE}",device="nvme0n1"} 0.21 1760000000000`);
    expect(lines).toContain(`bf_node_net_rx_dropped_total{node="${NODE}",iface="eth0"} 12 1760000000000`);
    expect(lines).toContain(`bf_node_cpu_logical_cores{node="${NODE}"} 64 1760000000000`);
    expect(lines.every((l) => /^bf_node_[a-z0-9_]+\{[^}]*\} -?[0-9.e+-]+ \d+$/.test(l))).toBe(true);
  });

  it("encodes workload samples with bf_server_* names (incl. JVM and SLP)", () => {
    const lines = encodeWorkloadSample(SERVER, NODE, frame.workloads[0]!);
    expect(lines).toContain(`bf_server_cpu_percent{server="${SERVER}",node="${NODE}"} 142.5 1760000000000`);
    expect(lines).toContain(`bf_server_jvm_heap_used_bytes{server="${SERVER}",node="${NODE}"} 1503238553 1760000000000`);
    expect(lines).toContain(`bf_server_players_online{server="${SERVER}",node="${NODE}"} 2 1760000000000`);
    expect(lines).toContain(`bf_server_running{server="${SERVER}",node="${NODE}"} 1 1760000000000`);
  });

  it("omits fields the platform did not provide (no zero-filling)", () => {
    const lines = encodeNodeSample(NODE, { ...frame.node, cpu: { usagePct: 5 }, tcp: undefined });
    expect(lines.some((l) => l.startsWith("bf_node_load1"))).toBe(false);
    expect(lines.some((l) => l.startsWith("bf_node_tcp_"))).toBe(false);
    expect(metricLine("x", {}, Number.NaN, 1)).toBeNull();
    expect(metricLine("x", {}, undefined, 1)).toBeNull();
  });

  it("escapes and sanitises untrusted label values", () => {
    expect(escapeLabelValue('a"b\\c')).toBe('a\\"b\\\\c');
    expect(escapeLabelValue("line\nbreak\u0000")).toBe("linebreak");
    expect(escapeLabelValue("x".repeat(500))).toHaveLength(128);
    const line = metricLine("bf_node_fs_used_bytes", { node: NODE, mount: '/mnt/"evil"} 1 1\nbf_fake{' }, 1, 5);
    expect(line).toBe(`bf_node_fs_used_bytes{node="${NODE}",mount="/mnt/\\"evil\\"} 1 1bf_fake{"} 1 5`);
    expect(line!.split("\n")).toHaveLength(1);
  });

  it("applies the clock-skew offset to timestamps", () => {
    const [line] = encodeNodeSample(NODE, frame.node, { tsOffsetMs: -5000 });
    expect(line!.endsWith(" 1759999995000")).toBe(true);
  });
});

describe("PromQL templates", () => {
  it("maps every whitelisted series id", () => {
    for (const id of Object.keys(METRIC_SERIES) as MetricSeriesId[]) {
      const q = buildSeriesQueries(id, { nodeId: NODE, serverId: SERVER, nodeIds: "all" }, 15_000);
      expect(q.length).toBeGreaterThan(0);
      for (const s of q) expect(s.promql).toMatch(/bf_(node|server)_/);
    }
  });

  it("interpolates only validated UUIDs", () => {
    expect(buildSeriesQueries("node.cpu.usage", { nodeId: NODE }, 5000)[0]!.promql).toBe(`bf_node_cpu_usage_percent{node="${NODE}"}`);
    expect(() => buildSeriesQueries("node.cpu.usage", { nodeId: `${NODE}"} or vector(1) #` }, 5000)).toThrow(SeriesQueryError);
    expect(() => buildSeriesQueries("server.cpu", { serverId: "x" }, 5000)).toThrow(SeriesQueryError);
    expect(() => buildSeriesQueries("global.memory", { nodeIds: [NODE, "evil|.*"] }, 5000)).toThrow(SeriesQueryError);
  });

  it("restricts global series to permitted nodes and weights CPU by cores", () => {
    const [cpu] = buildSeriesQueries("global.cpu.usage", { nodeIds: [NODE, SERVER] }, 5000);
    expect(cpu!.promql).toContain(`node=~"${NODE}|${SERVER}"`);
    expect(cpu!.promql).toContain("bf_node_cpu_logical_cores");
    const [all] = buildSeriesQueries("global.memory", { nodeIds: "all" }, 5000);
    expect(all!.promql).toBe("sum(bf_node_memory_used_bytes)");
    const net = buildSeriesQueries("global.net.throughput", { nodeIds: "all" }, 5000);
    expect(net[0]!.promql).toContain('iface!~"lo|docker');
  });

  it("filters global.players by visible servers (server/network grants count)", () => {
    const [q] = buildSeriesQueries("global.players", { nodeIds: [], serverIds: [SERVER] }, 5000);
    expect(q!.promql).toBe(`sum(bf_server_players_online{server=~"${SERVER}"})`);
    expect(buildSeriesQueries("global.players", { nodeIds: "all", serverIds: "all" }, 5000)[0]!.promql).toBe("sum(bf_server_players_online)");
    expect(() => buildSeriesQueries("global.players", { serverIds: ["x|.*"] }, 5000)).toThrow(SeriesQueryError);
  });

  it("uses rate() windows of at least a minute for counters", () => {
    expect(rateWindow(5000)).toBe("60s");
    expect(rateWindow(120_000)).toBe("240s");
    expect(buildSeriesQueries("server.jvm.gc", { serverId: SERVER }, 5000)[0]!.promql).toBe(`rate(bf_server_jvm_gc_time_ms_total{server="${SERVER}"}[60s])`);
  });

  it("chooses ~300 points, at least 5 s, whole seconds", () => {
    expect(chooseStepMs(0, 60 * 60_000)).toBe(12_000);
    expect(chooseStepMs(0, 5 * 60_000)).toBe(5000);
    expect(chooseStepMs(0, 7 * 24 * 60 * 60_000)).toBe(2_016_000);
    expect(chooseStepMs(0, 60 * 60_000, 7_500)).toBe(8000);
    expect(chooseStepMs(0, 30 * 24 * 60 * 60_000, 5000)).toBe(1_296_000); // ≤ 2000 points
  });

  it("fills the step grid with nulls for missing points", () => {
    const grid = stepGrid(10_500, 40_000, 10_000);
    expect(grid).toEqual([10_000, 20_000, 30_000, 40_000]);
    expect(fillGrid(grid, [[10, "1.5"], [30, "NaN"], [40, "3"]])).toEqual([
      [10_000, 1.5],
      [20_000, null],
      [30_000, null],
      [40_000, 3],
    ]);
  });
});

describe("latest cache", () => {
  it("treats samples older than 3 × the metrics interval as missing", () => {
    // Frozen time: the 15 000 ms boundary must not depend on how long the test takes.
    let now = Date.now();
    const clock = { now: () => now, advance: (ms: number) => void (now += ms) };
    const cache = new LatestCache(clock, 5000);
    const frame = MetricsFrame.parse(loadFixture("metrics.json"));
    cache.setNode(NODE, frame.node);
    cache.setWorkload(SERVER, NODE, frame.workloads[0]!);
    expect(cache.getNode(NODE)).not.toBeNull();
    clock.advance(15_000);
    expect(cache.getNode(NODE)).not.toBeNull();
    clock.advance(1);
    expect(cache.getNode(NODE)).toBeNull();
    expect(cache.freshWorkloads()).toHaveLength(0);
    cache.removeNode(NODE);
    expect(cache.getWorkload(SERVER)).toBeNull();
  });
});
