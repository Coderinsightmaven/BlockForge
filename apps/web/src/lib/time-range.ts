import { TIME_RANGE_PRESETS } from "@blockforge/contracts";
import type { TimeRangePreset } from "@blockforge/contracts";

export type TimeRange =
  { kind: "relative"; preset: TimeRangePreset } | { kind: "absolute"; from: number; to: number };

export const PRESET_ORDER: TimeRangePreset[] = ["5m", "15m", "1h", "6h", "24h", "7d"];

export const PRESET_LABELS: Record<TimeRangePreset, string> = {
  "5m": "Last 5 minutes",
  "15m": "Last 15 minutes",
  "1h": "Last hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
};

/** Auto-refresh cadence for relative ranges (absolute ranges never refresh). */
export const PRESET_REFRESH_MS: Record<TimeRangePreset, number> = {
  "5m": 10_000,
  "15m": 15_000,
  "1h": 30_000,
  "6h": 60_000,
  "24h": 120_000,
  "7d": 600_000,
};

export const DEFAULT_TIME_RANGE: TimeRange = { kind: "relative", preset: "1h" };

/** Longest custom range accepted by the picker (VictoriaMetrics retention bounds it anyway). */
export const MAX_CUSTOM_RANGE_MS = 90 * 24 * 60 * 60_000;

export function resolveTimeRange(range: TimeRange, now: number = Date.now()): { from: number; to: number } {
  if (range.kind === "relative") return { from: now - TIME_RANGE_PRESETS[range.preset], to: now };
  return { from: range.from, to: range.to };
}

export function refreshIntervalFor(range: TimeRange): number | false {
  return range.kind === "relative" ? PRESET_REFRESH_MS[range.preset] : false;
}

export function timeRangeKey(range: TimeRange): string {
  return range.kind === "relative" ? range.preset : `${range.from}-${range.to}`;
}

/** URL form: "1h" or "abs:<from>:<to>". */
export function serializeTimeRange(range: TimeRange): string {
  return range.kind === "relative" ? range.preset : `abs:${range.from}:${range.to}`;
}

export function parseTimeRange(value: unknown, fallback: TimeRange = DEFAULT_TIME_RANGE): TimeRange {
  if (typeof value !== "string") return fallback;
  if (Object.hasOwn(TIME_RANGE_PRESETS, value)) return { kind: "relative", preset: value as TimeRangePreset };
  const m = /^abs:(\d{1,15}):(\d{1,15})$/.exec(value);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (validateCustomRange(from, to) === null) return { kind: "absolute", from, to };
  }
  return fallback;
}

/** Returns an error message, or null when the custom range is acceptable. */
export function validateCustomRange(from: number, to: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "Enter both a start and an end time.";
  if (from >= to) return "The start must be before the end.";
  if (to - from < 60_000) return "Choose a range of at least one minute.";
  if (to - from > MAX_CUSTOM_RANGE_MS) return "Choose a range of 90 days or less.";
  if (from > now) return "The start is in the future.";
  return null;
}

export function describeTimeRange(range: TimeRange): string {
  return range.kind === "relative" ? PRESET_LABELS[range.preset] : "Custom range";
}
