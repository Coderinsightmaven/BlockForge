import { describe, expect, it } from "vitest";
import {
  compareBaseVersions,
  compareMinecraftVersions,
  compareSemverLike,
  isAtLeast,
  isReleaseVersion,
  parseMinecraftVersion,
  sortVersionsDesc,
} from "../src/index.js";

describe("parseMinecraftVersion", () => {
  it("parses legacy, year-based and pre-release ids", () => {
    expect(parseMinecraftVersion("1.21.11")).toMatchObject({ kind: "release-like", major: 1, minor: 21, patch: 11, stage: "release" });
    expect(parseMinecraftVersion("1.21")).toMatchObject({ major: 1, minor: 21, patch: 0, stage: "release" });
    expect(parseMinecraftVersion("26.3")).toMatchObject({ major: 26, minor: 3, patch: 0, stage: "release" });
    expect(parseMinecraftVersion("26.1.2")).toMatchObject({ major: 26, minor: 1, patch: 2 });
    expect(parseMinecraftVersion("26.3-rc-3")).toMatchObject({ stage: "rc", stageNumber: 3 });
    expect(parseMinecraftVersion("26.4-snapshot-3")).toMatchObject({ major: 26, minor: 4, stage: "snapshot", stageNumber: 3 });
    expect(parseMinecraftVersion("1.21.11-pre5")).toMatchObject({ stage: "pre", stageNumber: 5 });
    expect(parseMinecraftVersion("1.21.11-rc3")).toMatchObject({ stage: "rc", stageNumber: 3 });
    expect(parseMinecraftVersion("1.14 Pre-Release 5")).toMatchObject({ minor: 14, stage: "pre", stageNumber: 5 });
    expect(parseMinecraftVersion("25w14a").kind).toBe("weekly-snapshot");
    expect(parseMinecraftVersion("b1.7.3").kind).toBe("other");
    expect(parseMinecraftVersion("rd-132211").kind).toBe("other");
  });
});

describe("ordering", () => {
  it("orders year-based versions after 1.x and stages before releases", () => {
    const sorted = sortVersionsDesc(
      ["1.21.11", "26.3", "26.3-rc-3", "1.21.11-rc3", "1.21.11-pre5", "26.1.2", "26.1", "1.8.8", "26.4-snapshot-3", "1.21", "b1.7.3"],
      (v) => v,
    );
    expect(sorted).toEqual(["26.4-snapshot-3", "26.3", "26.3-rc-3", "26.1.2", "26.1", "1.21.11", "1.21.11-rc3", "1.21.11-pre5", "1.21", "1.8.8", "b1.7.3"]);
  });

  it("compares bases and answers isAtLeast", () => {
    expect(compareBaseVersions("1.21.9", "1.21.10")).toBe(-1);
    expect(compareBaseVersions("26.1", "1.21.11")).toBe(1);
    expect(compareBaseVersions("25w14a", "1.21")).toBeNull();
    expect(isAtLeast("1.21.9-pre1", "1.21.9")).toBe(true);
    expect(isAtLeast("1.21.8", "1.21.9")).toBe(false);
    expect(isAtLeast("26.3", "1.21.9")).toBe(true);
    expect(isAtLeast("rd-132211", "1.0")).toBeNull();
    expect(compareMinecraftVersions("1.20.5", "1.20.5")).toBe(0);
    expect(isReleaseVersion("26.3")).toBe(true);
    expect(isReleaseVersion("26.3-rc-3")).toBe(false);
  });

  it("orders Velocity versions with SNAPSHOT below the release", () => {
    const v = ["3.5.1", "4.2.1-SNAPSHOT", "4.2.0", "3.10.0", "4.2.1", "1.1.9"];
    expect([...v].sort((a, b) => compareSemverLike(b, a))).toEqual(["4.2.1", "4.2.1-SNAPSHOT", "4.2.0", "3.10.0", "3.5.1", "1.1.9"]);
  });
});
