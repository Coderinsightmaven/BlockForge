import { describe, expect, it } from "vitest";
import {
  ModrinthClient,
  ModrinthRateLimiter,
  banIp,
  banPlayer,
  checkModrinthUpdates,
  createSaveTracker,
  detectLogEvents,
  emptyPlayerList,
  identifyModrinthFiles,
  isSafeInstalledExtensionPath,
  isSafeJarFilename,
  isSafeNestedJarPath,
  isSaveConfirmation,
  isSaveFailure,
  isSaveOffConfirmation,
  isSaveProgress,
  lookupMojangProfile,
  modrinthFetchPayload,
  modrinthLoaderProfile,
  parseCommandFeedback,
  parseFabricModJson,
  parsePaperPluginYml,
  parsePlayerList,
  parsePlayerListOutput,
  parsePluginYml,
  parseWhitelistListOutput,
  pickModrinthVersion,
  planModrinthInstall,
  primaryJarFile,
  removeFromPlayerList,
  searchModrinth,
  serializePlayerList,
  type Fetch,
  type ModrinthVersionRaw,
} from "../src/index.js";
import { ctxFor, fixture } from "./helpers.js";

/**
 * Regression tests for the Grok review of the Phase 4b libraries
 * (docs/reviews/2026-10-12-minecraft-phase4b-libs.md), one block per finding.
 */

const UA = "BlockForge/0.1.0 (review tests)";
const captured = (JSON.parse(fixture("console/captured-26.3.json")) as { lines: Record<string, string[]> }).lines;

// --- synthetic Modrinth upstream ---------------------------------------------------------------

let seq = 0;
function hex(len: number): string {
  seq++;
  return seq.toString(16).padStart(len, "0");
}

function ver(id: string, projectId: string, over: Partial<ModrinthVersionRaw> = {}): ModrinthVersionRaw {
  return {
    id,
    project_id: projectId,
    name: id,
    version_number: `v-${id}`,
    date_published: "2026-01-01T00:00:00Z",
    downloads: 0,
    version_type: "release",
    status: "listed",
    loaders: ["paper"],
    game_versions: ["1.21.11"],
    files: [{ hashes: { sha1: hex(40), sha512: hex(128) }, url: `https://cdn.modrinth.com/data/${projectId}/versions/${id}/${projectId}-${id}.jar`, filename: `${projectId}-${id}.jar`, primary: true, size: 10 }],
    dependencies: [],
    ...over,
  };
}

const dep = (project_id: string | null, dependency_type: string, version_id: string | null = null, file_name: string | null = null) => ({ project_id, version_id, file_name, dependency_type });

function proj(id: string, over: Record<string, unknown> = {}) {
  return {
    id, slug: id.toLowerCase(), project_type: "mod", title: `Title ${id}`, description: "", categories: [], loaders: ["paper"], game_versions: ["1.21.11"], versions: [],
    client_side: "unsupported", server_side: "required", status: "approved", downloads: 0, followers: 0, published: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** Serves project version lists, single versions (`/version/{id}`), `/versions?ids`, `/projects?ids`, `/project/{id}`. */
function upstream(lists: Record<string, ModrinthVersionRaw[]>, byId: Record<string, ModrinthVersionRaw> = {}, extra: (url: URL, init?: RequestInit) => Response | null = () => null) {
  const urls: string[] = [];
  const all = new Map<string, ModrinthVersionRaw>();
  for (const vs of Object.values(lists)) for (const v of vs) all.set(v.id, v);
  for (const v of Object.values(byId)) all.set(v.id, v);
  const fetch: Fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const custom = extra(url, init);
    if (custom) return custom;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    let m = /^\/v2\/project\/([^/]+)\/version$/.exec(url.pathname);
    if (m) return json(lists[m[1]!] ?? []);
    m = /^\/v2\/project\/([^/]+)$/.exec(url.pathname);
    if (m) return json(proj(m[1]!));
    m = /^\/v2\/version\/([^/]+)$/.exec(url.pathname);
    if (m) return all.has(m[1]!) ? json(all.get(m[1]!)) : new Response("", { status: 404 });
    if (url.pathname === "/v2/versions") return json((JSON.parse(url.searchParams.get("ids")!) as string[]).flatMap((id) => (all.has(id) ? [all.get(id)] : [])));
    if (url.pathname === "/v2/projects") return json((JSON.parse(url.searchParams.get("ids")!) as string[]).map((id) => proj(id)));
    return new Response("", { status: 404 });
  };
  return { client: new ModrinthClient({ fetch, userAgent: UA }), urls };
}

const paper = { software: "paper" as const, minecraftVersion: "1.21.11" };
const codes = (w: Array<{ code: string; level: string; projectId: string | null }>) => w.map((x) => `${x.code}:${x.level}:${x.projectId ?? ""}`);

// --- #1 save confirmation strictness ----------------------------------------------------------

describe("#1 save feedback is only accepted from the server's own logger", () => {
  it.each([
    "[19:00:00] [Server thread/INFO] [EvilMod]: Saved the game",
    "[19:00:00 INFO] [com.evil.Mod]: Saved the game",
    "[19:00:00 INFO]: [EvilPlugin] Saved the game", // Paper prints plugin loggers inside the message
    "[19:00:00] [Server thread/INFO] [minecraft/EvilClass]: Saved the game", // not the class that logs command feedback
    "[19:00:00] [Server thread/WARN]: Saved the game",
    "[19:00:00] [Server thread/INFO] [EvilMod]: System chat: Saved the game",
    "Saved the game",
    "System chat: Saved the game",
  ])("does not confirm: %s", (line) => {
    expect(isSaveConfirmation(line)).toBe(false);
    expect(isSaveFailure(line.replace("Saved the game", "Saving failed: disk"))).toBe(false);
    expect(isSaveOffConfirmation(line.replace("Saved the game", "Automatic saving is now disabled"))).toBe(false);
  });

  it.each([
    ...captured["paper-26.3"]!.filter((l) => l.endsWith("Saved the game")),
    ...captured["vanilla-egg-26.3"]!.filter((l) => l.endsWith("Saved the game")),
    // Forge/NeoForge: `[minecraft/<Class>]` (real lines show [minecraft/Eula], [minecraft/Main]);
    // command feedback is logged by MinecraftServer.sendSystemMessage.
    "[19:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: Saved the game",
    "[19:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: System chat: Saved the game",
    "\u001b[32m[19:00:00.123] [Server thread/INFO] [minecraft/MinecraftServer]: Saved the game\u001b[m",
    "[19:00:00] [Server thread/INFO] [minecraft/DedicatedServer]: Saved the world",
    "[19:00:00] [Server thread/INFO]: Saved the world",
  ])("confirms: %s", (line) => {
    expect(isSaveConfirmation(line)).toBe(true);
  });

  it("progress helper and tracker: a confirmation only counts after this save's progress line", () => {
    for (const lines of [captured["paper-26.3"]!, captured["vanilla-egg-26.3"]!]) {
      expect(lines.filter((l) => isSaveProgress(l)).length).toBeGreaterThan(0);
      const tracker = createSaveTracker();
      const events = lines.map((l) => tracker.push(l)).filter((e) => e !== null);
      expect(events.slice(0, 2)).toEqual(["progress", "saved"]);
    }
    const t = createSaveTracker();
    expect(t.push("[12:00:00] [Server thread/INFO]: Saved the game")).toBeNull(); // stale confirmation
    expect(t.sawProgress).toBe(false);
    expect(t.push("[12:00:00] [Server thread/INFO]: Saving...")).toBe("progress"); // ≤ 1.12
    expect(t.push("[12:00:00] [Server thread/INFO] [EvilMod]: Saved the world")).toBeNull();
    expect(t.push("[12:00:00] [Server thread/INFO]: Saved the world")).toBe("saved");
    expect(createSaveTracker().push("[12:00:00 INFO]: System chat: Unable to save the game (is there enough disk space?)")).toBe("failed");
  });
});

// --- #2 events, feedback and list output -------------------------------------------------------

describe("#2 events and command output need a server logger and valid player names", () => {
  it("join/leave/disconnect events are not forged by other loggers or bare text", () => {
    for (const line of [
      "[19:00:00] [Server thread/INFO] [EvilMod]: Steve joined the game",
      "[19:00:00 INFO] [com.evil.Mod]: System chat: Steve left the game",
      "[19:00:00 INFO]: [EvilPlugin] Steve joined the game",
      "Steve joined the game",
      "[19:00:00] [Server thread/INFO] [EvilMod]: Steve lost connection: Disconnected",
    ]) {
      expect(detectLogEvents(line)).toEqual([]);
    }
    expect(detectLogEvents("[19:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: System chat: Steve joined the game")).toEqual([{ type: "player_join", name: "Steve" }]);
    expect(detectLogEvents("[19:00:00] [Server thread/INFO] [minecraft/ServerGamePacketListenerImpl]: Steve lost connection: Disconnected")).toEqual([
      { type: "player_disconnect", name: "Steve", reason: "Disconnected" },
    ]);
  });

  it("op/deop/ban/kick feedback rejects foreign loggers and non-player targets", () => {
    expect(parseCommandFeedback("[19:00:00] [Server thread/INFO] [EvilMod]: System chat: Made @a a server operator")).toBeNull();
    expect(parseCommandFeedback("[19:00:00] [Server thread/INFO]: System chat: Made @a a server operator")).toBeNull();
    expect(parseCommandFeedback("[19:00:00] [Server thread/INFO]: Kicked ../../ops.json: x")).toBeNull();
    expect(parseCommandFeedback("[19:00:00] [Server thread/INFO]: Banned IP 999.1.1.1: x")).toBeNull();
    expect(parseCommandFeedback("Made Steve a server operator")).toBeNull(); // bare text
    expect(parseCommandFeedback("[19:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: System chat: Made Steve a server operator")).toMatchObject({ action: "op", ok: true, target: "Steve" });
  });

  it("`list` / `whitelist list` drop entries that are not player names", () => {
    const out = parsePlayerListOutput(["[19:00:00] [Server thread/INFO]: System chat: There are 3 of a max of 20 players online: @a, ../../ops.json, Steve"]);
    expect(out).toEqual({ format: "vanilla", online: 3, max: 20, players: [{ name: "Steve", uuid: null }], skipped: 2 });
    expect(parsePlayerListOutput(["[19:00:00] [Server thread/INFO] [EvilMod]: There are 1 of a max of 20 players online: Steve"])).toBeNull();
    expect(parseWhitelistListOutput(["[19:00:00 INFO]: System chat: There are 2 whitelisted player(s): @e, Alex"])).toEqual({ format: "vanilla", players: ["Alex"], skipped: 1 });
  });
});

// --- #3 pins, status, explicit versions --------------------------------------------------------

describe("#3 dependency pins pass the same policy as automatic selection", () => {
  it("an unlisted alpha pin is ignored (allowPrerelease: false) and the newest listed release is used", async () => {
    const pin = ver("PINA", "LIBX", { status: "unlisted", version_type: "alpha" });
    const rel = ver("RELX", "LIBX");
    const { client } = upstream({ ROOT: [ver("VROOT", "ROOT", { dependencies: [dep("LIBX", "required", "PINA")] })], LIBX: [pin, rel] }, { PINA: pin });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", allowPrerelease: false });
    expect(plan.files.map((f) => f.versionId)).toEqual(["RELX", "VROOT"]);
    expect(codes(plan.warnings)).toContain("DEPENDENCY_PIN_IGNORED:warning:LIBX");
    expect(plan.installable).toBe(true);
  });

  it("fails closed when the pin is the only (unlisted) version", async () => {
    const pin = ver("PINB", "LIBY", { status: "unlisted" });
    const { client } = upstream({ ROOT: [ver("VR2", "ROOT", { dependencies: [dep("LIBY", "required", "PINB")] })], LIBY: [pin] }, { PINB: pin });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT" });
    expect(codes(plan.warnings)).toEqual(expect.arrayContaining(["DEPENDENCY_PIN_IGNORED:warning:LIBY", "DEPENDENCY_UNRESOLVED:error:LIBY"]));
    expect(plan.installable).toBe(false);
  });

  it("a missing status counts as unlisted", () => {
    const v = ver("NOSTAT", "P1");
    delete (v as Partial<ModrinthVersionRaw>).status;
    expect(pickModrinthVersion([v], modrinthLoaderProfile("paper")!, "1.21.11")).toBeNull();
  });

  it("an explicit root version for another game version is an error unless overridden", async () => {
    const old = ver("OLD1165", "ROOT", { game_versions: ["1.16.5"] });
    const { client } = upstream({}, { OLD1165: old });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", versionId: "OLD1165" });
    expect(codes(plan.warnings)).toContain("VERSION_MISMATCH:error:ROOT");
    expect(plan.installable).toBe(false);
    const forced = await planModrinthInstall(client, { ...paper, project: "ROOT", versionId: "OLD1165", allowIncompatibleVersion: true });
    expect(codes(forced.warnings)).toContain("VERSION_MISMATCH:warning:ROOT");
    expect(forced.installable).toBe(true);
  });
});

// --- #4 conflicting pins -----------------------------------------------------------------------

describe("#4 conflicting pins of a shared dependency", () => {
  it("ADEP pins LIB→PIN1, ROOT pins LIB→PIN2 → DEPENDENCY_PIN_CONFLICT, not installable", async () => {
    const pin1 = ver("PIN1", "LIBZ");
    const pin2 = ver("PIN2", "LIBZ", { date_published: "2026-02-01T00:00:00Z" });
    const { client } = upstream(
      {
        ROOT: [ver("VR4", "ROOT", { dependencies: [dep("ADEP", "required"), dep("LIBZ", "required", "PIN2")] })],
        ADEP: [ver("VA4", "ADEP", { dependencies: [dep("LIBZ", "required", "PIN1")] })],
        LIBZ: [pin1, pin2],
      },
      { PIN1: pin1, PIN2: pin2 },
    );
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT" });
    expect(plan.files.find((f) => f.projectId === "LIBZ")!.versionId).toBe("PIN1");
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "DEPENDENCY_PIN_CONFLICT", level: "error", projectId: "LIBZ", versionId: "PIN2" }));
    expect(plan.installable).toBe(false);
  });
});

// --- #5 installed copies vs pins ---------------------------------------------------------------

describe("#5 an installed dependency must match the pin", () => {
  const pin = ver("PINL", "LIBW");
  const oldV = ver("OLDL", "LIBW", { date_published: "2025-01-01T00:00:00Z" });
  const lists = { ROOT: [ver("VR5", "ROOT", { dependencies: [dep("LIBW", "required", "PINL")] })], LIBW: [pin, oldV] };

  it("installed OLD + pin PINL → the pinned version replaces the old jar", async () => {
    const { client } = upstream(lists, { PINL: pin, OLDL: oldV });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed: [{ path: "plugins/old-lib.jar", projectId: "LIBW", versionId: "OLDL" }] });
    const lib = plan.files.find((f) => f.projectId === "LIBW")!;
    expect(lib).toMatchObject({ versionId: "PINL", action: "replace", replaces: ["plugins/old-lib.jar"] });
    expect(codes(plan.warnings)).not.toContain("DEPENDENCY_ALREADY_INSTALLED:info:LIBW");
  });

  it("installed copy equal to the pin → nothing to fetch", async () => {
    const { client } = upstream(lists, { PINL: pin, OLDL: oldV });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed: [{ path: "plugins/lib.jar", projectId: "LIBW", versionId: "PINL" }] });
    expect(plan.files.map((f) => f.projectId)).toEqual(["ROOT"]);
    expect(codes(plan.warnings)).toContain("DEPENDENCY_ALREADY_INSTALLED:info:LIBW");
  });

  it("installed copy with an unknown version id → error", async () => {
    const { client } = upstream(lists, { PINL: pin });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed: [{ path: "plugins/lib.jar", projectId: "LIBW", versionId: "GONE" }] });
    expect(codes(plan.warnings)).toContain("DEPENDENCY_INSTALLED_UNKNOWN:error:LIBW");
    expect(plan.installable).toBe(false);
  });
});

// --- #6 request fan-out and rate limiting ------------------------------------------------------

describe("#6 bounded requests and a shared rate limiter", () => {
  it("30 optional version_id-only dependencies cause no version fetches", async () => {
    const deps = Array.from({ length: 30 }, (_, i) => dep(null, "optional", `OPT${i}`));
    const { client, urls } = upstream({ ROOT: [ver("VR6", "ROOT", { dependencies: deps })] });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT" });
    expect(urls.filter((u) => u.startsWith("GET /v2/version/"))).toEqual([]);
    expect(urls).toHaveLength(2); // project + version list (no /projects: nothing to name)
    expect(plan.optionalDependencies).toHaveLength(30);
    expect(plan.optionalDependencies[0]).toMatchObject({ projectId: null, versionId: "OPT0" });
  });

  it("only selected optional dependencies are fetched, and per-version dependency lists are capped", async () => {
    const opt = ver("OPT7", "OPTP");
    const deps = [...Array.from({ length: 100 }, (_, i) => dep(null, "optional", `OPT${i}`)), dep("LATE", "required")];
    const { client, urls } = upstream({ ROOT: [ver("VR7", "ROOT", { dependencies: deps })], OPTP: [opt] }, { OPT7: opt });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", includeOptional: ["OPT7"] });
    expect(urls.filter((u) => u.startsWith("GET /v2/version/"))).toEqual(["GET /v2/version/OPT7"]);
    expect(plan.files.map((f) => f.projectId)).toEqual(["OPTP", "ROOT"]);
    // The required dependency beyond entry 64 was never considered → error.
    expect(codes(plan.warnings)).toContain("DEPENDENCY_LIMIT:error:ROOT");
  });

  it("waits when the window is nearly used up, throws when the wait is too long, and is shared between clients", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new ModrinthRateLimiter({ now: () => now, sleep: async (ms) => void slept.push(ms), maxWaitMs: 5_000 });
    let remaining = 5;
    const fetch: Fetch = async () => new Response(JSON.stringify(proj("AAAA")), { status: 200, headers: { "x-ratelimit-limit": "300", "x-ratelimit-remaining": String(remaining--), "x-ratelimit-reset": "12" } });
    const a = new ModrinthClient({ fetch, userAgent: UA, limiter });
    const b = new ModrinthClient({ fetch, userAgent: UA, limiter });
    await a.getProject("AAAA"); // remaining 5, reset 12 s
    expect(slept).toEqual([]);
    await b.getProject("BBBB"); // shared view: 5 left in 12 s → spaced out
    expect(slept).toEqual([2_000]);
    expect(b.rateLimit).toBe(limiter.current);
    remaining = 0;
    await a.getProject("CCCC");
    await expect(b.getProject("DDDD")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    now += 13_000;
    await b.getProject("DDDD");
  });
});

// --- #7 primary file ---------------------------------------------------------------------------

describe("#7 only the primary file is installed", () => {
  const v = ver("V7", "P7");
  const jar = v.files[0]!;
  const hosts = ["cdn.modrinth.com"];
  it("primary readme.txt + payload.jar → NO_JAR", () => {
    expect(primaryJarFile({ ...v, files: [{ ...jar, filename: "readme.txt", primary: true }, { ...jar, filename: "payload.jar", primary: false }] }, hosts)).toEqual({ problem: "NO_JAR" });
  });
  it("no primary flag and several files → NO_JAR; a single unflagged jar is fine", () => {
    expect(primaryJarFile({ ...v, files: [{ ...jar, primary: false }, { ...jar, filename: "b.jar", primary: false }] }, hosts)).toEqual({ problem: "NO_JAR" });
    expect("file" in primaryJarFile({ ...v, files: [{ ...jar, primary: false }] }, hosts)).toBe(true);
  });
});

// --- #8 SHA-512 and hash lookups ---------------------------------------------------------------

describe("#8 SHA-512 is mandatory and hash lookups are verified", () => {
  it("a file without SHA-512 blocks the plan", async () => {
    const v = ver("V8", "ROOT");
    v.files = [{ ...v.files[0]!, hashes: { sha1: hex(40) } }];
    const { client } = upstream({ ROOT: [v] });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT" });
    expect(codes(plan.warnings)).toContain("NO_SHA512:error:ROOT");
    expect(plan.files).toEqual([]);
    expect(plan.installable).toBe(false);
  });

  it("a hash map whose version does not list the queried hash is ignored", async () => {
    const queried = "c".repeat(128);
    const other = ver("V8B", "P8");
    const fetch: Fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/version_files")) return new Response(JSON.stringify({ [queried]: other }), { status: 200 });
      if (url.includes("/version_file/")) return new Response(JSON.stringify(other), { status: 200 });
      if (url.endsWith("/version_files/update")) return new Response(JSON.stringify({ [queried]: other }), { status: 200 });
      return new Response("[]", { status: 200 });
    };
    const client = new ModrinthClient({ fetch, userAgent: UA });
    expect((await client.versionsFromHashes([queried], "sha512")).size).toBe(0);
    expect(await client.versionFromHash(queried, "sha512")).toBeNull();
    expect((await identifyModrinthFiles(client, [{ path: "plugins/x.jar", sha512: queried }]))[0]!.modrinth).toBeNull();
    expect((await checkModrinthUpdates(client, paper, [{ path: "plugins/x.jar", sha512: queried }]))[0]).toMatchObject({ current: null, latest: null, updateAvailable: false });
  });
});

// --- #9 search filtering -----------------------------------------------------------------------

describe("#9 search drops hits without a matching loader and client-only hits", () => {
  it("filters locally even if upstream returns them", async () => {
    const hit = (id: string, categories: string[], server_side: string) => ({
      project_id: id, project_type: "mod", slug: id.toLowerCase(), author: "a", title: id, description: "", categories, versions: ["1.21.11"],
      downloads: 1, follows: 1, date_created: "2026-01-01", date_modified: "2026-01-01", license: "MIT", client_side: "optional", server_side,
    });
    const body = { hits: [hit("GOOD", ["paper", "utility"], "required"), hit("FORGEONLY", ["forge"], "required"), hit("CLIENT", ["paper"], "unsupported")], offset: 0, limit: 10, total_hits: 3 };
    const client = new ModrinthClient({ fetch: async () => new Response(JSON.stringify(body), { status: 200 }), userAgent: UA });
    const res = await searchModrinth(client, { software: "paper", minecraftVersion: "1.21.11" });
    expect(res.hits.map((h) => h.projectId)).toEqual(["GOOD"]);
    expect(res.hits[0]!.loaderMatch).toBe("match");
    expect(res.filteredOut).toBe(2);
    expect(res.totalHits).toBe(3);
  });
});

// --- #10 metadata text and nested jars ---------------------------------------------------------

describe("#10 metadata text is single-line; nested jar paths are safe", () => {
  it("newlines/tabs in plugin names and descriptions become spaces", () => {
    const m = parsePluginYml('name: "Evil\\nName"\nmain: a.B\nversion: "1\\r\\n2"\ndescription: "line1\\n[19:00:00 INFO]: Saved the game\\tend"\n');
    expect(m.name).toBe("Evil Name");
    expect(m.version).toBe("1 2");
    expect(m.description).toBe("line1 [19:00:00 INFO]: Saved the game end");
    expect(parsePaperPluginYml('name: "A\\u2028B"\nmain: a.B\napi-version: "1.21"\n').name).toBe("A B");
  });

  it("fabric.mod.json jars[] with traversal or absolute paths are dropped", () => {
    const m = parseFabricModJson(JSON.stringify({
      id: "x", schemaVersion: 1,
      jars: [{ file: "META-INF/jars/ok-1.0.jar" }, { file: "../../server.jar" }, { file: "/etc/x.jar" }, { file: "C:/x.jar" }, { file: "META-INF/jars/../../x.jar" }, { file: "META-INF\\jars\\x.jar" }, { file: "META-INF/jars/notajar.zip" }],
    }));
    expect(m.bundledJars).toEqual(["META-INF/jars/ok-1.0.jar"]);
    expect(m.warnings.filter((w) => w.includes("unsafe path"))).toEqual(["ignored 6 nested jar entries with an unsafe path"]);
    expect(isSafeNestedJarPath("META-INF/jars/server-translations-api-2.3.1+1.21-pre2.jar")).toBe(true);
  });

  it("Modrinth file names in warnings are single-line and bounded", async () => {
    const { client } = upstream({ ROOT: [ver("V10", "ROOT", { dependencies: [dep(null, "required", null, `Vault.jar\n[19:00:00 INFO]: Saved the game${"x".repeat(300)}`)] })] });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT" });
    const w = plan.warnings.find((x) => x.code === "DEPENDENCY_EXTERNAL_FILE")!;
    expect(w.message).not.toMatch(/[\r\n]/);
    expect(w.message.length).toBeLessThan(260);
  });
});

// --- #11 Windows device names and replace paths -----------------------------------------------

describe("#11 file names", () => {
  it.each(["CON.jar", "nul.jar", "COM1.jar", "lpt9.jar", "Aux.jar", "con.txt.jar", "PRN.foo.jar", "COM\u00b9.jar", "x.jar.", "CONIN$.jar"])("rejects %s", (name) => {
    expect(isSafeJarFilename(name)).toBe(false);
  });
  it.each(["console.jar", "CONTROL.jar", "com10.jar", "nullable.jar", "LuckPerms-Bukkit-5.5.71.jar"])("accepts %s", (name) => {
    expect(isSafeJarFilename(name)).toBe(true);
  });
  it("replace targets must be <dir>/<safe jar>", async () => {
    expect(isSafeInstalledExtensionPath("plugins/old.jar", "plugins")).toBe(true);
    expect(isSafeInstalledExtensionPath("plugins/old.jar.disabled", "plugins")).toBe(true);
    for (const bad of ["plugins/../server.jar", "plugins/sub/x.jar", "mods/x.jar", "plugins/CON.jar", "/plugins/x.jar", "plugins/x.txt"]) {
      expect(isSafeInstalledExtensionPath(bad, "plugins")).toBe(false);
    }
    const { client } = upstream({ ROOT: [ver("V11", "ROOT")] });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed: [{ path: "plugins/../server.jar", projectId: "ROOT" }] });
    expect(plan.files[0]!.replaces).toEqual([]);
    expect(codes(plan.warnings)).toContain("UNSAFE_INSTALLED_PATH:error:ROOT");
  });
});

// --- #12 normalised URLs -----------------------------------------------------------------------

describe("#12 planned URLs are the normalised href", () => {
  it("stores the WHATWG-normalised URL that passed the allowlist", async () => {
    const v = ver("V12", "ROOT");
    v.files = [{ ...v.files[0]!, url: "https://cdn.modrinth.com\\@127.0.0.1/a.jar" }];
    const { client } = upstream({ ROOT: [v] });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT" });
    expect(plan.files[0]!.url).toBe("https://cdn.modrinth.com/@127.0.0.1/a.jar");
    expect(modrinthFetchPayload(plan.files[0]!, "7d1f4c64-62a4-4d55-9b52-5e6f1d0b8a11").url).toBe("https://cdn.modrinth.com/@127.0.0.1/a.jar");
    expect(() => modrinthFetchPayload({ ...plan.files[0]!, url: "https://evil.example/a.jar" }, "7d1f4c64-62a4-4d55-9b52-5e6f1d0b8a11")).toThrow();
  });
});

// --- #13 IPv4-mapped addresses -----------------------------------------------------------------

describe("#13 IP bans use the dotted IPv4 form", () => {
  it("bans and pardons match across spellings", () => {
    const now = new Date("2026-10-12T19:30:00Z");
    const doc = banIp(emptyPlayerList("banned-ips"), { ip: "::ffff:127.0.0.1", now });
    expect(doc.entries[0]!.ip).toBe("127.0.0.1");
    expect(removeFromPlayerList(doc, "::ffff:7f00:1").removed).toBe(1);
    expect(removeFromPlayerList(doc, "127.0.0.1").removed).toBe(1);
    expect(() => banIp(emptyPlayerList("banned-ips"), { ip: "2001:db8::1", now })).toThrow(/IPv4/);
  });
});

// --- #14 re-ban reason and Mojang name check ---------------------------------------------------

describe("#14 re-bans replace the reason; Mojang must return the requested name", () => {
  it("a re-ban without a reason drops the previous reason", () => {
    const now = new Date("2026-10-12T19:30:00Z");
    const uuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
    let doc = banPlayer(emptyPlayerList("banned-players"), { uuid, name: "Notch", reason: "old reason", now });
    doc = banPlayer(doc, { uuid, name: "Notch", now });
    expect(doc.entries[0]!.reason).toBeNull();
    expect(serializePlayerList(doc)).not.toContain("old reason");
    let ips = banIp(emptyPlayerList("banned-ips"), { ip: "203.0.113.7", reason: "old", now });
    ips = banIp(ips, { ip: "203.0.113.7", now });
    expect(parsePlayerList("banned-ips", serializePlayerList(ips)).entries[0]!.reason).toBeNull();
  });

  it("a profile for a different name is rejected", async () => {
    const ctx = ctxFor({ "https://api.mojang.com/users/profiles/minecraft/Notch": fixture("players/mojang-profile-404.json").replace(/.*/s, '{"id":"853c80ef3c3749fdaa49938b674adae6","name":"jeb_"}') });
    await expect(lookupMojangProfile(ctx, "Notch")).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });
});
