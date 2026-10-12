import { describe, expect, it } from "vitest";
import {
  MAINTAINED_JRE_MAJORS,
  TtlCache,
  javaImage,
  javaMajorForClassFileVersion,
  javaMajorFromTable,
  requiredJavaMajor,
  runtimeMajorFor,
  selectJavaRuntime,
} from "../src/index.js";

describe("TtlCache", () => {
  it("expires entries using the injected clock and evicts the oldest", () => {
    let now = 1000;
    const c = new TtlCache<string, number>({ defaultTtlMs: 100, maxEntries: 2, now: () => now });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    now += 100;
    expect(c.get("b")).toBeUndefined();
    expect(c.size).toBe(1);
  });

  it("deduplicates concurrent loads and does not cache failures", async () => {
    const c = new TtlCache<string, string>();
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return "v";
    };
    const [x, y] = await Promise.all([c.getOrLoad("k", load), c.getOrLoad("k", load)]);
    expect([x, y, calls]).toEqual(["v", "v", 1]);
    await expect(c.getOrLoad("f", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(c.get("f")).toBeUndefined();
    expect(await c.getOrLoad("f", async () => "ok")).toBe("ok");
  });
});

describe("Java mapping", () => {
  it("uses the documented table (pre-1.17, 1.17, 1.18, 1.20.5+, 26.x)", () => {
    expect(javaMajorFromTable("vanilla", "1.12.2")).toBe(8);
    expect(javaMajorFromTable("paper", "1.16.5")).toBe(8);
    expect(javaMajorFromTable("vanilla", "1.17")).toBe(16);
    expect(javaMajorFromTable("vanilla", "1.17.1")).toBe(16);
    expect(javaMajorFromTable("vanilla", "1.18")).toBe(17);
    expect(javaMajorFromTable("vanilla", "1.20.4")).toBe(17);
    expect(javaMajorFromTable("vanilla", "1.20.5")).toBe(21);
    expect(javaMajorFromTable("vanilla", "1.21.11")).toBe(21);
    expect(javaMajorFromTable("vanilla", "26.1")).toBe(25);
    expect(javaMajorFromTable("vanilla", "26.4-snapshot-3")).toBe(25);
    expect(javaMajorFromTable("velocity", "3.5.1")).toBe(21);
    expect(javaMajorFromTable("velocity", "4.2.1-SNAPSHOT")).toBe(25);
    expect(javaMajorFromTable("velocity", "3.1.1")).toBe(11);
  });

  it("prefers metadata and takes the higher of Mojang and upstream", () => {
    expect(requiredJavaMajor({ software: "paper", version: "1.21.11", mojangMajor: 21, upstreamMinimum: 21 })).toMatchObject({ major: 21, source: "upstream" });
    expect(requiredJavaMajor({ software: "paper", version: "1.16.5", mojangMajor: 8, upstreamMinimum: 11 })).toMatchObject({ major: 11, source: "upstream" });
    expect(requiredJavaMajor({ software: "forge", version: "1.20.4", mojangMajor: 17 })).toMatchObject({ major: 17, source: "mojang" });
    expect(requiredJavaMajor({ software: "fabric", version: "26.3" })).toMatchObject({ major: 25, source: "table" });
  });

  it("maps to maintained Temurin JRE images", () => {
    expect(MAINTAINED_JRE_MAJORS).toEqual([8, 11, 17, 21, 25]);
    expect(runtimeMajorFor(16)).toBe(17);
    expect(runtimeMajorFor(8)).toBe(8);
    expect(runtimeMajorFor(22)).toBe(25);
    expect(runtimeMajorFor(27)).toBe(27);
    expect(javaImage(21)).toBe("eclipse-temurin:21-jre");
    expect(() => javaImage(7.5)).toThrow();
  });

  it("validates runtime overrides", () => {
    const tooOld = selectJavaRuntime({ requiredMajor: 21, overrideMajor: 17, software: "paper", minecraftVersion: "1.21.11" });
    expect(tooOld.errors[0]).toMatch(/too old/);
    const legacyForge = selectJavaRuntime({ requiredMajor: 8, overrideMajor: 17, software: "forge", minecraftVersion: "1.12.2" });
    expect(legacyForge.errors).toEqual([]);
    expect(legacyForge.warnings.join(" ")).toMatch(/Java newer than 8/);
    const nonLts = selectJavaRuntime({ requiredMajor: 21, overrideMajor: 24, software: "vanilla", minecraftVersion: "1.21.11" });
    expect(nonLts.warnings.join(" ")).toMatch(/not a maintained LTS/);
    expect(selectJavaRuntime({ requiredMajor: 16, software: "vanilla", minecraftVersion: "1.17" })).toMatchObject({ major: 17, image: "eclipse-temurin:17-jre", errors: [] });
  });

  it("derives Java majors from class file versions", () => {
    expect(javaMajorForClassFileVersion(65)).toBe(21);
    expect(javaMajorForClassFileVersion(69)).toBe(25);
    expect(javaMajorForClassFileVersion(52)).toBe(8);
  });
});
