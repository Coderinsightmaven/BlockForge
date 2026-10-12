import { describe, expect, it } from "vitest";
import { CatalogError, MOJANG_MANIFEST_URL, TtlCache, buildLaunchSpec, createVanillaAdapter, getMojangVersion } from "../src/index.js";
import { ctxFor, fixture, mojangRoutes } from "./helpers.js";

const vanilla = createVanillaAdapter();

describe("vanilla adapter (Mojang piston-meta, fixtures captured 2026-10-11)", () => {
  it("lists versions newest first and hides versions without a server download", async () => {
    const ctx = ctxFor(mojangRoutes());
    const versions = await vanilla.listVersions(ctx);
    const ids = versions.map((v) => v.minecraftVersion);
    expect(ids[0]).toBe("26.4-snapshot-3");
    expect(ids).toContain("26.3");
    expect(ids).toContain("1.2.5");
    expect(ids).not.toContain("1.1");
    expect(ids).not.toContain("b1.7.3");
    expect(ids).not.toContain("rd-132211");
    expect(versions.find((v) => v.minecraftVersion === "26.3")).toMatchObject({ channel: "release", javaMajor: 25, javaSource: "table" });
    expect(versions.find((v) => v.minecraftVersion === "26.3-rc-3")?.channel).toBe("snapshot");
  });

  it("resolves 26.3 with SHA-1, Java 25 and a plain jar launch", async () => {
    const ctx = ctxFor(mojangRoutes());
    const a = await vanilla.resolve(ctx, "26.3", null);
    expect(a.downloads).toEqual([
      expect.objectContaining({
        role: "server",
        url: "https://piston-data.mojang.com/v1/objects/33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c/server.jar",
        destPath: "server.jar",
        checksum: { algorithm: "sha1", value: "33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c" },
        agentChecksum: { algorithm: "sha1", value: "33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c" },
        sizeBytes: 62294556,
      }),
    ]);
    expect(a.java).toMatchObject({ major: 25, source: "mojang" });
    expect(a.launch).toEqual({ kind: "jar", jar: "server.jar", programArgs: ["nogui"] });
    expect(a.install.kind).toBe("none");
    expect(a.channel).toBe("stable");
  });

  it.each([
    ["1.12.2", 8],
    ["1.16.5", 8],
    ["1.17", 16],
    ["1.18", 17],
    ["1.20.4", 17],
    ["1.20.5", 21],
    ["1.21.11", 21],
    ["26.1", 25],
  ])("uses Mojang javaVersion for %s → Java %i", async (id, major) => {
    const a = await vanilla.resolve(ctxFor(mojangRoutes()), id, null);
    expect(a.java.major).toBe(major);
    expect(a.java.source).toBe("mojang");
  });

  it("maps Java 16 (1.17) to the maintained Java 17 image", async () => {
    const a = await vanilla.resolve(ctxFor(mojangRoutes()), "1.17", null);
    const spec = buildLaunchSpec({ software: "vanilla", artifact: a, memoryLimitBytes: 2 * 1024 ** 3, jvmPreset: "default" });
    expect(spec.image).toBe("eclipse-temurin:17-jre");
  });

  it("falls back to the table when javaVersion is missing (1.6.1)", async () => {
    const a = await vanilla.resolve(ctxFor(mojangRoutes()), "1.6.1", null);
    expect(a.java).toMatchObject({ major: 8, source: "table" });
    expect(a.downloads[0]!.url).toMatch(/^https:\/\/launcher\.mojang\.com\//);
  });

  it("reports versions without a server download as unavailable", async () => {
    for (const id of ["1.1", "b1.7.3", "rd-132211"]) {
      await expect(vanilla.resolve(ctxFor(mojangRoutes()), id, null)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(await vanilla.listBuilds(ctxFor(mojangRoutes()), id)).toEqual([]);
    }
  });

  it("marks snapshots as experimental builds", async () => {
    const builds = await vanilla.listBuilds(ctxFor(mojangRoutes()), "26.4-snapshot-3");
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ build: "26.4-snapshot-3", channel: "experimental", checksum: { algorithm: "sha1" } });
  });

  it("verifies the per-version JSON against the manifest SHA-1", async () => {
    const routes = mojangRoutes();
    const url = Object.keys(routes).find((u) => u.endsWith("/26.3.json"))!;
    routes[url] = routes[url]!.replace("33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c", "0000000000000000000000000000000000000000");
    await expect(getMojangVersion(ctxFor(routes), "26.3")).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });

  it("rejects unknown versions and builds", async () => {
    await expect(vanilla.resolve(ctxFor(mojangRoutes()), "9.9.9", null)).rejects.toBeInstanceOf(CatalogError);
    await expect(vanilla.resolve(ctxFor(mojangRoutes()), "26.3", "26.2")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("caches upstream responses when a cache is supplied", async () => {
    const ctx = { ...ctxFor(mojangRoutes()), cache: new TtlCache<string, string>() };
    await vanilla.resolve(ctx, "26.3", null);
    await vanilla.resolve(ctx, "26.3", null);
    expect(ctx.calls.filter((u) => u === MOJANG_MANIFEST_URL)).toHaveLength(1);
  });

  it("surfaces upstream HTTP errors", async () => {
    const ctx = ctxFor({ [MOJANG_MANIFEST_URL]: { status: 503 } });
    await expect(vanilla.listVersions(ctx)).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 503 });
    const bad = ctxFor({ [MOJANG_MANIFEST_URL]: '{"latest":{}}' });
    await expect(vanilla.listVersions(bad)).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    expect(fixture("mojang/version_manifest_v2.json")).toContain('"release": "26.3"');
  });
});
