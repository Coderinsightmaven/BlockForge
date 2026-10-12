import type { MetricSeriesId, Server } from "@blockforge/contracts";
import type { TimeRange } from "@/lib/time-range";
import { MetricChart } from "@/components/charts/metric-chart";
import { TimeRangePicker } from "@/components/charts/time-range-picker";

interface ChartDef {
  series: MetricSeriesId;
  title: string;
  info: string;
  /** Only meaningful for Minecraft/JVM servers. */
  jvm?: boolean;
  players?: boolean;
}

const CHARTS: ChartDef[] = [
  {
    series: "server.cpu",
    title: "CPU",
    info: "Container CPU relative to one core (100 % = one full core, 200 % = two). Compare with the server's CPU limit.",
  },
  {
    series: "server.memory",
    title: "Memory",
    info: "Container memory in use (and its limit when reported).",
  },
  {
    series: "server.jvm.heap",
    title: "Java heap",
    info: "JVM heap used / committed / max from the BlockForge JVM probe. Heap is part of container memory.",
    jvm: true,
  },
  {
    series: "server.jvm.gc",
    title: "Garbage collection",
    info: "Time spent in GC per second of wall time.",
    jvm: true,
  },
  { series: "server.players", title: "Players online", info: "From server list pings.", players: true },
  { series: "server.net.throughput", title: "Network", info: "Container receive / transmit rate." },
  { series: "server.disk.throughput", title: "Disk I/O", info: "Container block-device read / write rate." },
];

export default function StatsTab({
  server,
  range,
  onRangeChange,
}: {
  server: Server;
  range: TimeRange;
  onRangeChange: (r: TimeRange) => void;
}) {
  const isMinecraft = server.game !== "other";
  const charts = CHARTS.filter((c) => (!c.jvm && !c.players) || isMinecraft);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Historical samples for this server. Gaps mean no data was reported.
        </p>
        <TimeRangePicker value={range} onChange={onRangeChange} />
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {charts.map((c) => (
          <MetricChart
            key={c.series}
            title={c.title}
            info={c.info}
            target={{ series: c.series, serverId: server.id }}
            range={range}
          />
        ))}
      </div>
    </>
  );
}
