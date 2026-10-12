import { describe, expect, it } from "vitest";
import {
  alignLines,
  alignResult,
  hasAnyValue,
  lastIndexWithData,
  lineLabel,
  lineStats,
  seriesKey,
} from "./chart-data";

const S = 10_000; // 10 s step
const t = (i: number) => 1_700_000_000_000 + i * S;

describe("alignLines", () => {
  it("keeps explicit nulls as gaps and converts timestamps to seconds", () => {
    const data = alignResult({
      stepMs: S,
      lines: [
        {
          labels: { kind: "used" },
          points: [
            [t(0), 1],
            [t(1), null],
            [t(2), 3],
          ],
        },
      ],
    });
    expect(data.xs).toEqual([t(0) / 1000, t(1) / 1000, t(2) / 1000]);
    expect(data.ys).toEqual([[1, null, 3]]);
    expect(data.series[0]).toMatchObject({ label: "Used", key: "kind=used" });
  });

  it("aligns lines with different timestamps without inventing values (undefined = joined, not a gap)", () => {
    const data = alignLines(
      [
        {
          labels: { direction: "rx" },
          points: [
            [t(0), 1],
            [t(1), 2],
          ],
        },
        { labels: { direction: "tx" }, points: [[t(0) + 5000, 9]] },
      ],
      S,
    );
    expect(data.xs.map((x) => x * 1000)).toEqual([t(0), t(0) + 5000, t(1)]);
    expect(data.ys[0]).toEqual([1, undefined, 2]);
    expect(data.ys[1]).toEqual([undefined, 9, undefined]);
  });

  it("breaks the line when every series skipped samples (server omitted the nulls)", () => {
    const data = alignLines(
      [
        {
          labels: {},
          points: [
            [t(0), 1],
            [t(1), 2],
            [t(5), 6],
          ],
        },
      ],
      S,
    );
    // a null marker is inserted one step after the last sample before the hole
    expect(data.xs.map((x) => x * 1000)).toEqual([t(0), t(1), t(2), t(5)]);
    expect(data.ys[0]).toEqual([1, 2, null, 6]);
  });

  it("breaks only the line that went missing when other lines kept reporting", () => {
    const data = alignLines(
      [
        { labels: { node: "a" }, points: [0, 1, 2, 3, 4].map((i) => [t(i), i] as [number, number]) },
        {
          labels: { node: "b" },
          points: [
            [t(0), 10],
            [t(4), 14],
          ],
        },
      ],
      S,
    );
    expect(data.ys[0]).toEqual([0, 1, 2, 3, 4]);
    expect(data.ys[1]).toEqual([10, null, undefined, undefined, 14]);
  });

  it("treats non-finite values as missing and tolerates unsorted points", () => {
    const data = alignLines(
      [
        {
          labels: {},
          points: [
            [t(1), Number.NaN],
            [t(0), 5],
          ],
        },
      ],
      S,
    );
    expect(data.ys[0]).toEqual([5, null]);
  });

  it("skips gap detection when the step is unknown", () => {
    const data = alignLines(
      [
        {
          labels: {},
          points: [
            [t(0), 1],
            [t(9), 2],
          ],
        },
      ],
      0,
    );
    expect(data.ys[0]).toEqual([1, 2]);
  });

  it("keeps caller-provided labels, keys and colour slots", () => {
    const data = alignLines(
      [{ labels: { kind: "used" }, points: [[t(0), 1]], label: "fra-1", key: "node-a", colorIndex: 3 }],
      S,
    );
    expect(data.series[0]).toEqual({
      key: "node-a",
      label: "fra-1",
      labels: { kind: "used" },
      colorIndex: 3,
    });
  });
});

describe("labels and stats", () => {
  it("builds readable labels", () => {
    expect(lineLabel({ kind: "used" })).toBe("Used");
    expect(lineLabel({ kind: "swap_used" })).toBe("Swap used");
    expect(lineLabel({ core: "3" })).toBe("Core 3");
    expect(lineLabel({ direction: "rx", iface: "eth0" })).toBe("eth0 · rx");
    expect(lineLabel({})).toBe("Value");
    expect(seriesKey({ b: "2", a: "1" })).toBe("a=1,b=2");
  });

  it("computes stats ignoring gaps", () => {
    expect(lineStats([1, null, 3, undefined, 2])).toEqual({ latest: 2, min: 1, max: 3, avg: 2, samples: 3 });
    expect(lineStats([null, undefined])).toEqual({
      latest: null,
      min: null,
      max: null,
      avg: null,
      samples: 0,
    });
  });

  it("detects empty results", () => {
    const empty = alignLines([{ labels: {}, points: [[t(0), null]] }], S);
    expect(hasAnyValue(empty)).toBe(false);
    expect(lastIndexWithData(empty)).toBeNull();
    const some = alignLines(
      [
        {
          labels: {},
          points: [
            [t(0), 1],
            [t(1), null],
          ],
        },
      ],
      S,
    );
    expect(hasAnyValue(some)).toBe(true);
    expect(lastIndexWithData(some)).toBe(0);
  });
});
