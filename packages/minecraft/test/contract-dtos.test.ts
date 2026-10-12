import {
  ExtensionCompatibility,
  ExtensionList,
  ExtensionMetadataView,
  ExtensionUpdateStatus,
  ModrinthInstallPlan,
  ModrinthPlanRequest,
  ModrinthProjectDetails,
  ModrinthRef,
  ModrinthSearchQuery,
  ModrinthSearchResult,
  ModrinthVersionSummary,
  PlayerActionResult,
  PlayerLookupResponse,
  PlayersOverview,
} from "@blockforge/contracts";
import type { ExtensionProblemCode, ExtensionUpdateProblem, PlanWarningCode } from "@blockforge/contracts";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  ModrinthClient,
  checkModrinthUpdates,
  contractVersionType,
  fromContractPlanRequest,
  fromContractSearchQuery,
  getModrinthProject,
  listCompatibleVersions,
  parseCommandFeedback,
  parseJarMetadata,
  parsePlayerList,
  parsePlayerListOutput,
  planModrinthInstall,
  searchModrinth,
  selectExtensionFiles,
  toContractInstallPlan,
  toContractJarInfo,
  toContractModrinthRef,
  identifyModrinthFiles,
  toContractPlayerFeedback,
  toContractPlayerLookup,
  toContractPlayersOverview,
  toContractProjectDetails,
  toContractSearchResult,
  toContractSkippedEntries,
  toContractUpdateStatus,
  toContractVersionSummary,
  jarCompatibility,
  type UpdateProblem,
  type JarCompatibility,
  type PlanWarningCode as LibPlanWarningCode,
} from "../src/index.js";
import { fixture, modrinthFetch } from "./helpers.js";

// Compile-time: closed enums agree in both directions; the library compatibility result is the contract shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _Codes = Assert<Same<LibPlanWarningCode, z.infer<typeof PlanWarningCode>>>;
type _Problems = Assert<Same<UpdateProblem, z.infer<typeof ExtensionUpdateProblem>>>;
type _Compat = Assert<JarCompatibility extends z.infer<typeof ExtensionCompatibility> ? true : false>;
type _ProblemCodes = Assert<JarCompatibility["problems"][number]["code"] extends z.infer<typeof ExtensionProblemCode> ? true : false>;

const UA = "BlockForge/0.1.0 (contract tests)";
const client = () => new ModrinthClient({ fetch: modrinthFetch().fetch, userAgent: UA });
const scenarios = JSON.parse(fixture("modrinth/scenarios.json")) as { installed: Array<{ path: string; sha512: string }> };
const EXT_ID = "2f0b1e3c-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

function parses<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues.slice(0, 5)));
  return r.data;
}

describe("library → contract converters parse with the contract schemas (recorded Modrinth data)", () => {
  it("search result (dates → epoch ms, installed flag)", async () => {
    const lib = await searchModrinth(client(), { software: "paper", minecraftVersion: "1.21.11", query: "luckperms", limit: 5 });
    const out = parses(ModrinthSearchResult, toContractSearchResult(lib, new Set(["Vebnzrzj"])));
    const lp = out.hits.find((h) => h.projectId === "Vebnzrzj")!;
    expect(lp.installed).toBe(true);
    expect(lp.dateModified).toBe(Date.parse(lib.hits.find((h) => h.projectId === "Vebnzrzj")!.dateModified));
    expect(out.hits.filter((h) => h.installed)).toHaveLength(1);
  });

  it("project details and version summaries", async () => {
    const p = await getModrinthProject(client(), "luckperms"); // fetched without software: compatible recomputed
    const details = parses(ModrinthProjectDetails, toContractProjectDetails(p, "paper"));
    expect(details).toMatchObject({ compatible: true, published: Date.parse(p.published) });
    const versions = await listCompatibleVersions(client(), "luckperms", { software: "paper", minecraftVersion: "1.21.11" });
    for (const v of versions) parses(ModrinthVersionSummary, toContractVersionSummary(v));
    // R2-8: unknown version types are never remapped — summaries are skipped, plan/update converters throw.
    expect(() => toContractVersionSummary({ ...versions[0]!, versionType: "snapshot" })).toThrow(TypeError);
    expect(() => contractVersionType("snapshot")).toThrow(TypeError);
  });

  it("install plans (with warnings, optional deps, replaces) and the API request mapping", async () => {
    const req = parses(ModrinthPlanRequest, { project: "worldguard" });
    const libReq = fromContractPlanRequest(req, { software: "paper", minecraftVersion: "1.21.11", installed: [] });
    expect(libReq.allowPrerelease).toBe(false); // API default, passed explicitly
    // The recording was made with the library default (prereleases allowed) — same result for WorldGuard.
    const plan = await planModrinthInstall(client(), { ...libReq, allowPrerelease: true });
    const out = parses(ModrinthInstallPlan, toContractInstallPlan(plan, { restartRequired: true }));
    expect(out.files.map((f) => f.sha512)).toEqual(plan.files.map((f) => f.sha512));
    expect(out.files[0]).not.toHaveProperty("checksum");
    for (const project of ["ledger", "iris", "qsl"]) {
      const mc = project === "qsl" ? "1.20.1" : "1.21.1";
      const p = await planModrinthInstall(client(), { software: "fabric", minecraftVersion: mc, project });
      parses(ModrinthInstallPlan, toContractInstallPlan(p, { restartRequired: false }));
    }
    const older = (JSON.parse(fixture("modrinth/scenarios.json")) as { luckpermsOlder: { projectId: string; versionId: string; primaryFile: { filename: string; sha512: string } } }).luckpermsOlder;
    const update = await planModrinthInstall(client(), {
      software: "paper",
      minecraftVersion: "1.21.11",
      project: "luckperms",
      installed: [{ path: `plugins/${older.primaryFile.filename}`, sha512: older.primaryFile.sha512, projectId: older.projectId, versionId: older.versionId }],
    });
    expect(parses(ModrinthInstallPlan, toContractInstallPlan(update, { restartRequired: true })).files[0]!.replaces).toHaveLength(1);
  });

  it("update statuses", async () => {
    const statuses = await checkModrinthUpdates(client(), { software: "paper", minecraftVersion: "1.21.11" }, scenarios.installed);
    for (const s of statuses) parses(ExtensionUpdateStatus, toContractUpdateStatus(s, EXT_ID));
    expect(toContractUpdateStatus(statuses[0]!, EXT_ID).latest!.datePublished).toBe(Date.parse(statuses[0]!.latest!.datePublished));
  });

  it("installed-file identity → ModrinthRef", async () => {
    const ids = await identifyModrinthFiles(client(), scenarios.installed);
    const ref = parses(ModrinthRef, toContractModrinthRef(ids[0]!.modrinth!));
    expect(ref).toMatchObject({ projectId: "Vebnzrzj", slug: "luckperms", pageUrl: "https://modrinth.com/project/luckperms", versionType: "release" });
    expect(ref.iconUrl?.startsWith("https://cdn.modrinth.com/")).toBe(true);
  });

  it("search query mapping", () => {
    const q = parses(ModrinthSearchQuery, { query: "perms", categories: "utility,management", limit: "10" });
    expect(fromContractSearchQuery(q, { software: "paper", minecraftVersion: "1.21.11" })).toEqual({
      software: "paper",
      minecraftVersion: "1.21.11",
      query: "perms",
      categories: ["utility", "management"],
      sort: "relevance",
      offset: 0,
      limit: 10,
    });
  });
});

describe("jar metadata and compatibility → contract", () => {
  const ext = (name: string) => fixture(`extensions/${name}`);
  it.each([
    [{ "plugin.yml": ext("luckperms-bukkit-5.5.71.plugin.yml") }, "paper"],
    [{ "paper-plugin.yml": ext("fancyholograms-3.0.0-SNAPSHOT.90.paper-plugin.yml"), "plugin.yml": "name: [" }, "paper"],
    [{ "fabric.mod.json": ext("ledger-1.3.5.fabric.mod.json") }, "fabric"],
    [{ "fabric.mod.json": ext("ledger-1.3.5.fabric.mod.json") }, "paper"],
    [{ "META-INF/mods.toml": ext("ferritecore-6.0.1-forge.mods.toml"), "META-INF/MANIFEST.MF": ext("ferritecore-6.0.1-forge.MANIFEST.MF") }, "neoforge"],
    [{ "velocity-plugin.json": ext("luckperms-velocity-5.5.71.velocity-plugin.json") }, "velocity"],
    [{}, "vanilla"],
  ] as const)("%# metadata views and compatibility parse", (entries, software) => {
    const info = toContractJarInfo(parseJarMetadata(entries), software);
    for (const m of info.metadata) parses(ExtensionMetadataView, m);
    parses(ExtensionCompatibility, info.compatibility);
  });

  it("long values are capped to the contract limits", () => {
    const long = "x".repeat(5000);
    const m = parseJarMetadata({ "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "x", version: long, authors: Array.from({ length: 100 }, (_, i) => `a${i}`), depends: { minecraft: Array.from({ length: 200 }, () => ">=1.21") } }) });
    const view = parses(ExtensionMetadataView, toContractJarInfo(m, "fabric").metadata[0]);
    expect(view.version).toHaveLength(256);
    expect(view.authors).toHaveLength(32);
    expect(jarCompatibility(m, "fabric").loadable).toBe(true);
  });

  it("scan skips map to ExtensionList.skipped (non-jar files are not listed)", () => {
    const { skipped } = selectExtensionFiles("plugins", [
      { name: "x.jar", type: "symlink", size: 1 },
      { name: "config.yml", type: "file", size: 1 },
      { name: "e.jar", type: "file", size: 0 },
    ]);
    const out = toContractSkippedEntries(skipped);
    expect(out).toEqual([{ name: "x.jar", reason: "symlink" }, { name: "e.jar", reason: "empty" }]);
    parses(ExtensionList.shape.skipped, out);
  });
});

describe("players → contract", () => {
  const now = new Date("2026-10-15T00:00:00Z");

  it("overview from the Gson list files, a `list` output and server.properties flags", () => {
    const overview = toContractPlayersOverview({
      online: { source: "list", output: parsePlayerListOutput(["[19:00:00 INFO]: System chat: There are 2 of a max of 20 players online: Notch, @a"])!, at: now.getTime() },
      onlineMode: true,
      whitelistEnabled: true,
      whitelistEnforced: false,
      lists: {
        whitelist: parsePlayerList("whitelist", fixture("players/gson-whitelist.json")),
        ops: parsePlayerList("ops", '[{"uuid":"069a79f4-44e9-4726-a5be-fca90e38aaf5","name":"Notch","level":7,"bypassesPlayerLimit":false}]'),
        bannedPlayers: parsePlayerList("banned-players", fixture("players/gson-banned-players.json")),
        bannedIps: parsePlayerList("banned-ips", fixture("players/gson-banned-ips.json")),
      },
      fileErrors: [{ file: "server.properties", message: "not readable" }],
      availableActions: ["kick", "ban", "pardon", "whitelist-add"],
      now,
    });
    const out = parses(PlayersOverview, overview);
    expect(out.online).toMatchObject({ count: 2, players: [{ name: "Notch", uuid: null }], skipped: 1, source: "list" });
    expect(out.bannedPlayers[0]).toMatchObject({ name: "Griefer", createdAt: Date.parse("2026-10-12T19:30:00Z"), expiresAt: null, active: true });
    // jeb_'s ban: created "2026-10-12 21:30:00 +0200", expires "2026-10-19 19:30:00 +0000".
    expect(out.bannedPlayers[1]).toMatchObject({ createdAt: Date.parse("2026-10-12T19:30:00Z"), expiresAt: Date.parse("2026-10-19T19:30:00Z"), active: true });
    expect(out.ops[0]!.level).toBe(4);
    expect(out.listErrors).toEqual([
      { file: "server.properties", message: "not readable" },
      { file: "ops.json", message: "operator Notch has level 7; the server only knows 0–4" },
      { file: "banned-players.json", message: "entry 2: the reason contains control or line-break characters (shown with spaces)" },
    ]);
  });

  it("an SLP sample, an empty overview, feedback and lookup", () => {
    parses(
      PlayersOverview,
      toContractPlayersOverview({
        online: { source: "slp", count: 3, max: 20, sample: [{ name: "Notch", uuid: "069a79f444e94726a5befca90e38aaf5" }, { name: "§cFake" }], at: 1 },
        onlineMode: null,
        whitelistEnabled: null,
        whitelistEnforced: null,
        lists: {},
        availableActions: [],
        now,
      }),
    );
    const fb = parseCommandFeedback("[19:00:00 INFO]: System chat: Made Notch a server operator")!;
    expect(parses(PlayerActionResult, { applied: "console", feedback: toContractPlayerFeedback(fb), overview: null }).feedback).toEqual({ ok: true, message: "Made Notch a server operator" });
    parses(PlayerLookupResponse, toContractPlayerLookup({ uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Notch", source: "mojang" }));
  });
});
