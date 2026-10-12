import { ExtensionUpdateStatus, ModrinthInstallPlan as ContractInstallPlan, PlayersOverview } from "@blockforge/contracts";
import { describe, expect, it } from "vitest";
import {
  ModrinthClient,
  ModrinthRateLimiter,
  checkModrinthUpdates,
  contractPlanWarnings,
  contractVersionType,
  detectLogEvents,
  detectReadiness,
  isSafeNestedJarPath,
  listCompatibleVersions,
  parsePlayerList,
  parsePlayerListOutput,
  planModrinthInstall,
  removeFromPlayerList,
  toContractInstallPlan,
  toContractPlayersOverview,
  toContractUpdateStatus,
  type Fetch,
  type ModrinthVersionRaw,
  type PlanWarning,
} from "../src/index.js";

/**
 * Regression tests for Grok's round-2 review of the Phase 4b libraries
 * (docs/reviews/2026-10-12-minecraft-phase4b-libs.md, "Round 2"), one block per finding.
 */

const UA = "BlockForge/0.1.0 (review r2 tests)";
let seq = 1000;
const hex = (len: number) => (++seq).toString(16).padStart(len, "0");

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
const dep = (project_id: string | null, dependency_type: string, version_id: string | null = null) => ({ project_id, version_id, file_name: null, dependency_type });
const proj = (id: string) => ({
  id, slug: id.toLowerCase(), project_type: "mod", title: `Title ${id}`, description: "", categories: [], loaders: ["paper"], game_versions: ["1.21.11"], versions: [],
  client_side: "unsupported", server_side: "required", status: "approved", downloads: 0, followers: 0, published: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
});

function upstream(lists: Record<string, ModrinthVersionRaw[]>, byId: Record<string, ModrinthVersionRaw> = {}, extra: (url: URL, init?: RequestInit) => Response | null = () => null) {
  const urls: string[] = [];
  const all = new Map<string, ModrinthVersionRaw>();
  for (const vs of Object.values(lists)) for (const v of vs) all.set(v.id, v);
  for (const v of Object.values(byId)) all.set(v.id, v);
  const fetch: Fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(`${init?.method ?? "GET"} ${url.pathname}`);
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
    if (url.pathname === "/v2/projects") return json((JSON.parse(url.searchParams.get("ids")!) as string[]).map(proj));
    return new Response("", { status: 404 });
  };
  return { client: new ModrinthClient({ fetch, userAgent: UA }), urls };
}
const paper = { software: "paper" as const, minecraftVersion: "1.21.11" };
const codes = (w: Array<{ code: string; level: string; projectId: string | null }>) => w.map((x) => `${x.code}:${x.level}:${x.projectId ?? ""}`);

// --- R2-1 -------------------------------------------------------------------------------------

describe("R2-1 the rate limiter never refuses while quota remains, and serialises callers", () => {
  const headers = (remaining: number, reset: number) => ({ "x-ratelimit-limit": "300", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset) });

  it("remaining=10, reset=60, default maxWaitMs (2 s): waits ≤ 2 s and sends, also on the retry", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new ModrinthRateLimiter({ now: () => now, sleep: async (ms) => void ((now += ms), slept.push(ms)) });
    let sent = 0;
    const client = new ModrinthClient({ fetch: async () => (sent++, new Response(JSON.stringify(proj("AAAA")), { status: 200, headers: headers(10, 60) })), userAgent: UA, limiter });
    await client.getProject("AAAA");
    await client.getProject("BBBB"); // ceil(60000 / 11) = 5455 ms → capped at 2000, request sent
    await client.getProject("CCCC"); // the retry is sent too
    expect(sent).toBe(3);
    expect(slept).toEqual([2_000, 2_000]);
  });

  it("only an exhausted window whose reset is further than maxWaitMs throws; a near reset is waited for", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new ModrinthRateLimiter({ now: () => now, sleep: async (ms) => void ((now += ms), slept.push(ms)) });
    limiter.update(new Headers(headers(0, 60)), 200);
    await expect(limiter.acquire("u")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 60_000 });
    limiter.update(new Headers(headers(0, 1)), 200);
    await limiter.acquire("u");
    expect(slept).toEqual([1_000]);
  });

  it("two overlapping acquires queue behind one permit and both count against the window", async () => {
    const events: string[] = [];
    const pending: Array<() => void> = [];
    const limiter = new ModrinthRateLimiter({
      now: () => 0,
      maxWaitMs: 10_000,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          events.push(`sleep ${ms}`);
          pending.push(() => (events.push("wake"), resolve()));
        }),
    });
    limiter.update(new Headers(headers(3, 12)), 200);
    const a = limiter.acquire("a").then(() => events.push("a sent"));
    const b = limiter.acquire("b").then(() => events.push("b sent"));
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(["sleep 3000"]); // b waits for the permit, not in parallel
    expect(limiter.current!.remaining).toBe(2); // a's request reserved before sleeping
    pending.shift()!();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    // b only starts sleeping once a's sleep is over (the permit is held across the sleep).
    expect(events.indexOf("sleep 4000")).toBeGreaterThan(events.indexOf("wake"));
    expect(events).toContain("a sent");
    expect(limiter.current!.remaining).toBe(1);
    pending.shift()!();
    await b;
    expect(events.at(-1)).toBe("b sent");
  });
});

// --- R2-2 -------------------------------------------------------------------------------------

describe("R2-2 an installed copy equal to the pin is still checked (path, SHA-512)", () => {
  const pin = ver("PINR", "LIBR");
  const lists = { ROOT: [ver("VRR", "ROOT", { dependencies: [dep("LIBR", "required", "PINR")] })], LIBR: [pin] };

  it("plugins/CON.jar → UNSAFE_INSTALLED_PATH, never DEPENDENCY_ALREADY_INSTALLED", async () => {
    const { client } = upstream(lists, { PINR: pin });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed: [{ path: "plugins/CON.jar", projectId: "LIBR", versionId: "PINR", sha512: pin.files[0]!.hashes.sha512! }] });
    expect(codes(plan.warnings)).toContain("UNSAFE_INSTALLED_PATH:error:LIBR");
    expect(codes(plan.warnings)).not.toContain("DEPENDENCY_ALREADY_INSTALLED:info:LIBR");
    expect(plan.installable).toBe(false);
  });

  it("same version id but a different SHA-512 → the pinned jar is downloaded and replaces the old file", async () => {
    const { client } = upstream(lists, { PINR: pin });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed: [{ path: "plugins/lib.jar", projectId: "LIBR", versionId: "PINR", sha512: "e".repeat(128) }] });
    expect(plan.files.find((f) => f.projectId === "LIBR")).toMatchObject({ versionId: "PINR", action: "replace", replaces: ["plugins/lib.jar"] });
  });

  it("same version id without any hash → downloaded (cannot be verified)", async () => {
    const { client } = upstream(lists, { PINR: pin });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed: [{ path: "plugins/lib.jar", projectId: "LIBR", versionId: "PINR" }] });
    expect(plan.files.map((f) => f.projectId)).toEqual(["LIBR", "ROOT"]);
  });
});

// --- R2-3 -------------------------------------------------------------------------------------

describe("R2-3 events need the class that logs them, and a strict player name", () => {
  const t = (logger: string, msg: string) => `[19:00:00] [Server thread/INFO] [${logger}]: ${msg}`;
  const types = (line: string) => detectLogEvents(line).map((e) => e.type);
  const uuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

  it.each([
    ["minecraft/MinecraftServer", "System chat: Steve joined the game", "player_join"],
    ["minecraft/MinecraftServer", "Steve left the game", "player_leave"],
    ["minecraft/PlayerList", "Steve[/203.0.113.7:51234] logged in with entity id 7 at (0.5, 64.0, 0.5)", "player_login"],
    ["minecraft/ServerLoginPacketListenerImpl", `UUID of player Steve is ${uuid}`, "player_uuid"],
    ["minecraft/ServerGamePacketListenerImpl", "Steve lost connection: Disconnected", "player_disconnect"],
    ["minecraft/ServerConfigurationPacketListenerImpl", `Steve (${uuid}) lost connection: Timed out`, "player_disconnect"],
    ["minecraft/DedicatedServer", 'Done (4.1s)! For help, type "help"', "ready"],
    ["minecraft/Main", "You need to agree to the EULA in order to run the server. Go to eula.txt for more info.", "eula_required"],
  ])("[%s] %s → %s", (logger, msg, type) => {
    expect(types(t(logger, msg))).toEqual([type]);
  });

  it.each([
    ["minecraft/EvilClass", "Steve joined the game"],
    ["minecraft/EvilClass", 'Done (1.0s)! For help, type "help"'],
    ["minecraft/MinecraftServer", "Steve[/203.0.113.7:51234] logged in with entity id 7 at (0.5, 64.0, 0.5)"],
    ["minecraft/PlayerList", `UUID of player Steve is ${uuid}`],
    ["minecraft/PlayerList", "Steve lost connection: Disconnected"],
    ["minecraft/EvilClass", "You need to agree to the EULA in order to run the server. Go to eula.txt for more info."],
    ["EvilMod", "Steve joined the game"],
  ])("[%s] %s → no event", (logger, msg) => {
    const events = detectLogEvents(t(logger, msg));
    expect(events).toEqual([]);
  });

  it("PlayerList broadcasts (pre-1.19) still count as join/leave", () => {
    expect(types(t("minecraft/PlayerList", "Steve joined the game"))).toEqual(["player_join"]);
  });

  it("vanilla/Paper/Velocity lines without a logger keep working", () => {
    expect(types("[19:00:00] [Server thread/INFO]: System chat: Steve joined the game")).toEqual(["player_join"]);
    expect(detectReadiness('[19:00:00 INFO]: Done (2.2s)! For help, type "help"')).toEqual({ seconds: 2.2 });
    expect(types("[03:42:24 INFO]: [connected player] Steve (/203.0.113.7:51234) has connected")).toEqual(["proxy_connect"]);
    expect(types("[03:42:24] [main/INFO] [com.velocitypowered.proxy.connection.client.ConnectedPlayer]: [connected player] Steve (/203.0.113.7:1) has connected")).toEqual(["proxy_connect"]);
    expect(types("[03:42:24] [main/INFO] [com.evil.Plugin]: [connected player] Steve (/203.0.113.7:1) has connected")).toEqual([]);
  });

  it.each(["@a", "../x", "St/eve", "a-b", "..Steve", "Steve Two", "ABCDEFGHIJKLMNOPQ"])("name %s never becomes a join", (name) => {
    expect(types(`[19:00:00] [Server thread/INFO]: ${name} joined the game`)).toEqual([]);
  });

  it("Floodgate's default `.` prefix is the one documented extra", () => {
    expect(detectLogEvents("[19:00:00] [Server thread/INFO]: .Steve joined the game")).toEqual([{ type: "player_join", name: ".Steve" }]);
  });
});

// --- R2-4 / R2-5 ------------------------------------------------------------------------------

describe("R2-4 more than 16 replaced files blocks the plan", () => {
  it("17 installed copies of the requested project → REPLACES_INSTALLED error, nothing planned", async () => {
    const { client } = upstream({ ROOT: [ver("V4", "ROOT")] });
    const installed = Array.from({ length: 17 }, (_, i) => ({ path: `plugins/root-${i}.jar`, projectId: "ROOT" }));
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed });
    expect(codes(plan.warnings)).toContain("REPLACES_INSTALLED:error:ROOT");
    expect(plan.files).toEqual([]);
    expect(plan.installable).toBe(false);
  });
});

describe("R2-5 errors survive the contract's warning cap", () => {
  it("600 infos + 1 trailing error → error first, 512 entries, omission noted", async () => {
    const w = (level: PlanWarning["level"], i: number): PlanWarning => ({ code: level === "error" ? "NO_SHA512" : "OPTIONAL_DEPENDENCY", level, message: `m${i}`, projectId: null, versionId: null });
    const warnings = [...Array.from({ length: 600 }, (_, i) => w("info", i)), w("warning", 600), w("error", 601)];
    const out = contractPlanWarnings(warnings);
    expect(out).toHaveLength(512);
    expect(out.slice(0, 2).map((x) => x.level)).toEqual(["error", "warning"]);
    expect(out[2]!.message).toBe("m0"); // stable within a level
    expect(out.at(-1)).toMatchObject({ code: "DEPENDENCY_LIMIT", level: "info", message: "91 more notes were omitted" });
    const { client } = upstream({ ROOT: [ver("V5", "ROOT")] });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT" });
    const contract = ContractInstallPlan.safeParse(toContractInstallPlan({ ...plan, warnings, installable: false }, { restartRequired: false }));
    expect(contract.success).toBe(true);
  });
});

// --- R2-6 -------------------------------------------------------------------------------------

describe("R2-6 the version picker offers only installable versions", () => {
  it("unlisted, status-less, snapshot and (optionally) prerelease versions are hidden", async () => {
    const noStatus = ver("NOST", "PICK", { date_published: "2026-05-01T00:00:00Z" });
    delete (noStatus as Partial<ModrinthVersionRaw>).status;
    const versions = [
      ver("REL1", "PICK", { date_published: "2026-01-01T00:00:00Z" }),
      ver("UNL1", "PICK", { status: "unlisted", date_published: "2026-02-01T00:00:00Z" }),
      ver("BETA", "PICK", { version_type: "beta", date_published: "2026-03-01T00:00:00Z" }),
      ver("SNAP", "PICK", { version_type: "snapshot", date_published: "2026-04-01T00:00:00Z" }),
      noStatus,
    ];
    const { client } = upstream({ PICK: versions });
    expect((await listCompatibleVersions(client, "PICK", paper)).map((v) => v.versionId)).toEqual(["BETA", "REL1"]);
    expect((await listCompatibleVersions(client, "PICK", paper, { allowPrerelease: false })).map((v) => v.versionId)).toEqual(["REL1"]);
  });
});

// --- R2-7 -------------------------------------------------------------------------------------

describe("R2-7 op levels, file text and list errors", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

  it("op level: missing → 0 (server default), non-integer → truncated with a note, non-number → unusable", () => {
    const doc = parsePlayerList(
      "ops",
      JSON.stringify([
        { uuid: uuid(1), name: "A" },
        { uuid: uuid(2), name: "B", level: 2.5 },
        { uuid: uuid(3), name: "C", level: "x" },
      ]),
    );
    expect(doc.entries.map((e) => `${e.name}:${e.level}`)).toEqual(["A:0", "B:2"]);
    expect(doc.issues).toEqual(["entry 2: level 2.5 is not an integer; the server uses 2", "entry 3: level is not a number (the server ignores it; kept unchanged)"]);
  });

  it("names, reasons and sources with control characters are shown single-line and noted", () => {
    const doc = parsePlayerList("banned-players", JSON.stringify([{ uuid: uuid(1), name: "Bad\u001b[31m", created: "2026-10-12 19:30:00 +0000", source: "x\ny", expires: "forever", reason: "r\u202Ee" }]));
    expect(doc.entries[0]).toMatchObject({ name: "Bad [31m", source: "x y", reason: "r e" });
    expect(doc.issues).toHaveLength(3);
  });

  it("clamp issues keep a slot when there are more than 64 list errors; the rest is summarised", () => {
    const whitelist = parsePlayerList("whitelist", JSON.stringify(Array.from({ length: 70 }, (_, i) => ({ uuid: `bad-${i}`, name: "x" }))));
    const ops = parsePlayerList("ops", JSON.stringify([{ uuid: uuid(9), name: "Op", level: 9 }]));
    const out = toContractPlayersOverview({ online: null, onlineMode: true, whitelistEnabled: null, whitelistEnforced: null, lists: { whitelist, ops }, availableActions: [], now: new Date() });
    expect(PlayersOverview.safeParse(out).success).toBe(true);
    expect(out.listErrors).toHaveLength(64);
    expect(out.listErrors[0]).toEqual({ file: "ops.json", message: "operator Op has level 9; the server only knows 0–4" });
    expect(out.listErrors.at(-1)).toEqual({ file: "whitelist.json", message: "8 more problems in whitelist.json" });
  });
});

// --- R2-8 -------------------------------------------------------------------------------------

describe("R2-8 request budget, incompatibility ids and unknown version types", () => {
  it("installed-version lookups count against the budget", async () => {
    const { client, urls } = upstream({ ROOT: [ver("V8", "ROOT")] });
    const installed = Array.from({ length: 3000 }, (_, i) => ({ path: `plugins/x${i}.jar`, projectId: `P${i}`, versionId: `I${i}` }));
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed, maxFiles: 1 });
    expect(urls.filter((u) => u === "GET /v2/versions").length).toBe(18); // budget = maxFiles * 2 + 16
    expect(codes(plan.warnings)).toContain("DEPENDENCY_LIMIT:error:");
  });

  it("incompatibilities given by version id are compared, never fetched", async () => {
    const lib = ver("LIBV", "LIBP");
    const deps = [...Array.from({ length: 30 }, (_, i) => dep(null, "incompatible", `INC${i}`)), dep("LIBP", "required"), dep(null, "incompatible", "LIBV"), dep(null, "incompatible", "INSTV")];
    const { client, urls } = upstream({ ROOT: [ver("V8B", "ROOT", { dependencies: deps })], LIBP: [lib] }, { INSTV: ver("INSTV", "OTHER") });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", installed: [{ path: "plugins/other.jar", projectId: "OTHER", versionId: "INSTV", sha512: "f".repeat(128) }] });
    expect(urls.filter((u) => u.startsWith("GET /v2/version/"))).toEqual([]);
    expect(codes(plan.warnings)).toEqual(expect.arrayContaining(["INCOMPATIBLE_IN_PLAN:error:LIBP", "INCOMPATIBLE_INSTALLED:error:OTHER"]));
  });

  it("an explicit root version with an unknown type is refused, and is never remapped on the wire", async () => {
    const snap = ver("SNAP8", "ROOT", { version_type: "snapshot" });
    const { client } = upstream({}, { SNAP8: snap });
    const plan = await planModrinthInstall(client, { ...paper, project: "ROOT", versionId: "SNAP8", allowIncompatibleVersion: true });
    expect(codes(plan.warnings)).toContain("VERSION_MISMATCH:error:ROOT");
    expect(plan.files).toEqual([]);
    expect(plan.installable).toBe(false);
    expect(() => contractVersionType("snapshot")).toThrow(TypeError);
  });
});

// --- R2-9 -------------------------------------------------------------------------------------

describe("R2-9 an unsafe installed path is reported as UNSAFE_INSTALLED_PATH", () => {
  it("update status problem + contract schema", async () => {
    const cur = ver("CUR9", "UPD", { date_published: "2026-01-01T00:00:00Z" });
    const next = ver("NEW9", "UPD", { date_published: "2026-06-01T00:00:00Z" });
    const sha = cur.files[0]!.hashes.sha512!;
    const fetch: Fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/version_files")) return new Response(JSON.stringify({ [sha]: cur }), { status: 200 });
      if (url.endsWith("/version_files/update")) return new Response(JSON.stringify({ [sha]: next }), { status: 200 });
      return new Response("[]", { status: 200 });
    };
    const client = new ModrinthClient({ fetch, userAgent: UA });
    const [status] = await checkModrinthUpdates(client, paper, [{ path: "plugins/CON.jar", sha512: sha }]);
    expect(status).toMatchObject({ updateAvailable: false, problem: "UNSAFE_INSTALLED_PATH", file: null });
    expect(ExtensionUpdateStatus.safeParse({ ...toContractUpdateStatus(status!, "2f0b1e3c-4d5a-4b6c-8d7e-9f0a1b2c3d4e"), path: "plugins/CON.jar" }).success).toBe(true);
  });
});

// --- R2-10 ------------------------------------------------------------------------------------

describe("R2-10 list overflow, IP canonicalisation, nested device names", () => {
  it("`list` output is not cut at 1000; overflow and invalid names are counted", () => {
    const names = [...Array.from({ length: 1005 }, (_, i) => `p${i}`), "@a", "../x"];
    const out = parsePlayerListOutput([`[19:00:00] [Server thread/INFO]: There are 1007 of a max of 2000 players online: ${names.join(", ")}`])!;
    expect(out.players).toHaveLength(1005);
    expect(out.skipped).toBe(2);
    const contract = toContractPlayersOverview({ online: { source: "list", output: out, at: 1 }, onlineMode: true, whitelistEnabled: null, whitelistEnforced: null, lists: {}, availableActions: [], now: new Date() });
    expect(contract.online).toMatchObject({ count: 1007, skipped: 7 });
    expect(contract.online.players).toHaveLength(1000);
  });

  it("banned-ips rows are canonicalised; a stored spelling the server cannot match is noted", () => {
    const doc = parsePlayerList("banned-ips", JSON.stringify([{ ip: "::ffff:203.0.113.7", created: "2026-10-12 19:30:00 +0000", source: "x", expires: "forever", reason: null }]));
    expect(doc.entries[0]!.ip).toBe("203.0.113.7");
    expect(doc.issues).toEqual(['entry 1: ip stored as "::ffff:203.0.113.7"; the server only matches the exact text 203.0.113.7']);
    expect(removeFromPlayerList(doc, "203.0.113.7").removed).toBe(1);
  });

  it.each(["META-INF/jars/CON.jar", "CON/x.jar", "META-INF/nul.txt/x.jar", "META-INF/jars/com1.foo.jar", "META-INF/jars/.x.jar"])("nested jar %s is unsafe", (p) => {
    expect(isSafeNestedJarPath(p)).toBe(false);
  });
  it("ordinary nested jars stay safe", () => {
    expect(isSafeNestedJarPath("META-INF/jars/fabric-permissions-api-0.3.1.jar")).toBe(true);
    expect(isSafeNestedJarPath("META-INF/jars/console-1.0.jar")).toBe(true);
  });
});
