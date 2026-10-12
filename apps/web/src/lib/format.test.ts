import { describe, expect, it } from "vitest";
import {
  MISSING,
  formatAxisTicks,
  formatBytes,
  formatBytesPerSecond,
  formatCores,
  formatDuration,
  formatMetricValue,
  formatMillicores,
  formatMilliseconds,
  formatNumber,
  formatPercent,
  formatRate,
  formatRelative,
  formatTime,
  formatTimestamp,
  percentOf,
} from "./format";

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

describe("formatBytes (IEC)", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.00 KiB"],
    [1536, "1.50 KiB"],
    [512 * MiB, "512 MiB"],
    [10.5 * GiB, "10.5 GiB"],
    [3 * 1024 ** 4, "3.00 TiB"],
    [-2 * KiB, "-2.00 KiB"],
  ])("%d → %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it("honours explicit decimals and renders missing values explicitly", () => {
    expect(formatBytes(1.234 * GiB, { decimals: 1 })).toBe("1.2 GiB");
    expect(formatBytes(null)).toBe(MISSING);
    expect(formatBytes(undefined)).toBe(MISSING);
    expect(formatBytes(Number.NaN)).toBe(MISSING);
  });

  it("formats rates", () => {
    expect(formatBytesPerSecond(2 * KiB)).toBe("2.00 KiB/s");
    expect(formatBytesPerSecond(null)).toBe(MISSING);
  });
});

describe("percent helpers", () => {
  it("formats 0–100 values", () => {
    expect(formatPercent(45.234)).toBe("45.2%");
    expect(formatPercent(45.6, 0)).toBe("46%");
    expect(formatPercent(null)).toBe(MISSING);
  });
  it("computes part/total and refuses to divide by zero", () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(1, 0)).toBeNull();
    expect(percentOf(null, 10)).toBeNull();
  });
});

describe("cores", () => {
  it("converts millicores to cores", () => {
    expect(formatMillicores(2500)).toBe("2.5 cores");
    expect(formatMillicores(1000)).toBe("1 core");
    expect(formatMillicores(250)).toBe("0.25 cores");
    expect(formatCores(32)).toBe("32 cores");
    expect(formatMillicores(null)).toBe(MISSING);
  });
});

describe("durations", () => {
  it.each([
    [0, "0 ms"],
    [850, "850 ms"],
    [1000, "1s"],
    [42_000, "42s"],
    [312_000, "5m 12s"],
    [3 * 3_600_000 + 4 * 60_000 + 5000, "3h 4m"],
    [2 * 86_400_000 + 6 * 3_600_000, "2d 6h"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
  it("formats latency-style milliseconds", () => {
    expect(formatMilliseconds(4.567)).toBe("4.57 ms");
    expect(formatMilliseconds(1500)).toBe("1.5 s");
  });
});

describe("timestamps", () => {
  const ts = Date.UTC(2026, 9, 11, 14, 3, 22);
  it("renders absolute time with the time zone", () => {
    expect(formatTimestamp(ts)).toBe("2026-10-11 14:03:22 UTC");
    expect(formatTimestamp(ts, { timeZone: "Europe/Berlin" })).toBe("2026-10-11 16:03:22 GMT+2");
    expect(formatTimestamp(ts, { seconds: false, zone: false })).toBe("2026-10-11 14:03");
    expect(formatTime(ts)).toBe("14:03:22");
    expect(formatTimestamp(null)).toBe(MISSING);
  });
  it("renders relative time", () => {
    const now = ts;
    expect(formatRelative(now - 2000, now)).toBe("just now");
    expect(formatRelative(now - 12_000, now)).toBe("12 seconds ago");
    expect(formatRelative(now + 3 * 60_000, now)).toBe("in 3 minutes");
    expect(formatRelative(now - 2 * 3_600_000, now)).toBe("2 hours ago");
    expect(formatRelative(now - 86_400_000, now)).toBe("yesterday");
    expect(formatRelative(null, now)).toBe(MISSING);
  });
});

describe("numbers, rates and metric units", () => {
  it("formats numbers and event rates", () => {
    expect(formatNumber(1234567.891)).toBe("1,234,567.9");
    expect(formatRate(0.125)).toBe("0.13/s");
  });
  it("is unit-aware", () => {
    expect(formatMetricValue("percent", 12.34)).toBe("12.3%");
    expect(formatMetricValue("bytes", 2 * GiB)).toBe("2.00 GiB");
    expect(formatMetricValue("bytes_per_second", 1024)).toBe("1.00 KiB/s");
    expect(formatMetricValue("load", 1.5)).toBe("1.50");
    expect(formatMetricValue("milliseconds", 3)).toBe("3 ms");
    expect(formatMetricValue("count", 17)).toBe("17");
    expect(formatMetricValue("percent", null)).toBe(MISSING);
  });
  it("uses one scale per axis", () => {
    expect(formatAxisTicks("bytes", [0, 512 * MiB, GiB])).toEqual(["0.0 GiB", "0.5 GiB", "1.0 GiB"]);
    expect(formatAxisTicks("bytes_per_second", [0, 200 * KiB, 400 * KiB])).toEqual([
      "0 KiB/s",
      "200 KiB/s",
      "400 KiB/s",
    ]);
    expect(formatAxisTicks("percent", [0, 50, 100])).toEqual(["0%", "50%", "100%"]);
  });
});
