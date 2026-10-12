import { createFileRoute } from "@tanstack/react-router";
import { METRIC_SERIES } from "@blockforge/contracts";
import type { MetricSeriesId } from "@blockforge/contracts";
import { parseTimeRange, serializeTimeRange } from "@/lib/time-range";
import { useMe } from "@/lib/use-me";
import { MonitoringPage } from "@/features/monitoring/monitoring-page";

const UUID = /^[0-9a-f-]{36}$/i;

interface MonitoringSearch {
  nodes?: string;
  series?: MetricSeriesId;
  line?: string;
  range?: string;
}

export const Route = createFileRoute("/_app/monitoring")({
  validateSearch: (search: Record<string, unknown>): MonitoringSearch => {
    const series =
      typeof search.series === "string" &&
      Object.hasOwn(METRIC_SERIES, search.series) &&
      search.series.startsWith("node.")
        ? (search.series as MetricSeriesId)
        : undefined;
    return {
      nodes: typeof search.nodes === "string" ? search.nodes : undefined,
      series,
      line: typeof search.line === "string" ? search.line.slice(0, 200) : undefined,
      range: typeof search.range === "string" ? search.range : undefined,
    };
  },
  component: function Monitoring() {
    const me = useMe();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const nodeIds = search.nodes === undefined ? null : search.nodes.split(",").filter((id) => UUID.test(id));
    return (
      <MonitoringPage
        me={me}
        nodeIds={nodeIds}
        series={search.series ?? "node.cpu.usage"}
        line={search.line ?? null}
        range={parseTimeRange(search.range)}
        onChange={(patch) =>
          void navigate({
            replace: true,
            search: (s) => ({
              ...s,
              ...(patch.nodes ? { nodes: patch.nodes.join(",") } : {}),
              ...(patch.series ? { series: patch.series } : {}),
              ...(patch.line !== undefined ? { line: patch.line ?? undefined } : {}),
              ...(patch.range ? { range: serializeTimeRange(patch.range) } : {}),
            }),
          })
        }
      />
    );
  },
});
