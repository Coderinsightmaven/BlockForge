import type { Node } from "@blockforge/contracts";
import type { TimeRange } from "@/lib/time-range";
import { MetricChart } from "@/components/charts/metric-chart";
import { TimeRangePicker } from "@/components/charts/time-range-picker";
import { NODE_CHARTS } from "./node-charts";

/** Node → History: metric charts over a time range (its own chunk; the plots load lazily too). */
export default function NodeMetricsTab({
  node,
  range,
  onRangeChange,
}: {
  node: Node;
  range: TimeRange;
  onRangeChange: (r: TimeRange) => void;
}) {
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Historical samples from the metrics store. Gaps mean the agent was not reporting.
        </p>
        <TimeRangePicker value={range} onChange={onRangeChange} />
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {NODE_CHARTS.map((c) => (
          <MetricChart
            key={c.series}
            title={c.title}
            info={c.info}
            target={{ series: c.series, nodeId: node.id }}
            range={range}
          />
        ))}
      </div>
    </>
  );
}
