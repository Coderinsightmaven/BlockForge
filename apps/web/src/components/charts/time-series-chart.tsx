import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { ChartLine } from "lucide-react";
import { formatAxisTicks, formatMetricValue, formatTimestamp, localTimeZone } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Skeleton } from "@/components/ui/skeleton";
import { MAX_CATEGORICAL_SERIES, hasAnyValue, lastIndexWithData, lineStats } from "./chart-data";
import type { AlignedChartData, ChartSeries } from "./chart-data";

const TOOLTIP_WIDTH = 220;

export { MAX_CATEGORICAL_SERIES } from "./chart-data";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function seriesSlot(series: ChartSeries, index: number): number {
  return ((series.colorIndex ?? index) % MAX_CATEGORICAL_SERIES) + 1;
}

/** "#2a78d6" → "rgba(42,120,214,0.55)"; other formats are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return color;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
}

const _ = null;
/** 24-hour local-time tick formats: [incr, default, year, month, day, hour, min, sec, mode]. */
const TIME_AXIS_VALUES: (string | number | null)[][] = [
  [3600 * 24 * 365, "{YYYY}", _, _, _, _, _, _, 1],
  [3600 * 24 * 28, "{MMM}", "\n{YYYY}", _, _, _, _, _, 1],
  [3600 * 24, "{MMM} {D}", "\n{YYYY}", _, _, _, _, _, 1],
  [3600, "{HH}:{mm}", "\n{YYYY}-{MM}-{DD}", _, "\n{MMM} {D}", _, _, _, 1],
  [60, "{HH}:{mm}", "\n{YYYY}-{MM}-{DD}", _, "\n{MMM} {D}", _, _, _, 1],
  [1, ":{ss}", "\n{YYYY}-{MM}-{DD} {HH}:{mm}", _, "\n{MMM} {D} {HH}:{mm}", _, "\n{HH}:{mm}", _, 1],
];

export interface TimeSeriesChartProps {
  data: AlignedChartData | null | undefined;
  unit: string;
  /** Accessible name, e.g. "CPU usage, last hour". */
  label: string;
  height?: number;
  /** Initial load (no data yet). */
  loading?: boolean;
  /** Background refetch: the previous render is kept, dimmed. */
  refreshing?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Visible x window (epoch ms) so sparse data still shows the full requested range. */
  window?: { from: number; to: number };
  /** Fixed y range; defaults to 0–100 for percent and 0–auto otherwise. */
  yRange?: [number, number];
  view?: "chart" | "table";
  emptyText?: string;
}

interface CursorState {
  idx: number | null;
  left: number;
  top: number;
}

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { data, loading, error, onRetry, height = 200, view = "chart", emptyText } = props;
  if (loading && !data) return <Skeleton className="w-full" style={{ height: height + 36 }} />;
  if (error && !data)
    return <ErrorState error={error} onRetry={onRetry} title="Could not load metrics" compact />;
  if (!data || data.series.length === 0 || !hasAnyValue(data)) {
    return (
      <div
        style={{ minHeight: height }}
        className="flex items-center justify-center rounded-md border border-dashed"
      >
        <EmptyState
          icon={ChartLine}
          compact
          title="No data in this time range"
          description={
            emptyText ??
            "No samples were recorded for this metric in the selected window. Gaps mean the agent was not reporting; values are never interpolated."
          }
        />
      </div>
    );
  }
  return view === "table" ? (
    <SeriesTable data={data} unit={props.unit} />
  ) : (
    <UPlotChart {...props} data={data} height={height} />
  );
}

function UPlotChart({
  data,
  unit,
  label,
  height,
  refreshing,
  window: xWindow,
  yRange,
}: TimeSeriesChartProps & { data: AlignedChartData; height: number }) {
  const { resolved: theme } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const windowRef = useRef(xWindow);
  windowRef.current = xWindow;
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<CursorState>({ idx: null, left: 0, top: 0 });
  // Pointer moves fire far more often than frames; coalesce them into one commit per frame.
  const pendingCursor = useRef<CursorState | null>(null);
  const cursorFrame = useRef<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const mono = data.series.length > MAX_CATEGORICAL_SERIES;

  const structure = `${data.series.map((s) => `${s.key}#${s.colorIndex ?? ""}`).join("|")}::${unit}::${theme}::${height}::${mono}`;
  const aligned = useMemo(() => [data.xs, ...data.ys] as uPlot.AlignedData, [data]);
  // DOM swatches use CSS variables (always the current theme); the canvas resolves them in its effect.
  const slots = useMemo(() => data.series.map((s, i) => (mono ? 1 : seriesSlot(s, i))), [data.series, mono]);
  const colors = slots.map((slot) => `var(--chart-${slot})`);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // (Re)create the plot when its structure changes; data updates go through setData below.
  useEffect(() => {
    const el = plotRef.current;
    if (!el || width === 0) return;
    const text = cssVar("--chart-text");
    const grid = cssVar("--chart-grid");
    const axisLine = cssVar("--chart-axis");
    const font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const percent = unit === "percent";
    const opts: uPlot.Options = {
      width,
      height,
      padding: [10, 12, 0, 4],
      legend: { show: false },
      cursor: {
        drag: { x: false, y: false },
        points: { size: 7, width: 2 },
        focus: { prox: 24 },
      },
      focus: { alpha: 0.35 },
      scales: {
        x: {
          time: true,
          range: (_u, dataMin, dataMax) => {
            const w = windowRef.current;
            return w ? [w.from / 1000, w.to / 1000] : [dataMin, dataMax];
          },
        },
        y: {
          range: (_u, _min, dataMax) => {
            if (yRange) return yRange;
            if (percent) return [0, Math.max(100, dataMax ?? 0)];
            const max = dataMax && dataMax > 0 ? dataMax : 1;
            return uPlot.rangeNum(0, max, 0.1, true);
          },
        },
      },
      axes: [
        {
          stroke: text,
          font,
          values: TIME_AXIS_VALUES,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: axisLine, width: 1, size: 4 },
          border: { show: true, stroke: axisLine, width: 1 },
        },
        {
          stroke: text,
          font,
          size: 64,
          values: (_u, ticks) => formatAxisTicks(unit, ticks),
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
        },
      ],
      series: [
        {},
        ...data.series.map((s, i) => ({
          label: s.label,
          stroke: mono ? withAlpha(cssVar("--chart-1"), 0.55) : cssVar(`--chart-${slots[i] ?? 1}`),
          width: mono ? 1 : 2,
          spanGaps: false,
          points: { show: false },
          show: !hidden.has(s.key),
        })),
      ],
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx ?? null;
            const inside = (u.cursor.left ?? -1) >= 0;
            let next: CursorState = { idx: null, left: 0, top: 0 };
            if (idx !== null && inside) {
              // Anchor the tooltip to the hovered sample (not the raw pointer), converted from
              // plot-area to host coordinates, so React only re-renders when the sample changes.
              const x = u.data[0][idx];
              const plotLeft = u.bbox.left / uPlot.pxRatio;
              next = {
                idx,
                left: (x === undefined ? (u.cursor.left ?? 0) : u.valToPos(x, "x")) + plotLeft,
                top: 0,
              };
            }
            pendingCursor.current = next;
            if (cursorFrame.current !== null) return;
            cursorFrame.current = requestAnimationFrame(() => {
              cursorFrame.current = null;
              const n = pendingCursor.current;
              if (!n) return;
              setCursor((prev) => (prev.idx === n.idx && Math.abs(prev.left - n.left) < 0.5 ? prev : n));
            });
          },
        ],
      },
    };
    const u = new uPlot(opts, aligned, el);
    chartRef.current = u;
    return () => {
      if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
      cursorFrame.current = null;
      u.destroy();
      chartRef.current = null;
    };
    // Data, size and visibility are applied incrementally by the effects below.
  }, [structure, width > 0]);

  useEffect(() => {
    chartRef.current?.setData(aligned);
  }, [aligned, xWindow?.from, xWindow?.to]);

  useEffect(() => {
    if (width > 0) chartRef.current?.setSize({ width, height });
  }, [width, height]);

  const toggle = (s: ChartSeries, index: number) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s.key)) next.delete(s.key);
      else next.add(s.key);
      chartRef.current?.setSeries(index + 1, { show: !next.has(s.key) });
      return next;
    });
  };

  const readoutIdx = cursor.idx ?? lastIndexWithData(data);
  const readoutTs = readoutIdx !== null ? (data.xs[readoutIdx] ?? 0) * 1000 : null;
  const valueAt = (seriesIndex: number) =>
    readoutIdx === null ? null : (data.ys[seriesIndex]?.[readoutIdx] ?? null);
  const tooltipRows = data.series
    .map((s, i) => ({ s, i, v: valueAt(i) }))
    .filter((r) => !hidden.has(r.s.key))
    .sort(
      (a, b) => (typeof b.v === "number" ? b.v : -Infinity) - (typeof a.v === "number" ? a.v : -Infinity),
    );

  return (
    <figure className={cn("m-0 flex flex-col gap-2", refreshing && "opacity-70")} aria-label={label}>
      <div ref={hostRef} className="relative w-full" style={{ height }}>
        <div ref={plotRef} role="img" aria-label={`${label}. Use the table view for exact values.`} />
        {cursor.idx !== null && readoutTs !== null ? (
          <div
            className="pointer-events-none absolute z-10 min-w-36 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md"
            style={
              cursor.left + 16 + TOOLTIP_WIDTH > width
                ? { top: 8, right: Math.max(0, width - cursor.left + 16) }
                : { top: 8, left: cursor.left + 16 }
            }
          >
            <div className="mb-1 text-muted-foreground tabular">{formatTimestamp(readoutTs)}</div>
            <ul className="flex flex-col gap-0.5">
              {(mono ? tooltipRows.slice(0, 6) : tooltipRows).map(({ s, i, v }) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: colors[i] }} />
                  <span className="font-semibold tabular">
                    {v === null || v === undefined ? "no data" : formatMetricValue(unit, v)}
                  </span>
                  <span className="truncate text-muted-foreground">{s.label}</span>
                </li>
              ))}
              {mono && tooltipRows.length > 6 ? (
                <li className="text-muted-foreground">+{tooltipRows.length - 6} more (highest shown)</li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {mono ? (
          <MonoSummary data={data} unit={unit} idx={readoutIdx} />
        ) : (
          data.series.map((s, i) => {
            const v = valueAt(i);
            const off = hidden.has(s.key);
            return (
              <button
                key={s.key}
                type="button"
                aria-pressed={!off}
                title={off ? `Show ${s.label}` : `Hide ${s.label}`}
                onClick={() => toggle(s, i)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-accent",
                  off && "opacity-45",
                )}
              >
                <span aria-hidden className="h-0.5 w-3.5 rounded-full" style={{ background: colors[i] }} />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="font-medium tabular">
                  {v === null || v === undefined ? "—" : formatMetricValue(unit, v)}
                </span>
              </button>
            );
          })
        )}
        <span
          className="ml-auto text-muted-foreground tabular"
          title={`Times are shown in ${localTimeZone()}`}
        >
          {cursor.idx === null ? "Latest" : "At"}{" "}
          {readoutTs !== null ? formatTimestamp(readoutTs, { seconds: true }) : "—"}
        </span>
      </figcaption>
    </figure>
  );
}

function MonoSummary({ data, unit, idx }: { data: AlignedChartData; unit: string; idx: number | null }) {
  const values =
    idx === null ? [] : data.ys.map((ys) => ys[idx]).filter((v): v is number => typeof v === "number");
  const stats = lineStats(values);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 text-muted-foreground">
      <span>{data.series.length} series</span>
      <span>
        max <span className="font-medium text-foreground tabular">{formatMetricValue(unit, stats.max)}</span>
      </span>
      <span>
        avg <span className="font-medium text-foreground tabular">{formatMetricValue(unit, stats.avg)}</span>
      </span>
      <span>
        min <span className="font-medium text-foreground tabular">{formatMetricValue(unit, stats.min)}</span>
      </span>
    </span>
  );
}

/** Table twin of a chart: exact values for every series (accessibility relief for colour). */
export function SeriesTable({ data, unit }: { data: AlignedChartData; unit: string }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="px-2 py-1.5 text-left font-medium">
              Series
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Latest
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Min
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Avg
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Max
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Samples
            </th>
          </tr>
        </thead>
        <tbody>
          {data.series.map((s, i) => {
            const st = lineStats(data.ys[i] ?? []);
            return (
              <tr key={s.key} className="border-b last:border-0">
                <th scope="row" className="px-2 py-1 text-left font-normal">
                  {s.label}
                </th>
                <td className="px-2 py-1 text-right tabular">{formatMetricValue(unit, st.latest)}</td>
                <td className="px-2 py-1 text-right tabular">{formatMetricValue(unit, st.min)}</td>
                <td className="px-2 py-1 text-right tabular">{formatMetricValue(unit, st.avg)}</td>
                <td className="px-2 py-1 text-right tabular">{formatMetricValue(unit, st.max)}</td>
                <td className="px-2 py-1 text-right tabular">{st.samples}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
