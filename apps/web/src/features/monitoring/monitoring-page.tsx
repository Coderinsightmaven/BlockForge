import { useQueries, useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { METRIC_SERIES } from "@blockforge/contracts";
import type { Me, MetricSeriesId, Node } from "@blockforge/contracts";
import { canAny } from "@/lib/permissions";
import { metricRangeQuery, nodesQuery } from "@/lib/queries";
import { describeTimeRange, refreshIntervalFor, resolveTimeRange, timeRangeKey } from "@/lib/time-range";
import type { TimeRange } from "@/lib/time-range";
import { MAX_CATEGORICAL_SERIES, alignLines, lineLabel, seriesKey } from "@/components/charts/chart-data";
import type { MetricLine } from "@/components/charts/chart-data";
import { TimeSeriesChart } from "@/components/charts/lazy-time-series-chart";
import { ChartViewToggle } from "@/components/charts/metric-chart";
import { TimeRangePicker } from "@/components/charts/time-range-picker";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, NoPermission } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { NODE_CONNECTION_META, StatusDot, statusMeta } from "@/components/ui/status";
import { NODE_CHARTS } from "@/features/nodes/node-charts";

export const MAX_COMPARE_NODES = MAX_CATEGORICAL_SERIES;

const NODE_SERIES = NODE_CHARTS.map((c) => ({ value: c.series, label: c.title }));

/**
 * Colour follows the node, not its position in the selection: each node prefers the slot of its
 * index in the full (name-sorted) node list; collisions among the selected take the next free slot.
 */
export function assignNodeColors(
  selectedIds: readonly string[],
  allSorted: readonly Pick<Node, "id">[],
): Map<string, number> {
  const used = new Set<number>();
  const out = new Map<string, number>();
  const order = [...selectedIds].sort(
    (a, b) => allSorted.findIndex((n) => n.id === a) - allSorted.findIndex((n) => n.id === b),
  );
  for (const id of order) {
    const preferred =
      Math.max(
        0,
        allSorted.findIndex((n) => n.id === id),
      ) % MAX_CATEGORICAL_SERIES;
    let slot = preferred;
    for (let i = 0; i < MAX_CATEGORICAL_SERIES && used.has(slot); i++)
      slot = (preferred + i + 1) % MAX_CATEGORICAL_SERIES;
    used.add(slot);
    out.set(id, slot);
  }
  return out;
}

/** Keeps several range queries on one identical window so their steps align. */
function useSharedWindow(range: TimeRange): { from: number; to: number } {
  const key = timeRangeKey(range);
  const [anchor, setAnchor] = useState(() => Date.now());
  const every = refreshIntervalFor(range);
  useEffect(() => {
    setAnchor(Date.now());
    if (!every) return;
    const t = setInterval(() => setAnchor(Date.now()), every);
    return () => clearInterval(t);
  }, [key, every]);
  // `range` is re-derived from the URL on every render; the key is its stable identity.
  return useMemo(() => resolveTimeRange(range, anchor), [key, anchor]);
}

function NodePicker({
  nodes,
  selected,
  onChange,
}: {
  nodes: Node[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = nodes.filter((n) =>
    `${n.name} ${n.location ?? ""} ${n.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()),
  );
  const full = selected.length >= MAX_COMPARE_NODES;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="min-w-44 justify-between">
          <span className="flex items-center gap-1.5">
            <Server aria-hidden />
            {selected.length ? `${selected.length} node${selected.length === 1 ? "" : "s"}` : "Choose nodes"}
          </span>
          <ChevronsUpDown className="opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter nodes…"
          aria-label="Filter nodes"
          className="mb-2"
        />
        <p className="mb-1.5 px-1 text-xs text-muted-foreground">
          Up to {MAX_COMPARE_NODES} nodes ({selected.length} selected).
        </p>
        <ul className="max-h-72 overflow-y-auto">
          {filtered.map((n) => {
            const checked = selected.includes(n.id);
            const id = `pick-${n.id}`;
            return (
              <li key={n.id} className="flex items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent">
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={!checked && full}
                  onCheckedChange={(v) =>
                    onChange(v ? [...selected, n.id] : selected.filter((s) => s !== n.id))
                  }
                />
                <Label htmlFor={id} className="flex flex-1 items-center justify-between gap-2 font-normal">
                  <span className="truncate">{n.name}</span>
                  <StatusDot meta={statusMeta(NODE_CONNECTION_META, n.connection)} hideLabel />
                </Label>
              </li>
            );
          })}
          {filtered.length === 0 ? (
            <li className="px-1 py-2 text-xs text-muted-foreground">No nodes match.</li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function MonitoringPage({
  me,
  nodeIds,
  series,
  line,
  range,
  onChange,
}: {
  me: Me;
  nodeIds: string[] | null;
  series: MetricSeriesId;
  line: string | null;
  range: TimeRange;
  onChange: (patch: {
    nodes?: string[];
    series?: MetricSeriesId;
    line?: string | null;
    range?: TimeRange;
  }) => void;
}) {
  const allowed = canAny(me, "monitoring.view") && canAny(me, "nodes.view");
  const [view, setView] = useState<"chart" | "table">("chart");
  const nodesQ = useQuery({ ...nodesQuery, enabled: allowed });
  const allSorted = useMemo(
    () => [...(nodesQ.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [nodesQ.data],
  );
  // Default selection: up to four reporting nodes.
  const selected = useMemo(
    () =>
      (
        nodeIds ??
        allSorted
          .filter((n) => n.status !== "revoked" && n.connection !== "offline")
          .slice(0, 4)
          .map((n) => n.id)
      )
        .filter((id) => allSorted.some((n) => n.id === id))
        .slice(0, MAX_COMPARE_NODES),
    [nodeIds, allSorted],
  );
  const sharedWindow = useSharedWindow(range);
  const results = useQueries({
    queries: selected.map((nodeId) => ({
      ...metricRangeQuery({ series, nodeId }, range, sharedWindow),
      enabled: allowed,
    })),
  });
  const colors = useMemo(() => assignNodeColors(selected, allSorted), [selected, allSorted]);

  // Distinct sub-lines (e.g. "Used", "eth0 · rx") across all returned results.
  const lineOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of results)
      for (const l of r.data?.lines ?? []) map.set(seriesKey(l.labels), lineLabel(l.labels));
    return [...map]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [results]);
  const activeLine =
    line && lineOptions.some((o) => o.value === line) ? line : (lineOptions[0]?.value ?? null);

  const merged = useMemo(() => {
    const lines: Array<MetricLine & { label: string; key: string; colorIndex?: number }> = [];
    let stepMs = 0;
    selected.forEach((nodeId, i) => {
      const r = results[i]?.data;
      if (!r) return;
      stepMs = Math.max(stepMs, r.stepMs);
      const node = allSorted.find((n) => n.id === nodeId);
      for (const l of r.lines) {
        if (activeLine && seriesKey(l.labels) !== activeLine) continue;
        lines.push({ ...l, key: nodeId, label: node?.name ?? nodeId, colorIndex: colors.get(nodeId) });
      }
    });
    return lines.length ? alignLines(lines, stepMs) : null;
  }, [results, selected, allSorted, activeLine, colors]);

  if (!allowed) return <NoPermission what="view monitoring data for nodes" />;
  const unit = results.find((r) => r.data)?.data?.unit ?? METRIC_SERIES[series].unit;
  const anyPending = results.some((r) => r.isPending);
  const firstError = results.find((r) => r.error)?.error;
  const seriesTitle = NODE_SERIES.find((s) => s.value === series)?.label ?? series;

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="Compare a metric across nodes over time. Colours stay attached to each node."
      />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <TimeRangePicker value={range} onChange={(r) => onChange({ range: r })} />
        {nodesQ.data ? (
          <NodePicker nodes={allSorted} selected={selected} onChange={(ids) => onChange({ nodes: ids })} />
        ) : null}
        <div className="w-52">
          <Select
            value={series}
            onValueChange={(v) => onChange({ series: v, line: null })}
            options={NODE_SERIES}
            aria-label="Metric"
          />
        </div>
        {lineOptions.length > 1 ? (
          <div className="w-52">
            <Select
              value={activeLine ?? undefined}
              onValueChange={(v) => onChange({ line: v })}
              options={lineOptions}
              aria-label="Line"
            />
          </div>
        ) : null}
      </div>
      {nodesQ.isError && !nodesQ.data ? (
        <Card>
          <ErrorState
            error={nodesQ.error}
            onRetry={() => void nodesQ.refetch()}
            title="Could not load nodes"
          />
        </Card>
      ) : nodesQ.data && nodesQ.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={Server}
            title="No nodes to compare"
            description="Enroll a node to start collecting metrics."
          />
        </Card>
      ) : selected.length === 0 && nodesQ.data ? (
        <Card>
          <EmptyState
            icon={Server}
            title="Choose nodes to compare"
            description="Pick up to eight nodes with the node selector above."
          />
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {seriesTitle}
              {activeLine && lineOptions.length > 1 ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {lineOptions.find((o) => o.value === activeLine)?.label}
                </span>
              ) : null}
            </CardTitle>
            <ChartViewToggle view={view} onChange={setView} />
          </CardHeader>
          <CardContent>
            <TimeSeriesChart
              data={merged}
              unit={unit}
              label={`${seriesTitle} by node, ${describeTimeRange(range).toLowerCase()}`}
              height={320}
              loading={nodesQ.isPending || (anyPending && !merged)}
              refreshing={results.some((r) => r.isFetching)}
              error={firstError}
              onRetry={() => results.forEach((r) => void r.refetch())}
              window={sharedWindow}
              view={view}
            />
            {firstError && merged ? (
              <p className="mt-2 text-xs text-danger" role="status">
                Some nodes could not be loaded: {(firstError as Error).message}
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}
    </>
  );
}
