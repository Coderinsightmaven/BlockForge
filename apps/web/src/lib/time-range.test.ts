import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_RANGE,
  PRESET_ORDER,
  parseTimeRange,
  refreshIntervalFor,
  resolveTimeRange,
  serializeTimeRange,
  timeRangeKey,
  validateCustomRange,
} from "./time-range";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

describe("time ranges", () => {
  it("offers the six presets from the spec", () => {
    expect(PRESET_ORDER).toEqual(["5m", "15m", "1h", "6h", "24h", "7d"]);
  });

  it("resolves relative ranges against now and absolute ranges as-is", () => {
    expect(resolveTimeRange({ kind: "relative", preset: "15m" }, NOW)).toEqual({
      from: NOW - 15 * 60_000,
      to: NOW,
    });
    expect(resolveTimeRange({ kind: "absolute", from: 1, to: 2 }, NOW)).toEqual({ from: 1, to: 2 });
  });

  it("auto-refreshes relative ranges only", () => {
    expect(refreshIntervalFor({ kind: "relative", preset: "5m" })).toBe(10_000);
    expect(refreshIntervalFor({ kind: "absolute", from: 1, to: 2 })).toBe(false);
  });

  it("round-trips through the URL and rejects junk", () => {
    const abs = { kind: "absolute" as const, from: NOW - 3_600_000, to: NOW - 60_000 };
    expect(parseTimeRange(serializeTimeRange(abs))).toEqual(abs);
    expect(parseTimeRange("24h")).toEqual({ kind: "relative", preset: "24h" });
    expect(parseTimeRange("toString")).toEqual(DEFAULT_TIME_RANGE);
    expect(parseTimeRange("abs:5:1")).toEqual(DEFAULT_TIME_RANGE);
    expect(parseTimeRange(undefined)).toEqual(DEFAULT_TIME_RANGE);
    expect(timeRangeKey(abs)).toBe(`${abs.from}-${abs.to}`);
  });

  it("validates custom ranges", () => {
    expect(validateCustomRange(NOW - 3_600_000, NOW, NOW)).toBeNull();
    expect(validateCustomRange(NOW, NOW - 1, NOW)).toMatch(/before/);
    expect(validateCustomRange(NOW - 1000, NOW, NOW)).toMatch(/one minute/);
    expect(validateCustomRange(NOW - 91 * 86_400_000, NOW, NOW)).toMatch(/90 days/);
    expect(validateCustomRange(NOW + 60_000, NOW + 3_600_000, NOW)).toMatch(/future/);
    expect(validateCustomRange(Number.NaN, NOW, NOW)).toMatch(/both/);
  });
});
