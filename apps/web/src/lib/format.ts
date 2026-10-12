/**
 * Formatting helpers. Every function accepts null/undefined and renders the explicit
 * missing-data marker instead of inventing a value.
 */
export const MISSING = "—";

type Maybe = number | null | undefined;
const isNum = (v: Maybe): v is number => typeof v === "number" && Number.isFinite(v);

const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;

function iecScale(abs: number): { value: number; unit: (typeof IEC_UNITS)[number]; index: number } {
  let value = abs;
  let index = 0;
  while (value >= 1024 && index < IEC_UNITS.length - 1) {
    value /= 1024;
    index++;
  }
  return { value, unit: IEC_UNITS[index] ?? "B", index };
}

function autoDecimals(value: number, index: number): number {
  if (index === 0) return 0;
  if (value < 10) return 2;
  if (value < 100) return 1;
  return 0;
}

/** Bytes using IEC binary prefixes (1 KiB = 1024 B). */
export function formatBytes(bytes: Maybe, opts: { decimals?: number } = {}): string {
  if (!isNum(bytes)) return MISSING;
  const sign = bytes < 0 ? "-" : "";
  const { value, unit, index } = iecScale(Math.abs(bytes));
  const decimals = index === 0 ? 0 : (opts.decimals ?? autoDecimals(value, index));
  return `${sign}${value.toFixed(decimals)} ${unit}`;
}

export function formatBytesPerSecond(rate: Maybe): string {
  if (!isNum(rate)) return MISSING;
  return `${formatBytes(rate)}/s`;
}

/** `value` is already on a 0–100 scale. */
export function formatPercent(value: Maybe, decimals = 1): string {
  if (!isNum(value)) return MISSING;
  return `${value.toFixed(decimals)}%`;
}

/** part/total as a 0–100 percentage, or null when it cannot be computed. */
export function percentOf(part: Maybe, total: Maybe): number | null {
  if (!isNum(part) || !isNum(total) || total <= 0) return null;
  return (part / total) * 100;
}

export function formatNumber(value: Maybe, maxFractionDigits = 1): string {
  if (!isNum(value)) return MISSING;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(value);
}

/** Rate of discrete events (errors, packets). */
export function formatRate(value: Maybe, unit = "/s", maxFractionDigits = 2): string {
  if (!isNum(value)) return MISSING;
  return `${formatNumber(value, maxFractionDigits)}${unit}`;
}

/** Millicores → cores ("2.5 cores", "1 core"). */
export function formatMillicores(millicores: Maybe): string {
  if (!isNum(millicores)) return MISSING;
  return formatCores(millicores / 1000);
}

export function formatCores(cores: Maybe): string {
  if (!isNum(cores)) return MISSING;
  const text = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(cores);
  return `${text} ${cores === 1 ? "core" : "cores"}`;
}

export function millicoresToCores(millicores: number): number {
  return millicores / 1000;
}

/** Compact human duration: "850 ms", "42s", "5m 12s", "3h 4m", "2d 6h". */
export function formatDuration(ms: Maybe): string {
  if (!isNum(ms)) return MISSING;
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`;
  const totalSeconds = Math.floor(abs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return sign + parts.slice(0, 2).join(" ");
}

export function formatMilliseconds(ms: Maybe): string {
  if (!isNum(ms)) return MISSING;
  if (Math.abs(ms) >= 1000) return `${formatNumber(ms / 1000, 2)} s`;
  return `${formatNumber(ms, Math.abs(ms) < 10 ? 2 : 1)} ms`;
}

/** The browser's IANA time zone, e.g. "Europe/Berlin". */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

type DatePartKey = "year" | "month" | "day" | "hour" | "minute" | "second" | "timeZoneName";
type DateParts = Record<DatePartKey, string>;
const DATE_PART_KEYS = new Set<string>(["year", "month", "day", "hour", "minute", "second", "timeZoneName"]);

function dateParts(ts: number, timeZone?: string): DateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const out: DateParts = { year: "", month: "", day: "", hour: "", minute: "", second: "", timeZoneName: "" };
  for (const part of fmt.formatToParts(new Date(ts))) {
    if (DATE_PART_KEYS.has(part.type)) out[part.type as DatePartKey] = part.value;
  }
  return out;
}

/** Unambiguous absolute timestamp: "2026-10-11 14:03:22 UTC". */
export function formatTimestamp(
  ts: Maybe,
  opts: { timeZone?: string; seconds?: boolean; zone?: boolean } = {},
): string {
  if (!isNum(ts)) return MISSING;
  const p = dateParts(ts, opts.timeZone);
  const time = opts.seconds === false ? `${p.hour}:${p.minute}` : `${p.hour}:${p.minute}:${p.second}`;
  const base = `${p.year}-${p.month}-${p.day} ${time}`;
  return opts.zone === false ? base : `${base} ${p.timeZoneName}`;
}

/** Time of day only: "14:03:22". */
export function formatTime(ts: Maybe, opts: { timeZone?: string; seconds?: boolean } = {}): string {
  if (!isNum(ts)) return MISSING;
  const p = dateParts(ts, opts.timeZone);
  return opts.seconds === false ? `${p.hour}:${p.minute}` : `${p.hour}:${p.minute}:${p.second}`;
}

/** "Oct 11" style date for axis labels spanning days. */
export function formatShortDate(ts: Maybe, opts: { timeZone?: string } = {}): string {
  if (!isNum(ts)) return MISSING;
  return new Intl.DateTimeFormat("en-US", { timeZone: opts.timeZone, month: "short", day: "numeric" }).format(
    new Date(ts),
  );
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

/** "12 seconds ago", "in 3 minutes", "yesterday". */
export function formatRelative(ts: Maybe, now: number = Date.now()): string {
  if (!isNum(ts)) return MISSING;
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 5000) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(Math.round(diff / 1000), "second");
}

/** Metric units as published in `METRIC_SERIES`. */
export type MetricUnit =
  | "percent"
  | "load"
  | "bytes"
  | "bytes_per_second"
  | "milliseconds"
  | "count_per_second"
  | "milliseconds_per_second"
  | "count";

export function formatMetricValue(unit: string, value: Maybe): string {
  if (!isNum(value)) return MISSING;
  switch (unit as MetricUnit) {
    case "percent":
      return formatPercent(value);
    case "load":
      return value.toFixed(2);
    case "bytes":
      return formatBytes(value);
    case "bytes_per_second":
      return formatBytesPerSecond(value);
    case "milliseconds":
      return formatMilliseconds(value);
    case "count_per_second":
      return formatRate(value);
    case "milliseconds_per_second":
      return `${formatNumber(value, 1)} ms/s`;
    case "count":
      return formatNumber(value, 1);
    default:
      return formatNumber(value, 2);
  }
}

/**
 * Axis tick labels share a single scale so an axis reads "0 / 512 / 1024 MiB" rather than
 * mixing units.
 */
export function formatAxisTicks(unit: string, ticks: number[]): string[] {
  const maxAbs = ticks.filter(Number.isFinite).reduce((m, t) => Math.max(m, Math.abs(t)), 0);
  if (unit === "bytes" || unit === "bytes_per_second") {
    const { index } = iecScale(maxAbs);
    const div = 1024 ** index;
    const suffix = (IEC_UNITS[index] ?? "B") + (unit === "bytes_per_second" ? "/s" : "");
    const decimals = index > 0 && maxAbs / div < 10 ? 1 : 0;
    return ticks.map((t) => `${(t / div).toFixed(decimals)} ${suffix}`);
  }
  if (unit === "percent") return ticks.map((t) => `${formatNumber(t, 1)}%`);
  if (unit === "milliseconds") return ticks.map((t) => `${formatNumber(t, 1)} ms`);
  if (unit === "milliseconds_per_second") return ticks.map((t) => `${formatNumber(t, 1)} ms/s`);
  if (unit === "count_per_second") return ticks.map((t) => `${formatNumber(t, 2)}/s`);
  if (unit === "load") return ticks.map((t) => formatNumber(t, 2));
  return ticks.map((t) => formatNumber(t, 1));
}
