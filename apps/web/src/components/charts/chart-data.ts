import type { MetricSeriesResult } from "@blockforge/contracts";

export type MetricLine = MetricSeriesResult["lines"][number];

export interface ChartSeries {
  /** Stable identity (sorted label pairs) — colour follows this, never the row index. */
  key: string;
  label: string;
  labels: Record<string, string>;
  /** Categorical slot (0-based) chosen by the caller for stable entity colours. */
  colorIndex?: number;
}

/**
 * uPlot-ready data. `xs` are epoch **seconds**. In `ys`, `null` is a gap (missing telemetry,
 * never drawn across) and `undefined` means "this line has no sample at a timestamp that only
 * another line has" (joined over).
 */
export interface AlignedChartData {
  xs: number[];
  ys: Array<Array<number | null | undefined>>;
  series: ChartSeries[];
}

const LABEL_ORDER = ["node", "kind", "core", "iface", "device", "mount", "direction"];

function humanize(v: string): string {
  const s = v.replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function seriesKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

/** Human label for a line: `{kind:"used"}` → "Used", `{core:"3"}` → "Core 3", `{iface:"eth0",direction:"rx"}` → "eth0 · rx". */
export function lineLabel(labels: Record<string, string>): string {
  const rank = (k: string) => {
    const i = LABEL_ORDER.indexOf(k);
    return i === -1 ? LABEL_ORDER.length : i;
  };
  const keys = Object.keys(labels).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const parts = keys
    .map((k) => {
      const v = labels[k] ?? "";
      if (!v) return "";
      if (k === "core") return `Core ${v}`;
      if (k === "kind") return humanize(v);
      return v;
    })
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : "Value";
}

/** Gaps larger than this many steps are rendered as breaks even if the server omitted the nulls. */
const GAP_FACTOR = 1.5;

/**
 * Align the lines of one or more range results on a shared, sorted timeline.
 *  - explicit `null` values stay `null` (gap);
 *  - a jump of more than 1.5 × step between a line's own samples inserts a `null`, so missing
 *    telemetry is never drawn as a straight line even when the server omitted the points;
 *  - timestamps only present on other lines become `undefined` (joined over).
 */
export function alignLines(
  lines: ReadonlyArray<MetricLine & { label?: string; key?: string; colorIndex?: number }>,
  stepMs: number,
): AlignedChartData {
  const all = new Set<number>();
  for (const line of lines) for (const [ts] of line.points) all.add(ts);
  const sorted = [...all].sort((a, b) => a - b);

  // Timeline-level break: when *every* line skipped a stretch there is no index to null out.
  const timeline: number[] = [];
  const breaks = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    timeline.push(t);
    const next = sorted[i + 1];
    if (stepMs > 0 && next !== undefined && next - t > stepMs * GAP_FACTOR) {
      const marker = t + stepMs;
      timeline.push(marker);
      breaks.add(marker);
    }
  }
  const indexOf = new Map<number, number>();
  timeline.forEach((t, i) => indexOf.set(t, i));

  const ys = lines.map((line) => {
    const values: Array<number | null | undefined> = new Array(timeline.length).fill(undefined);
    for (const b of breaks) values[indexOf.get(b)!] = null;
    const own = [...line.points].sort((a, b) => a[0] - b[0]);
    let prevTs: number | null = null;
    let prevIdx = -1;
    for (const [ts, v] of own) {
      const idx = indexOf.get(ts)!;
      values[idx] = typeof v === "number" && Number.isFinite(v) ? v : null;
      if (stepMs > 0 && prevTs !== null && ts - prevTs > stepMs * GAP_FACTOR && idx - prevIdx > 1) {
        if (values[prevIdx + 1] === undefined) values[prevIdx + 1] = null;
      }
      prevTs = ts;
      prevIdx = idx;
    }
    return values;
  });

  return {
    xs: timeline.map((t) => t / 1000),
    ys,
    series: lines.map((line) => ({
      key: line.key ?? seriesKey(line.labels),
      label: line.label ?? lineLabel(line.labels),
      labels: line.labels,
      colorIndex: line.colorIndex,
    })),
  };
}

export function alignResult(result: Pick<MetricSeriesResult, "lines" | "stepMs">): AlignedChartData {
  return alignLines(result.lines, result.stepMs);
}

export function hasAnyValue(data: AlignedChartData | null | undefined): boolean {
  return !!data && data.ys.some((ys) => ys.some((v) => typeof v === "number"));
}

export interface LineStats {
  latest: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  samples: number;
}

export function lineStats(values: ReadonlyArray<number | null | undefined>): LineStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  let latest: number | null = null;
  for (const v of values) {
    if (typeof v !== "number") continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
    latest = v;
  }
  return n === 0
    ? { latest: null, min: null, max: null, avg: null, samples: 0 }
    : { latest, min, max, avg: sum / n, samples: n };
}

/** Index of the last timeline position where any line has a value (for the default readout). */
export function lastIndexWithData(data: AlignedChartData): number | null {
  for (let i = data.xs.length - 1; i >= 0; i--) {
    if (data.ys.some((ys) => typeof ys[i] === "number")) return i;
  }
  return null;
}
