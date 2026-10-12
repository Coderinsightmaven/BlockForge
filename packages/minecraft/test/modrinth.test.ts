import { AGENT_COMMANDS } from "@blockforge/contracts";
import { describe, expect, it } from "vitest";
import {
  CatalogError,
  ModrinthClient,
  buildModrinthSearchFacets,
  checkModrinthUpdates,
  getModrinthProject,
  identifyModrinthFiles,
  isClientOnly,
  isSafeJarFilename,
  listCompatibleVersions,
  modrinthFetchPayload,
  modrinthLoaderProfile,
  modrinthUserAgent,
  parseRateLimit,
  pickModrinthVersion,
  planModrinthInstall,
  primaryJarFile,
  searchModrinth,
  type Fetch,
  type ModrinthVersionRaw,
} from "../src/index.js";
import { fixture, modrinthFetch } from "./helpers.js";

const UA = modrinthUserAgent("0.1.0", "admin@example.com");
const scenarios = JSON.parse(fixture("modrinth/scenarios.json")) as {
  luckpermsNewest: { versionId: string; versionNumber: string; primaryFile: { filename: string; sha1: string; sha512: string } };
  luckpermsOlder: { versionId: string; projectId: string; versionNumber: string; primaryFile: { filename: string; sha1: string; sha512: string } };
  installed: Array<{ path: string; sha512: string }>;
};

function recorded() {
  const m = modrinthFetch();
  return { client: new ModrinthClient({ fetch: m.fetch, userAgent: UA }), ...m };
}

const cdn = (url: string) => new URL(url).hostname;

describe("Modrinth: user agent and loader mapping", () => {
  it("builds the BlockForge/<version> (<contact>) user agent and sends it on every request", async () => {
    expect(UA).toBe("BlockForge/0.1.0 (admin@example.com)");
    expect(() => modrinthUserAgent("0.1.0", "evil)\r\nx: y")).toThrow(CatalogError);
    expect(() => modrinthUserAgent("0.1 beta", "a@b.c")).toThrow(CatalogError);
    expect(() => new ModrinthClient({ fetch: globalThis.fetch, userAgent: "" })).toThrow(CatalogError);
    expect(() => new ModrinthClient({ fetch: globalThis.fetch, userAgent: "BlockForge\r\nx: y" })).toThrow(CatalogError);
    const { client, calls } = recorded();
    await getModrinthProject(client, "luckperms");
    expect(calls[0]!.headers.get("user-agent")).toBe(UA);
  });

  it("maps BlockForge software to Modrinth loaders", () => {
    expect(modrinthLoaderProfile("vanilla")).toBeNull();
    expect(modrinthLoaderProfile("paper")).toMatchObject({ projectType: "plugin", loaders: ["paper", "spigot", "bukkit"], installDir: "plugins" });
    expect(modrinthLoaderProfile("purpur")!.loaders).toEqual(["purpur", "paper", "spigot", "bukkit"]);
    expect(modrinthLoaderProfile("folia")!.loaders).toEqual(["folia"]);
    expect(modrinthLoaderProfile("spigot")!.loaders).toEqual(["spigot", "bukkit"]);
    expect(modrinthLoaderProfile("velocity")).toMatchObject({ loaders: ["velocity"], filterGameVersion: false });
    expect(modrinthLoaderProfile("fabric")).toMatchObject({ projectType: "mod", loaders: ["fabric"], loadersWithWarning: ["quilt"], installDir: "mods" });
    expect(modrinthLoaderProfile("forge")!.loaders).toEqual(["forge"]);
    expect(modrinthLoaderProfile("neoforge")!.loaders).toEqual(["neoforge"]);
  });

  it("classifies client-only projects and versions", () => {
    expect(isClientOnly({ serverSide: "unsupported" })).toBe(true);
    expect(isClientOnly({ environment: "client_only" })).toBe(true);
    expect(isClientOnly({ environment: ["client_only"] })).toBe(true);
    expect(isClientOnly({ serverSide: "optional", environment: ["client_or_server"] })).toBe(false);
    expect(isClientOnly({ serverSide: "required", environment: "unknown" })).toBe(false);
  });
});

describe("Modrinth: search", () => {
  it("builds server-compatible facets per software", () => {
    expect(buildModrinthSearchFacets({ software: "paper", minecraftVersion: "1.21.11" })).toEqual([
      ["project_type:plugin"],
      ["categories:paper", "categories:spigot", "categories:bukkit"],
      ["versions:1.21.11"],
      ["server_side!=unsupported"],
    ]);
    expect(buildModrinthSearchFacets({ software: "fabric", minecraftVersion: "1.21.1", categories: ["optimization"] })).toEqual([
      ["project_type:mod"],
      ["categories:fabric", "categories:quilt"],
      ["versions:1.21.1"],
      ["server_side!=unsupported"],
      ["categories:optimization"],
    ]);
    expect(buildModrinthSearchFacets({ software: "velocity", minecraftVersion: "3.4.0" })).toEqual([
      ["project_type:plugin"],
      ["categories:velocity"],
      ["server_side!=unsupported"],
    ]);
    expect(() => buildModrinthSearchFacets({ software: "vanilla" })).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    expect(() => buildModrinthSearchFacets({ software: "paper", categories: ['x"],["y'] })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => buildModrinthSearchFacets({ software: "paper", minecraftVersion: '1.21"]' })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("searches Paper plugins (recorded 2026-10-12)", async () => {
    const { client, misses } = recorded();
    const res = await searchModrinth(client, { software: "paper", minecraftVersion: "1.21.11", query: "luckperms", limit: 5 });
    expect(misses).toEqual([]);
    expect(res.totalHits).toBeGreaterThan(0);
    const lp = res.hits.find((h) => h.slug === "luckperms")!;
    expect(lp).toMatchObject({ projectId: "Vebnzrzj", title: "LuckPerms", serverSide: "required", clientOnly: false, loaderMatch: "match" });
    expect(lp.loaders).toEqual(expect.arrayContaining(["paper", "velocity"]));
    expect(lp.categories).not.toContain("paper");
    expect(lp.projectTypes).toContain("plugin");
    if (lp.iconUrl) expect(cdn(lp.iconUrl)).toBe("cdn.modrinth.com");
    for (const h of res.hits) expect(h.serverSide).not.toBe("unsupported");
    expect(client.rateLimit).toMatchObject({ limit: 300, backoffMs: 0 });
  });

  it("searches Fabric, Velocity and Folia (recorded)", async () => {
    const { client, misses } = recorded();
    const fabric = await searchModrinth(client, { software: "fabric", minecraftVersion: "1.21.1", sort: "downloads", limit: 5 });
    expect(fabric.hits.length).toBe(5);
    for (const h of fabric.hits) expect(h.loaders.some((l) => l === "fabric" || l === "quilt")).toBe(true);
    const velocity = await searchModrinth(client, { software: "velocity", sort: "downloads", limit: 5 });
    for (const h of velocity.hits) expect(h.loaders).toContain("velocity");
    const folia = await searchModrinth(client, { software: "folia", minecraftVersion: "1.21.11", sort: "downloads", limit: 5 });
    for (const h of folia.hits) expect(h.loaders).toContain("folia");
    expect(misses).toEqual([]);
  });

  it("validates search input", async () => {
    const { client, calls } = recorded();
    await expect(searchModrinth(client, { software: "paper", query: "a\nb" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(searchModrinth(client, { software: "paper", query: "x".repeat(257) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(searchModrinth(client, { software: "paper", limit: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(searchModrinth(client, { software: "paper", offset: -1 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(searchModrinth(client, { software: "paper", sort: "x" as "newest" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toEqual([]);
  });
});

describe("Modrinth: projects and versions", () => {
  it("maps project details", async () => {
    const { client } = recorded();
    const p = await getModrinthProject(client, "luckperms", "paper");
    expect(p).toMatchObject({ projectId: "Vebnzrzj", slug: "luckperms", serverSide: "required", clientSide: "unsupported", clientOnly: false, compatible: true, status: "approved" });
    expect(p.pageUrl).toBe("https://modrinth.com/project/luckperms");
    expect(p.license?.id).toBe("MIT");
    for (const link of [p.sourceUrl, p.issuesUrl, p.wikiUrl, p.license?.url]) if (link) expect(link.startsWith("https://")).toBe(true);
  });

  it("lists compatible versions newest first with primary file hashes", async () => {
    const { client } = recorded();
    const versions = await listCompatibleVersions(client, "luckperms", { software: "paper", minecraftVersion: "1.21.11" });
    expect(versions.length).toBeGreaterThan(1);
    expect(versions[0]!.versionNumber).toBe(scenarios.luckpermsNewest.versionNumber);
    for (const v of versions) {
      expect(v.gameVersions).toContain("1.21.11");
      expect(v.loaderMatch).toBe("match");
      expect(v.primaryFile?.sha512).toMatch(/^[a-f0-9]{128}$/);
    }
    const dates = versions.map((v) => Date.parse(v.datePublished));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it("prefers releases over newer betas, and full loader matches over Quilt-only builds", () => {
    const we = JSON.parse(fixture("modrinth/09-get-project-1u6JkXh5-version-q.json")) as ModrinthVersionRaw[];
    expect(we[0]!.version_type).toBe("beta"); // newest WorldEdit build for 1.21.11 is a beta
    const paper = modrinthLoaderProfile("paper")!;
    const picked = pickModrinthVersion(we, paper, "1.21.11")!;
    expect(picked.version_type).toBe("release");
    expect(picked.version_number).toBe("7.4.5");
    expect(pickModrinthVersion(we, paper, "1.21.11", { allowPrerelease: false })!.version_number).toBe("7.4.5");
    expect(pickModrinthVersion(we, paper, "0.0.1")).toBeNull();
    expect(pickModrinthVersion(we, modrinthLoaderProfile("fabric")!, "1.21.11")).toBeNull();

    const fabric = modrinthLoaderProfile("fabric")!;
    const base = JSON.parse(fixture("modrinth/13-get-project-P7dR8mSH-version-q.json")) as ModrinthVersionRaw[];
    const quiltOnlyNewer = { ...base[0]!, id: "QuiltOnly", loaders: ["quilt"], date_published: "2099-01-01T00:00:00Z" };
    expect(pickModrinthVersion([quiltOnlyNewer, ...base], fabric, "1.21.1")!.id).toBe(base[0]!.id);
    expect(pickModrinthVersion([quiltOnlyNewer], fabric, "1.21.1")!.id).toBe("QuiltOnly");
    const unlisted = { ...base[0]!, status: "unlisted" };
    expect(pickModrinthVersion([unlisted], fabric, "1.21.1")).toBeNull();
  });

  it("validates file names, hosts and sizes", () => {
    const v = (JSON.parse(fixture("modrinth/09-get-project-1u6JkXh5-version-q.json")) as ModrinthVersionRaw[])[0]!;
    const hosts = ["cdn.modrinth.com"];
    expect("file" in primaryJarFile(v, hosts)).toBe(true);
    const file = v.files[0]!;
    expect(primaryJarFile({ ...v, files: [{ ...file, url: "https://evil.example/x.jar" }] }, hosts)).toEqual({ problem: "URL_NOT_ALLOWED" });
    expect(primaryJarFile({ ...v, files: [{ ...file, url: "http://cdn.modrinth.com/x.jar" }] }, hosts)).toEqual({ problem: "URL_NOT_ALLOWED" });
    expect(primaryJarFile({ ...v, files: [{ ...file, filename: "../../server.jar" }] }, hosts)).toEqual({ problem: "UNSAFE_FILENAME" });
    expect(primaryJarFile({ ...v, files: [{ ...file, filename: "pack.zip" }] }, hosts)).toEqual({ problem: "NO_JAR" });
    expect(primaryJarFile({ ...v, files: [{ ...file, size: 3 * 1024 ** 3 }] }, hosts)).toEqual({ problem: "TOO_LARGE" });
    for (const bad of ["a\\b.jar", "a/b.jar", ".hidden.jar", "x.jar ", "con:x.jar", "a\u0000.jar", "evil\u202eraj.jar", "a\u2028b.jar", "x.JAR.exe", ".jar"]) {
      expect(isSafeJarFilename(bad)).toBe(false);
    }
    expect(isSafeJarFilename("LuckPerms-Bukkit-5.5.71.jar")).toBe(true);
    expect(isSafeJarFilename("fabric-api-0.116.17+1.21.1.jar")).toBe(true);
  });
});

describe("Modrinth: install plans (recorded)", () => {
  const fetchSchema = AGENT_COMMANDS["artifact.fetch"].payload;

  it("Paper: WorldGuard pulls in WorldEdit first; files are agent-ready", async () => {
    const { client, misses } = recorded();
    const plan = await planModrinthInstall(client, { software: "paper", minecraftVersion: "1.21.11", project: "worldguard" });
    expect(misses).toEqual([]);
    expect(plan.installable).toBe(true);
    expect(plan.root).toMatchObject({ slug: "worldguard", versionNumber: "7.0.17" });
    expect(plan.files.map((f) => [f.projectSlug, f.reason, f.versionNumber])).toEqual([
      ["worldedit", "dependency", "7.4.5"],
      ["worldguard", "requested", "7.0.17"],
    ]);
    expect(plan.files[0]!.requiredBy).toEqual([plan.root.projectId]);
    for (const f of plan.files) {
      expect(f.destPath).toBe(`plugins/${f.filename}`);
      expect(cdn(f.url)).toBe("cdn.modrinth.com");
      expect(f.checksum).toEqual({ algorithm: "sha512", value: f.sha512 });
      expect(f.action).toBe("install");
      const payload = modrinthFetchPayload(f, "7d1f4c64-62a4-4d55-9b52-5e6f1d0b8a11");
      expect(fetchSchema.safeParse(payload).success).toBe(true);
    }
  });

  it("Fabric: Ledger resolves Fabric API + Fabric Language Kotlin and flags incompatible Cardboard", async () => {
    const { client, misses } = recorded();
    const plan = await planModrinthInstall(client, { software: "fabric", minecraftVersion: "1.21.1", project: "ledger" });
    expect(misses).toEqual([]);
    expect(plan.installDir).toBe("mods");
    expect(plan.files.map((f) => f.projectSlug)).toEqual(["fabric-api", "fabric-language-kotlin", "ledger"]);
    expect(plan.files.every((f) => f.destPath.startsWith("mods/") && f.loaders.includes("fabric"))).toBe(true);
    expect(plan.installable).toBe(true);
    expect(plan.warnings.filter((w) => w.level !== "info")).toEqual([]);

    const withCardboard = await planModrinthInstall(recorded().client, {
      software: "fabric",
      minecraftVersion: "1.21.1",
      project: "ledger",
      installed: [
        { path: "mods/cardboard.jar", projectId: "MLYQ9VGP" },
        { path: "mods/fabric-api.jar", projectId: "P7dR8mSH" },
      ],
    });
    expect(withCardboard.installable).toBe(false);
    expect(withCardboard.warnings).toContainEqual(expect.objectContaining({ code: "INCOMPATIBLE_INSTALLED", level: "error", projectId: "MLYQ9VGP" }));
    expect(withCardboard.warnings.find((w) => w.code === "INCOMPATIBLE_INSTALLED")!.message).toContain("Cardboard");
    expect(withCardboard.warnings).toContainEqual(expect.objectContaining({ code: "DEPENDENCY_ALREADY_INSTALLED", projectId: "P7dR8mSH" }));
    expect(withCardboard.files.map((f) => f.projectSlug)).toEqual(["fabric-language-kotlin", "ledger"]);
  });

  it("Fabric: client-only mods (Iris + Sodium) are flagged", async () => {
    const { client, misses } = recorded();
    const plan = await planModrinthInstall(client, { software: "fabric", minecraftVersion: "1.21.1", project: "iris" });
    expect(misses).toEqual([]);
    expect(plan.files.map((f) => f.projectSlug)).toEqual(["sodium", "iris"]);
    const clientOnly = plan.warnings.filter((w) => w.code === "CLIENT_ONLY");
    expect(clientOnly.map((w) => w.projectId).sort()).toEqual(["AANobbMI", "YL57xq9U"]);
    expect(clientOnly.every((w) => w.level === "warning")).toBe(true);
  });

  it("Fabric: embedded dependencies are reported, not installed (FabricProxy-Lite 2.9.0)", async () => {
    const { client, misses } = recorded();
    const latest = await planModrinthInstall(client, { software: "fabric", minecraftVersion: "1.21.1", project: "fabricproxy-lite" });
    expect(latest.files.map((f) => f.projectSlug)).toEqual(["fabric-api", "fabricproxy-lite"]);
    const pinned = await planModrinthInstall(client, { software: "fabric", minecraftVersion: "1.21.1", project: "fabricproxy-lite", versionId: "AQhF7kvw" });
    expect(misses).toEqual([]);
    expect(pinned.root.versionNumber).toBe("v2.9.0");
    expect(pinned.files.map((f) => f.projectSlug)).toEqual(["fabricproxy-lite"]);
    expect(pinned.warnings).toContainEqual(expect.objectContaining({ code: "EMBEDDED_DEPENDENCY", level: "info", projectId: "P7dR8mSH" }));
  });

  it("Fabric: Quilt-only builds are accepted with a warning", async () => {
    const { client, misses } = recorded();
    const plan = await planModrinthInstall(client, { software: "fabric", minecraftVersion: "1.20.1", project: "qsl" });
    expect(misses).toEqual([]);
    expect(plan.files[0]!.loaders).toEqual(["quilt"]);
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "QUILT_ON_FABRIC", level: "warning" }));
  });

  it("Velocity: no game-version filter, plugins/ destination", async () => {
    const { client, misses, calls } = recorded();
    const plan = await planModrinthInstall(client, { software: "velocity", minecraftVersion: null, project: "luckperms" });
    expect(misses).toEqual([]);
    expect(calls.some((c) => c.url.includes("game_versions"))).toBe(false);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]!.destPath).toMatch(/^plugins\/LuckPerms-Velocity-[\d.]+\.jar$/);
    expect(plan.minecraftVersion).toBeNull();
  });

  it("already-installed bytes are skipped; older versions are replaced", async () => {
    const { client, misses } = recorded();
    const same = await planModrinthInstall(client, {
      software: "paper",
      minecraftVersion: "1.21.11",
      project: "luckperms",
      installed: [{ path: "plugins/LuckPerms.jar", sha512: scenarios.luckpermsNewest.primaryFile.sha512 }],
    });
    expect(same.files).toEqual([]);
    expect(same.alreadyInstalled).toEqual([{ projectId: "Vebnzrzj", versionId: scenarios.luckpermsNewest.versionId, path: "plugins/LuckPerms.jar" }]);
    expect(same.warnings).toContainEqual(expect.objectContaining({ code: "ALREADY_INSTALLED", level: "info" }));

    const older = scenarios.luckpermsOlder;
    const oldPath = `plugins/${older.primaryFile.filename}`;
    const update = await planModrinthInstall(client, {
      software: "paper",
      minecraftVersion: "1.21.11",
      project: "luckperms",
      installed: [{ path: oldPath, sha512: older.primaryFile.sha512, projectId: older.projectId, versionId: older.versionId }],
    });
    expect(misses).toEqual([]);
    expect(update.files).toHaveLength(1);
    expect(update.files[0]).toMatchObject({ action: "replace", replaces: [oldPath], versionNumber: scenarios.luckpermsNewest.versionNumber });
    expect(update.warnings).toContainEqual(expect.objectContaining({ code: "REPLACES_INSTALLED" }));
  });

  it("refuses software without Modrinth support and requires a game version", async () => {
    const { client } = recorded();
    await expect(planModrinthInstall(client, { software: "vanilla", minecraftVersion: "1.21.11", project: "luckperms" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(planModrinthInstall(client, { software: "paper", minecraftVersion: null, project: "luckperms" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(planModrinthInstall(client, { software: "paper", minecraftVersion: "1.21.11", project: "../../x" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(planModrinthInstall(client, { software: "paper", minecraftVersion: "1.21.11", project: ".." })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("Modrinth: installed files (recorded)", () => {
  it("identifies jars by hash and leaves unknown files unidentified", async () => {
    const { client, misses } = recorded();
    const res = await identifyModrinthFiles(client, scenarios.installed);
    expect(misses).toEqual([]);
    expect(res[0]!.modrinth).toMatchObject({ projectId: "Vebnzrzj", slug: "luckperms", title: "LuckPerms", versionNumber: scenarios.luckpermsOlder.versionNumber, clientOnly: false });
    expect(res[0]!.hash?.algorithm).toBe("sha512");
    expect(res[1]).toEqual({ path: "plugins/custom-plugin.jar", hash: { algorithm: "sha512", value: "0".repeat(128) }, modrinth: null });
  });

  it("finds updates for the server's loaders and game version", async () => {
    const { client, misses } = recorded();
    const res = await checkModrinthUpdates(client, { software: "paper", minecraftVersion: "1.21.11" }, scenarios.installed);
    expect(misses).toEqual([]);
    expect(res[0]).toMatchObject({
      updateAvailable: true,
      current: { versionNumber: scenarios.luckpermsOlder.versionNumber },
      latest: { versionNumber: scenarios.luckpermsNewest.versionNumber },
    });
    expect(res[0]!.file).toMatchObject({ action: "replace", destPath: `plugins/${scenarios.luckpermsNewest.primaryFile.filename}`, replaces: [scenarios.installed[0]!.path] });
    expect(res[0]!.file!.checksum.algorithm).toBe("sha512");
    expect(res[1]).toMatchObject({ updateAvailable: false, current: null, latest: null, file: null });
  });

  it("never offers a beta as an update for a release unless prereleases are allowed (WorldEdit 7.4.5)", async () => {
    const we = (JSON.parse(fixture("modrinth/scenarios.json")) as { worldedit745: { primaryFile: { filename: string; sha512: string } } }).worldedit745;
    const installed = [{ path: `plugins/${we.primaryFile.filename}`, sha512: we.primaryFile.sha512 }];
    const { client, misses, calls } = recorded();
    const stable = await checkModrinthUpdates(client, { software: "paper", minecraftVersion: "1.21.11" }, installed);
    expect(stable[0]).toMatchObject({ updateAvailable: false, current: { versionNumber: "7.4.5" } });
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ version_types: ["release"] });
    const pre = await checkModrinthUpdates(client, { software: "paper", minecraftVersion: "1.21.11" }, installed, { allowPrerelease: true });
    expect(misses).toEqual([]);
    expect(pre[0]).toMatchObject({ updateAvailable: true, latest: { versionType: "beta" } });
    expect(pre[0]!.latest!.versionNumber).toMatch(/^7\.4\.6-beta/);
  });

  it("single-hash lookups: 404 → null, SHA-1 hit, update endpoint", async () => {
    const { client, misses } = recorded();
    expect(await client.versionFromHash("0".repeat(128), "sha512")).toBeNull();
    expect((await client.versionFromHash(scenarios.luckpermsOlder.primaryFile.sha1, "sha1"))!.id).toBe(scenarios.luckpermsOlder.versionId);
    const latest = await client.latestVersionFromHash(scenarios.luckpermsOlder.primaryFile.sha1, "sha1", { loaders: ["paper", "spigot", "bukkit"], gameVersions: ["1.21.11"] });
    expect(latest!.id).toBe(scenarios.luckpermsNewest.versionId);
    expect(misses).toEqual([]);
    await expect(client.versionFromHash("xyz", "sha1")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

// ---------------------------------------------------------------------------------------------
// Synthetic upstream for edge cases

function version(id: string, projectId: string, deps: Array<[string, string]> = [], over: Partial<ModrinthVersionRaw> = {}): ModrinthVersionRaw {
  return {
    id,
    project_id: projectId,
    name: id,
    version_number: `1.0.0-${id}`,
    date_published: "2026-01-01T00:00:00Z",
    downloads: 0,
    version_type: "release",
    status: "listed",
    loaders: ["paper"],
    game_versions: ["1.21.11"],
    files: [{ hashes: { sha1: "a".repeat(40), sha512: id.toLowerCase().padEnd(128, "0").replace(/[^a-f0-9]/g, "0") }, url: `https://cdn.modrinth.com/data/${projectId}/versions/${id}/${projectId}.jar`, filename: `${projectId}.jar`, primary: true, size: 10 }],
    dependencies: deps.map(([project_id, dependency_type]) => ({ project_id, version_id: null, file_name: null, dependency_type })),
    ...over,
  };
}

function project(id: string) {
  return {
    id, slug: id.toLowerCase(), project_type: "mod", title: `Title ${id}`, description: "", categories: [], loaders: ["paper"], game_versions: ["1.21.11"], versions: [],
    client_side: "unsupported", server_side: "required", status: "approved", downloads: 0, followers: 0, published: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
  };
}

function fakeUpstream(versions: Record<string, ModrinthVersionRaw[]>, extra: (url: URL, init?: RequestInit) => Response | null = () => null): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url.href);
    const custom = extra(url, init);
    if (custom) return custom;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "250", "x-ratelimit-reset": "30" } });
    let m = /^\/v2\/project\/([^/]+)\/version$/.exec(url.pathname);
    if (m) return json(versions[m[1]!] ?? []);
    m = /^\/v2\/project\/([^/]+)$/.exec(url.pathname);
    if (m) return json(project(m[1]!));
    if (url.pathname === "/v2/projects") return json((JSON.parse(url.searchParams.get("ids")!) as string[]).map(project));
    return new Response("", { status: 404 });
  };
  return { fetch, urls };
}

describe("Modrinth: dependency resolution edge cases (synthetic upstream)", () => {
  it("is cycle-safe: A → B → A resolves each project once", async () => {
    const up = fakeUpstream({ AAAA: [version("VA", "AAAA", [["BBBB", "required"]])], BBBB: [version("VB", "BBBB", [["AAAA", "required"]])] });
    const plan = await planModrinthInstall(new ModrinthClient({ fetch: up.fetch, userAgent: UA }), { software: "paper", minecraftVersion: "1.21.11", project: "AAAA" });
    expect(plan.files.map((f) => f.projectId)).toEqual(["BBBB", "AAAA"]);
    expect(plan.installable).toBe(true);
  });

  it("is bounded: a long chain stops at maxFiles with an error", async () => {
    const chain: Record<string, ModrinthVersionRaw[]> = {};
    for (let i = 0; i < 50; i++) chain[`P${String(i).padStart(3, "0")}`] = [version(`V${i}`, `P${String(i).padStart(3, "0")}`, [[`P${String(i + 1).padStart(3, "0")}`, "required"]])];
    const up = fakeUpstream(chain);
    const plan = await planModrinthInstall(new ModrinthClient({ fetch: up.fetch, userAgent: UA }), { software: "paper", minecraftVersion: "1.21.11", project: "P000", maxFiles: 5 });
    expect(plan.files).toHaveLength(5);
    expect(plan.installable).toBe(false);
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "DEPENDENCY_LIMIT", level: "error" }));
    expect(up.urls.length).toBeLessThan(20);
  });

  it("reports unresolved required dependencies, optional ones, external files and incompatibilities in the plan", async () => {
    const up = fakeUpstream({
      ROOT: [version("VR", "ROOT", [["MISS", "required"], ["OPTL", "optional"], ["BADX", "required"]], { dependencies: [
        { project_id: "MISS", version_id: null, file_name: null, dependency_type: "required" },
        { project_id: "OPTL", version_id: null, file_name: null, dependency_type: "optional" },
        { project_id: "BADX", version_id: null, file_name: null, dependency_type: "required" },
        { project_id: null, version_id: null, file_name: "Vault.jar", dependency_type: "required" },
        { project_id: "ROOT", version_id: null, file_name: null, dependency_type: "required" },
        { project_id: "WEIR", version_id: null, file_name: null, dependency_type: "suggested" },
      ] })],
      BADX: [version("VX", "BADX", [["ROOT", "incompatible"]])],
      OPTL: [version("VO", "OPTL")],
    });
    const plan = await planModrinthInstall(new ModrinthClient({ fetch: up.fetch, userAgent: UA }), { software: "paper", minecraftVersion: "1.21.11", project: "ROOT" });
    const codes = plan.warnings.map((w) => `${w.code}:${w.level}:${w.projectId ?? ""}`);
    expect(codes).toEqual(expect.arrayContaining([
      "DEPENDENCY_UNRESOLVED:error:MISS",
      "INCOMPATIBLE_IN_PLAN:error:ROOT",
      "DEPENDENCY_EXTERNAL_FILE:warning:ROOT",
      "OPTIONAL_DEPENDENCY:info:OPTL",
      "UNKNOWN_DEPENDENCY_TYPE:info:WEIR",
    ]));
    expect(plan.optionalDependencies).toEqual([{ projectId: "OPTL", slug: "optl", title: "Title OPTL", requiredBy: "ROOT" }]);
    expect(plan.installable).toBe(false);
    expect(plan.warnings.find((w) => w.code === "DEPENDENCY_UNRESOLVED")!.message).toContain("Title MISS");

    const opted = await planModrinthInstall(new ModrinthClient({ fetch: up.fetch, userAgent: UA }), { software: "paper", minecraftVersion: "1.21.11", project: "ROOT", includeOptional: ["OPTL"] });
    expect(opted.files.find((f) => f.projectId === "OPTL")!.reason).toBe("optional-dependency");
  });

  it("refuses files outside cdn.modrinth.com and duplicate file names", async () => {
    const up = fakeUpstream({
      ROOT: [version("VR", "ROOT", [["EVIL", "required"], ["DUPE", "required"]])],
      EVIL: [version("VE", "EVIL", [], { files: [{ hashes: { sha1: "b".repeat(40), sha512: "b".repeat(128) }, url: "https://169.254.169.254/x.jar", filename: "x.jar", primary: true, size: 1 }] })],
      DUPE: [version("VD", "DUPE", [], { files: [{ hashes: { sha1: "c".repeat(40), sha512: "c".repeat(128) }, url: "https://cdn.modrinth.com/data/DUPE/ROOT.jar", filename: "ROOT.jar", primary: true, size: 1 }] })],
    });
    const plan = await planModrinthInstall(new ModrinthClient({ fetch: up.fetch, userAgent: UA }), { software: "paper", minecraftVersion: "1.21.11", project: "ROOT" });
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "NO_INSTALLABLE_FILE", level: "error", projectId: "EVIL" }));
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "FILE_CONFLICT", level: "error", projectId: "ROOT" }));
    expect(plan.files.map((f) => f.url).every((u) => cdn(u) === "cdn.modrinth.com")).toBe(true);
  });

  it("pinned versions: other project → error; incompatible loader → error warning", async () => {
    const up = fakeUpstream({}, (url) => {
      if (url.pathname === "/v2/version/OTHR") return new Response(JSON.stringify(version("OTHR", "ZZZZ")), { status: 200 });
      if (url.pathname === "/v2/version/FABR") return new Response(JSON.stringify(version("FABR", "ROOT", [], { loaders: ["fabric"] })), { status: 200 });
      return null;
    });
    const client = new ModrinthClient({ fetch: up.fetch, userAgent: UA });
    await expect(planModrinthInstall(client, { software: "paper", minecraftVersion: "1.21.11", project: "ROOT", versionId: "OTHR" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const plan = await planModrinthInstall(client, { software: "paper", minecraftVersion: "1.21.11", project: "ROOT", versionId: "FABR" });
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "VERSION_MISMATCH", level: "error" }));
    expect(plan.installable).toBe(false);
    await expect(planModrinthInstall(client, { software: "paper", minecraftVersion: "1.21.11", project: "NONE" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("Modrinth: transport (rate limits, redirects, response validation)", () => {
  it("parses rate-limit headers into a back-off hint", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(parseRateLimit(h({ "x-ratelimit-limit": "300", "x-ratelimit-remaining": "299", "x-ratelimit-reset": "0" }), 200)).toEqual({ limit: 300, remaining: 299, resetSeconds: 0, backoffMs: 0 });
    expect(parseRateLimit(h({ "x-ratelimit-limit": "300", "x-ratelimit-remaining": "3", "x-ratelimit-reset": "42" }), 200).backoffMs).toBe(42_000);
    expect(parseRateLimit(h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "7" }), 429).backoffMs).toBe(7_000);
    expect(parseRateLimit(h({ "retry-after": "5", "x-ratelimit-reset": "7" }), 429).backoffMs).toBe(5_000);
    expect(parseRateLimit(h({ "x-ratelimit-remaining": "-1" }), 200)).toEqual({ limit: null, remaining: null, resetSeconds: null, backoffMs: 0 });
  });

  it("429 → RATE_LIMITED with retryAfterMs; an exhausted window refuses locally until reset", async () => {
    let now = 1_000_000;
    let calls = 0;
    const fetch: Fetch = async () => {
      calls++;
      return new Response(JSON.stringify(project("AAAA")), { status: 200, headers: { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "20" } });
    };
    const client = new ModrinthClient({ fetch, userAgent: UA, now: () => now });
    await client.getProject("AAAA");
    expect(client.rateLimit).toEqual({ limit: 300, remaining: 0, resetSeconds: 20, backoffMs: 20_000 });
    await expect(client.getProject("BBBB")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 20_000 });
    expect(calls).toBe(1);
    now += 20_001;
    await client.getProject("BBBB");
    expect(calls).toBe(2);

    const limited = new ModrinthClient({ fetch: async () => new Response("", { status: 429, headers: { "x-ratelimit-reset": "9" } }), userAgent: UA });
    await expect(limited.getProject("AAAA")).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429, retryAfterMs: 9_000 });
  });

  it("refuses off-host redirects, POST redirects and non-HTTPS bases", async () => {
    const off = new ModrinthClient({ fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/v2/project/x" } }), userAgent: UA });
    await expect(off.getProject("AAAA")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    const post = new ModrinthClient({ fetch: async () => new Response(null, { status: 307, headers: { location: "https://api.modrinth.com/v2/version_files" } }), userAgent: UA });
    await expect(post.versionsFromHashes(["a".repeat(40)], "sha1")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(() => new ModrinthClient({ fetch: globalThis.fetch, userAgent: UA, apiBase: "http://api.modrinth.com/v2" })).toThrow(CatalogError);
    expect(() => new ModrinthClient({ fetch: globalThis.fetch, userAgent: UA, apiBase: "https://127.0.0.1/v2" })).toThrow(CatalogError);
  });

  it("rejects malformed responses, including __proto__ keys in hash maps", async () => {
    const proto = new ModrinthClient({ fetch: async () => new Response('{"__proto__":{"polluted":true}}', { status: 200 }), userAgent: UA });
    // zod drops a JSON `__proto__` key without touching prototypes; other non-hash keys are rejected.
    expect((await proto.versionsFromHashes(["a".repeat(40)], "sha1")).size).toBe(0);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
    const odd = new ModrinthClient({ fetch: async () => new Response('{"constructor":{}}', { status: 200 }), userAgent: UA });
    await expect(odd.versionsFromHashes(["a".repeat(40)], "sha1")).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    const bad = new ModrinthClient({ fetch: async () => new Response('{"id":"x"}', { status: 200 }), userAgent: UA });
    await expect(bad.getProject("AAAA")).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    const huge = new ModrinthClient({ fetch: async () => new Response("x".repeat(100), { status: 200 }), userAgent: UA, maxResponseBytes: 10 });
    await expect(huge.getProject("AAAA")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("batches hash lookups by 100 and caches GET responses", async () => {
    const bodies: string[] = [];
    const client = new ModrinthClient({
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 200 });
      },
      userAgent: UA,
    });
    const hashes = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(40, "0"));
    expect((await client.versionsFromHashes(hashes, "sha1")).size).toBe(0);
    expect(bodies.map((b) => (JSON.parse(b) as { hashes: string[] }).hashes.length)).toEqual([100, 100, 50]);
  });
});
