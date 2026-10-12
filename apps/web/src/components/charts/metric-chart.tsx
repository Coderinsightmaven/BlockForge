import { useQuery } from "@tanstack/react-query";
import { ChartLine, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { METRIC_SERIES } from "@blockforge/contracts";
import type { MetricSeriesResult } from "@blockforge/contracts";
import { metricRangeQuery } from "@/lib/queries";
import type { MetricTarget } from "@/lib/queries";
import { describeTimeRange } from "@/lib/time-range";
import type { TimeRange } from "@/lib/time-range";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/tooltip";
import { alignLines } from "./chart-data";
import type { MetricLine } from "./chart-data";
import { TimeSeriesChart } from "./time-series-chart";

export function ChartViewToggle({
  view,
  onChange,
}: {
  view: "chart" | "table";
  onChange: (v: "chart" | "table") => void;
}) {
  return (
    <div className="flex rounded-md border p-0.5" role="group" aria-label="Display as">
      {(["chart", "table"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          title={v === "chart" ? "Chart" : "Table of exact values"}
          onClick={() => onChange(v)}
          className={cn(
            "inline-flex h-6 items-center rounded-sm px-1.5 text-muted-foreground hover:text-foreground",
            view === v && "bg-accent text-foreground",
          )}
        >
          {v === "chart" ? (
            <ChartLine className="size-3.5" aria-hidden />
          ) : (
            <Table2 className="size-3.5" aria-hidden />
          )}
          <span className="sr-only">{v === "chart" ? "Chart" : "Table"}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A card with one historical chart for a whitelisted series, fetched from
 * `GET /metrics/range`. Missing samples render as gaps; nothing is interpolated.
 */
export function MetricChart({
  title,
  info,
  target,
  range,
  height = 180,
  transformLines,
  className,
  emptyText,
}: {
  title: string;
  info?: ReactNode;
  target: MetricTarget;
  range: TimeRange;
  height?: number;
  /** Rename / filter / colour lines before plotting. */
  transformLines?: (
    lines: MetricSeriesResult["lines"],
  ) => Array<MetricLine & { label?: string; colorIndex?: number }>;
  className?: string;
  emptyText?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const query = useQuery(metricRangeQuery(target, range));
  const result = query.data;
  const data = useMemo(
    () =>
      result ? alignLines(transformLines ? transformLines(result.lines) : result.lines, result.stepMs) : null,
    [result, transformLines],
  );
  const unit = result?.unit ?? METRIC_SERIES[target.series].unit;
  return (
    <Card className={className}>
      <CardHeader className="pb-1">
        <div className="flex items-center gap-1.5">
          <CardTitle>{title}</CardTitle>
          {info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
        </div>
        <ChartViewToggle view={view} onChange={setView} />
      </CardHeader>
      <CardContent>
        <TimeSeriesChart
          data={data}
          unit={unit}
          label={`${title}, ${describeTimeRange(range).toLowerCase()}`}
          height={height}
          loading={query.isPending}
          refreshing={query.isFetching && !query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          window={result ? { from: result.from, to: result.to } : undefined}
          view={view}
          emptyText={emptyText}
        />
      </CardContent>
    </Card>
  );
}
