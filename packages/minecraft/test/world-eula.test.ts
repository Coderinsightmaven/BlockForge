import { describe, expect, it } from "vitest";
import { generateEula, isEulaAccepted, javaDateString, javaStringHashCode, validateLevelName, validateLevelType, validateSeed } from "../src/index.js";
import { fixture } from "./helpers.js";

describe("seeds", () => {
  it("classifies seeds like WorldOptions.parseSeed", () => {
    expect(validateSeed("")).toMatchObject({ ok: true, kind: "random", effectiveSeed: null });
    expect(validateSeed("  ")).toMatchObject({ kind: "random" });
    expect(validateSeed("-4172144997902289642")).toMatchObject({ kind: "numeric", effectiveSeed: "-4172144997902289642" });
    expect(validateSeed(" 42 ")).toMatchObject({ kind: "numeric", effectiveSeed: "42" });
    expect(validateSeed("9223372036854775808")).toMatchObject({ kind: "text", effectiveSeed: String(javaStringHashCode("9223372036854775808")) });
    expect(validateSeed("hello")).toMatchObject({ kind: "text", effectiveSeed: "99162322" });
    expect(validateSeed("bad\nseed").ok).toBe(false);
    expect(validateSeed("x".repeat(65)).ok).toBe(false);
  });

  it("matches Java String.hashCode", () => {
    expect(javaStringHashCode("hello")).toBe(99162322);
    expect(javaStringHashCode("Minecraft")).toBe(-1595926131); // 32-bit overflow path
    expect(javaStringHashCode("")).toBe(0);
  });
});

describe("level types and names", () => {
  it("validates per version", () => {
    expect(validateLevelType("minecraft:large_biomes", "26.3")).toMatchObject({ severity: "ok" });
    expect(validateLevelType("amplified", "1.21.11")).toMatchObject({ severity: "ok", normalized: "minecraft:amplified" });
    expect(validateLevelType("LargeBiomes", "1.20.1")).toMatchObject({ severity: "info", normalized: "minecraft:large_biomes" });
    expect(validateLevelType("minecraft:debug_all_block_states", "26.3").severity).toBe("warning");
    expect(validateLevelType("mypack:skyblock", "26.3").severity).toBe("warning");
    expect(validateLevelType("Not A Type", "26.3").severity).toBe("error");
    expect(validateLevelType("LARGEBIOMES", "1.12.2").severity).toBe("ok");
    expect(validateLevelType("buffet", "1.16.5").severity).toBe("warning");
    expect(validateLevelType("buffet", "1.14.4").severity).toBe("ok");
  });

  it("rejects unsafe world folder names", () => {
    expect(validateLevelName("world")).toBeNull();
    expect(validateLevelName("../etc")).not.toBeNull();
    expect(validateLevelName("a/b")).not.toBeNull();
    expect(validateLevelName("..")).not.toBeNull();
    expect(validateLevelName("w\u0000")).not.toBeNull();
  });
});

describe("eula.txt", () => {
  it("formats dates like java.util.Date#toString in UTC (as the real server does)", () => {
    const real = fixture("properties/vanilla-26.3.eula.txt").split("\n")[1]!;
    expect(real).toBe(`#${javaDateString(new Date("2026-10-12T03:32:36Z"))}`);
  });

  it("generates an accepted EULA with a timestamp comment", () => {
    const text = generateEula(new Date("2026-10-12T03:32:36Z"), { acceptedBy: "admin@example.com\nX" });
    expect(text).toBe(
      [
        "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).",
        "#Mon Oct 12 03:32:36 UTC 2026",
        "#Accepted through BlockForge by admin@example.com_X at 2026-10-12T03:32:36.000Z",
        "eula=true",
        "",
      ].join("\n"),
    );
    expect(isEulaAccepted(text)).toBe(true);
    expect(() => generateEula(new Date("nope"))).toThrow();
  });

  it("reads acceptance like Boolean.parseBoolean", () => {
    expect(isEulaAccepted(fixture("properties/vanilla-26.3.eula.txt"))).toBe(false);
    expect(isEulaAccepted("eula=TRUE")).toBe(true);
    expect(isEulaAccepted("eula=true ")).toBe(false);
    expect(isEulaAccepted("# eula=true")).toBe(false);
  });
});
