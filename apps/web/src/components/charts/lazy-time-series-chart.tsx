import { Suspense, lazy } from "react";
import type { TimeSeriesChartProps } from "./time-series-chart";

/*
 * The uPlot chart is loaded on first use, so routes that show charts (monitoring, node and server
 * stats) don't carry the plotting library in their first-load JS. Until it arrives the chart area
 * shows a loading placeholder of the same height — never values.
 */
const Impl = lazy(() => import("./time-series-chart").then((m) => ({ default: m.TimeSeriesChart })));

export function ChartLoading({ height = 200, label }: { height?: number; label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`${label}: loading chart`}
      style={{ height: height + 36 }}
      className="flex w-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground"
    >
      Loading chart…
    </div>
  );
}

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  return (
    <Suspense fallback={<ChartLoading height={props.height} label={props.label} />}>
      <Impl {...props} />
    </Suspense>
  );
}
