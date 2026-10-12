import { describe, expect, it } from "vitest";
import { FILL_BASE, createFillAdapter, getJson, pickDefaultFillBuild } from "../src/index.js";
import { z } from "zod";
import { ctxFor, fixture, mojangRoutes } from "./helpers.js";

type VersionEntry = { version: { id: string } };

/** Single-version responses have the same shape as entries of /versions (verified live). */
function versionRoutes(project: string, file: string): Record<string, string> {
  const doc = JSON.parse(fixture(file)) as { versions: VersionEntry[] };
  const routes: Record<string, string> = { [`${FILL_BASE}/${project}/versions`]: fixture(file) };
  for (const v of doc.versions) routes[`${FILL_BASE}/${project}/versions/${encodeURIComponent(v.version.id)}`] = JSON.stringify(v);
  return routes;
}

function paperRoutes(): Record<string, string> {
  const builds = JSON.parse(fixture("fill/paper-1.21.11-builds.json")) as Array<{ id: number }>;
  const routes: Record<string, string> = {
    ...mojangRoutes(),
    ...versionRoutes("paper", "fill/paper-versions.json"),
    [`${FILL_BASE}/paper/versions/1.21.11`]: fixture("fill/paper-version-1.21.11.json"),
    [`${FILL_BASE}/paper/versions/1.21.11/builds`]: fixture("fill/paper-1.21.11-builds.json"),
  };
  for (const b of builds) routes[`${FILL_BASE}/paper/versions/1.21.11/builds/${b.id}`] = JSON.stringify(b);
  return routes;
}

describe("Paper via Fill API v3 (fixtures captured 2026-10-11)", () => {
  const paper = createFillAdapter("paper");

  it("lists versions newest first with support status and Java minimum", async () => {
    const v = await paper.listVersions(ctxFor(paperRoutes()));
    expect(v.map((x) => x.minecraftVersion)).toEqual(["26.3", "26.3-rc-3", "26.2", "1.21.11", "1.21.11-rc3", "1.20.4", "1.17.1", "1.16.5", "1.7.10"]);
    expect(v[0]).toMatchObject({ channel: "release", javaMajor: 25, javaSource: "upstream", support: "supported" });
    expect(v[1]).toMatchObject({ channel: "snapshot", support: "unsupported" });
    expect(v.find((x) => x.minecraftVersion === "1.7.10")?.javaMajor).toBe(6);
  });

  it("maps builds, channels and SHA-256 checksums", async () => {
    const builds = await paper.listBuilds(ctxFor(paperRoutes()), "1.21.11");
    expect(builds[0]).toMatchObject({
      build: "132",
      channel: "stable",
      downloadUrl: "https://fill-data.papermc.io/v1/objects/5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba/paper-1.21.11-132.jar",
      checksum: { algorithm: "sha256", value: "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba" },
    });
    const channels = new Set(builds.map((b) => b.channel));
    expect(channels).toEqual(new Set(["stable", "beta", "alpha"]));
    expect(builds.map((b) => Number(b.build))).toEqual([...builds.map((b) => Number(b.build))].sort((a, b) => b - a));
  });

  it("resolves the newest stable build by default", async () => {
    const a = await paper.resolve(ctxFor(paperRoutes()), "1.21.11", null);
    expect(a).toMatchObject({ software: "paper", build: "132", channel: "stable", requiresNetworkAtFirstStart: true });
    expect(a.java).toMatchObject({ major: 21 });
    expect(a.launch).toEqual({ kind: "jar", jar: "server.jar", programArgs: ["--nogui"] });
    expect(a.downloads[0]!.agentChecksum).toEqual({ algorithm: "sha256", value: "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba" });
    expect(a.recommendedJvmFlags).toContain("-XX:G1HeapRegionSize=8M");
    expect(a.notes.join(" ")).toMatch(/unsupported/);
  });

  it("resolves an explicit alpha build", async () => {
    const a = await paper.resolve(ctxFor(paperRoutes()), "1.21.11", "34");
    expect(a).toMatchObject({ build: "34", channel: "alpha" });
    await expect(paper.resolve(ctxFor(paperRoutes()), "1.21.11", "abc")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(paper.resolve(ctxFor(paperRoutes()), "../../x", null)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("treats the sunset v2 API as an upstream error", async () => {
    const ctx = ctxFor({ "https://api.papermc.io/v2/projects/paper": { status: 410, body: fixture("fill/v2-sunset.json") } });
    await expect(getJson(ctx, "https://api.papermc.io/v2/projects/paper", z.unknown())).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 410 });
  });
});

describe("Folia via Fill API v3", () => {
  const folia = createFillAdapter("folia");
  const routes = () => ({
    ...mojangRoutes(),
    ...versionRoutes("folia", "fill/folia-versions.json"),
    [`${FILL_BASE}/folia/versions/26.2/builds`]: fixture("fill/folia-26.2-builds.json"),
  });

  it("falls back to the newest beta build with a note when no stable build exists", async () => {
    const a = await folia.resolve(ctxFor(routes()), "26.2", null);
    expect(a).toMatchObject({ software: "folia", build: "7", channel: "beta" });
    expect(a.notes.join(" ")).toMatch(/No stable build/);
    expect(a.java.major).toBe(25);
  });

  it("documents plugin incompatibility", () => {
    expect(folia.info.restrictions.join(" ")).toMatch(/folia-supported: true/);
  });
});

describe("Velocity via Fill API v3", () => {
  const velocity = createFillAdapter("velocity");
  const routes = () => ({
    ...versionRoutes("velocity", "fill/velocity-versions.json"),
    [`${FILL_BASE}/velocity/versions/4.2.0/builds`]: fixture("fill/velocity-4.2.0-builds.json"),
    [`${FILL_BASE}/velocity/versions/3.5.1/builds`]: fixture("fill/velocity-3.5.1-builds.json"),
    [`${FILL_BASE}/velocity/versions/4.2.1-SNAPSHOT/builds`]: fixture("fill/velocity-4.2.1-SNAPSHOT-builds.json"),
  });

  it("lists Velocity versions (semver order, SNAPSHOT channel, empty versions hidden)", async () => {
    const v = await velocity.listVersions(ctxFor(routes()));
    const ids = v.map((x) => x.minecraftVersion);
    expect(ids.slice(0, 3)).toEqual(["4.2.1-SNAPSHOT", "4.2.0", "4.1.2-SNAPSHOT"]);
    expect(ids).not.toContain("3.5.0");
    expect(v.find((x) => x.minecraftVersion === "4.2.1-SNAPSHOT")?.channel).toBe("snapshot");
    expect(v.find((x) => x.minecraftVersion === "3.5.1")).toMatchObject({ channel: "release", support: "deprecated", javaMajor: 21 });
    expect(velocity.info.kind).toBe("proxy");
  });

  it("resolves a release without consulting Mojang and launches velocity.jar", async () => {
    const ctx = ctxFor(routes());
    const a = await velocity.resolve(ctx, "4.2.0", null);
    expect(a).toMatchObject({ build: "30", channel: "stable", requiresNetworkAtFirstStart: false });
    expect(a.java).toMatchObject({ major: 25, source: "upstream" });
    expect(a.launch).toEqual({ kind: "jar", jar: "velocity.jar", programArgs: [] });
    expect(ctx.calls.some((u) => u.includes("mojang"))).toBe(false);
    const rec = await velocity.resolve(ctxFor(routes()), "3.5.1", null);
    expect(rec.channel).toBe("stable"); // RECOMMENDED → stable
  });

  it("picks stable builds over newer betas", () => {
    const builds = JSON.parse(fixture("fill/velocity-4.2.1-SNAPSHOT-builds.json"));
    const pick = pickDefaultFillBuild(builds);
    expect(pick?.build.id).toBe(38);
    expect(pick?.note).toBeNull();
    const betasOnly = builds.filter((b: { channel: string }) => b.channel === "BETA");
    expect(pickDefaultFillBuild(betasOnly)?.note).toMatch(/beta build #41/);
    expect(pickDefaultFillBuild([])).toBeNull();
  });
});
