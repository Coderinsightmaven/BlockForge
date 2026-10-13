import { createHash } from "node:crypto";
import {
  CompleteExtensionUploadResponse,
  ExtensionHistoryPage,
  ExtensionList,
  ExtensionUpdatesResponse,
  ExtensionUploadResponse,
  InstalledExtension,
  ModrinthInstallPlan,
  ModrinthProjectResponse,
  ModrinthSearchResult,
  RemoveExtensionResponse,
  UpdateExtensionResponse,
} from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { FakeUpstreams } from "../support/modrinth.js";
import { catalogOptions, connectSimNode, paperRequest, poll, publicLookup, templateIdByKey, waitJob, type SimNodeHandle } from "../support/panel.js";
import { UiSocket } from "../support/realtime-client.js";
import { makeJar, makeZip } from "../support/zip.js";
import { startHttpsUpstream, type HttpsUpstream } from "../support/https-upstream.js";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
const sockets: UiSocket[] = [];
const httpsServers: HttpsUpstream[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const s of httpsServers.splice(0)) await s.close();
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

const pluginYml = (name: string, version: string, extra = "") => `name: ${name}\nversion: ${version}\nmain: com.example.${name.toLowerCase()}.Main\napi-version: '1.21'\n${extra}`;
const pluginJar = (name: string, version: string, extra = "") => makeJar({ "plugin.yml": pluginYml(name, version, extra) });
const fabricJar = (id: string) => makeJar({ "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id, version: "1.0.0", environment: "*", entrypoints: { main: ["com.example.Main"] } }) });
const sha512 = (b: Buffer) => createHash("sha512").update(b).digest("hex");

/**
 * `realTransport`: Modrinth/Mojang go through the production `createSafeFetch` + pinned HTTPS transport
 * to a local HTTPS server (test certificate, test-only override) that serves the same fake upstreams.
 */
async function boot(opts: { env?: Record<string, string>; realTransport?: boolean; limiterClock?: { now: number; slept: number[] } } = {}) {
  const up = new FakeUpstreams();
  // Deterministic rate-limit windows: the limiter's clock only moves when the limiter sleeps.
  const clock = opts.limiterClock;
  const limiter = clock ? { limiter: { now: () => clock.now, sleep: async (ms: number) => void ((clock.now += ms), clock.slept.push(ms)) } } : {};
  const cat = catalogOptions();
  let https: HttpsUpstream | null = null;
  if (opts.realTransport) {
    https = await startHttpsUpstream((url, init) => up.fetch(url, init));
    httpsServers.push(https);
  }
  const r = await startWithOwner({
    background: true,
    catalog: cat.catalog,
    env: { SCHEDULER_INTERVAL_MS: "300000", ...(opts.env ?? {}) },
    serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 },
    upstream: https ? { lookup: publicLookup, testOverride: https.override, ...limiter } : { fetchImpl: up.fetch, lookup: publicLookup, ...limiter },
  });
  t = r.t;
  const node = await connectSimNode(r.t, r.owner, { agents });
  up.attach(node.sim);
  // Synthetic Modrinth projects: AlphaLib (a library) and BetaPlug (requires AlphaLib).
  up.addProject({ id: "AlphaLib", slug: "alphalib", title: "Alpha Lib", type: "plugin", loaders: ["paper", "spigot", "bukkit"] });
  up.addVersion("AlphaLib", { id: "AlphaV10", number: "1.0.0", filename: "AlphaLib-1.0.0.jar", jar: pluginJar("AlphaLib", "1.0.0") });
  up.addProject({ id: "BetaPlug", slug: "betaplug", title: "Beta Plug", type: "plugin", loaders: ["paper", "spigot", "bukkit"] });
  up.addVersion("BetaPlug", {
    id: "BetaV100",
    number: "1.0.0",
    filename: "BetaPlug-1.0.0.jar",
    jar: pluginJar("BetaPlug", "1.0.0", "depend: [AlphaLib]\n"),
    dependencies: [{ project_id: "AlphaLib", version_id: null, dependency_type: "required" }],
  });
  return { ...r, node, up, https };
}

async function paperServer(owner: ApiClient, over: Record<string, unknown> = {}): Promise<string> {
  const created = await owner.post("/servers", paperRequest(await templateIdByKey(owner, "minecraft-java"), { startup: "manual", ...over }));
  expect(created.statusCode, created.body).toBe(202);
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  return created.json().server.id as string;
}

const list = async (c: ApiClient, id: string) => ExtensionList.parse((await c.get(`/servers/${id}/extensions`)).json());
async function scanned(c: ApiClient, owner: ApiClient, id: string, full = false): Promise<ExtensionList> {
  const r = await c.post(`/servers/${id}/extensions/scan`, { full });
  expect(r.statusCode, r.body).toBe(202);
  expect((await waitJob(owner, r.json().jobId)).status).toBe("succeeded");
  return list(c, id);
}
const byName = (l: ExtensionList, filename: string) => l.items.find((x) => x.filename === filename);
const cmds = (node: SimNodeHandle, type: string, from = 0) => node.agent.commands.slice(from).filter((c) => c.type === type);
const history = async (c: ApiClient, id: string, q = "") => ExtensionHistoryPage.parse((await c.get(`/servers/${id}/extensions/history${q}`)).json());

describe("extension scans", () => {
  it("scans plugins/ on first open, reads only changed files, identifies Modrinth jars and keeps ids across renames", async () => {
    const { t, owner, node, up } = await boot();
    const id = await paperServer(owner);
    const alpha = up.projects.get("AlphaLib")!.versions[0]!;
    node.sim.put(id, "plugins/AlphaLib-1.0.0.jar", alpha.jar);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "2.3"));
    node.sim.put(id, "plugins/broken.jar", "this is not a zip");
    node.sim.put(id, "plugins/twice.jar", makeZip([{ name: "plugin.yml", data: pluginYml("A", "1") }, { name: "plugin.yml", data: pluginYml("B", "1") }]));
    node.sim.put(id, "plugins/old.jar.disabled", pluginJar("Old", "0.1"));
    node.sim.put(id, "plugins/fabric-only.jar", fabricJar("fabriconly"));
    node.sim.put(id, "plugins/empty.jar", "");
    node.sim.link(id, "plugins/link.jar", "custom.jar");
    node.sim.put(id, "plugins/readme.txt", "not a jar");
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    await ui.subscribe(`server:${id}`);

    // First open: scan.status "never" → a scan starts automatically.
    const first = await list(owner, id);
    expect(first).toMatchObject({ installDir: "plugins", kind: "plugin", scan: { status: "running" } });
    expect((await waitJob(owner, first.scan.jobId!)).status).toBe("succeeded");
    const l = await list(owner, id);
    expect(l.scan).toMatchObject({ status: "completed", error: null });
    expect(l.items.map((x) => x.filename).sort()).toEqual(["AlphaLib-1.0.0.jar", "broken.jar", "custom.jar", "fabric-only.jar", "old.jar.disabled", "twice.jar"]);
    expect(l.skipped.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "empty.jar", reason: "empty" },
      { name: "link.jar", reason: "symlink" },
    ]);
    expect(byName(l, "AlphaLib-1.0.0.jar")).toMatchObject({
      source: "modrinth",
      enabled: true,
      sha512: alpha.sha512,
      modrinth: { projectId: "AlphaLib", versionId: "AlphaV10", versionNumber: "1.0.0", slug: "alphalib", pageUrl: "https://modrinth.com/project/alphalib" },
      compatibility: { loadable: true, metadataIndex: 0 },
      installedAt: null,
    });
    expect(byName(l, "custom.jar")).toMatchObject({ source: "unknown", modrinth: null, metadata: [{ format: "bukkit", name: "Custom", version: "2.3" }], compatibility: { loadable: true } });
    expect(byName(l, "broken.jar")!.compatibility).toMatchObject({ loadable: false, problems: [{ code: "METADATA_INVALID", level: "error" }] });
    expect(byName(l, "twice.jar")!.compatibility).toMatchObject({ loadable: false, problems: [{ code: "METADATA_INVALID", message: expect.stringContaining("more than once") }] });
    expect(byName(l, "fabric-only.jar")!.compatibility).toMatchObject({ loadable: false, problems: [expect.objectContaining({ code: "WRONG_PLATFORM" })] });
    expect(byName(l, "old.jar.disabled")).toMatchObject({ enabled: false, path: "plugins/old.jar.disabled" });
    await ui.waitForEvent(`server:${id}`, "extensions.updated", 5000, (d) => (d as { scan: { status: string } }).scan.status === "completed");
    expect(ui.invalid).toEqual([]);
    // The sim answered per file through the contract shapes (fs.hash sha1+sha512, jar.readEntries with the metadata entries).
    const hashCmd = cmds(node, "fs.hash")[0]!;
    expect(hashCmd.payload).toMatchObject({ algorithms: ["sha1", "sha512"] });
    expect((hashCmd.payload as { paths: string[] }).paths).not.toContain("plugins/empty.jar");
    expect((cmds(node, "jar.readEntries")[0]!.payload as { entries: string[] }).entries).toContain("paper-plugin.yml");

    // Incremental: nothing changed → no hashing/reading at all.
    const mark = node.agent.commands.length;
    await scanned(owner, owner, id);
    expect(cmds(node, "fs.hash", mark)).toEqual([]);
    expect(cmds(node, "jar.readEntries", mark)).toEqual([]);
    // One changed file → only that one is re-read.
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "2.4"));
    const mark2 = node.agent.commands.length;
    const l2 = await scanned(owner, owner, id);
    expect(cmds(node, "fs.hash", mark2).flatMap((c) => (c.payload as { paths: string[] }).paths)).toEqual(["plugins/custom.jar"]);
    expect(byName(l2, "custom.jar")!.metadata[0]!.version).toBe("2.4");
    // Renamed outside BlockForge (same bytes) → same id; full scan re-reads everything.
    const customId = byName(l2, "custom.jar")!.id;
    const bytes = node.sim.files(id).get("plugins/custom.jar")!.data;
    node.sim.files(id).delete("plugins/custom.jar");
    node.sim.put(id, "plugins/custom-renamed.jar", bytes);
    const l3 = await scanned(owner, owner, id);
    expect(byName(l3, "custom-renamed.jar")!.id).toBe(customId);
    expect(byName(l3, "custom.jar")).toBeUndefined();
    const mark3 = node.agent.commands.length;
    await scanned(owner, owner, id, true);
    expect(cmds(node, "fs.hash", mark3).flatMap((c) => (c.payload as { paths: string[] }).paths)).toHaveLength(6);
    // Deleted outside BlockForge → row removed.
    node.sim.files(id).delete("plugins/broken.jar");
    expect(byName(await scanned(owner, owner, id), "broken.jar")).toBeUndefined();
    expect(InstalledExtension.parse((await owner.get(`/servers/${id}/extensions/${customId}`)).json()).path).toBe("plugins/custom-renamed.jar");
    expect((await owner.get(`/servers/${id}/extensions/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
    expect(up.misses).toEqual([]);
  });

  it("checks read/manage permissions, filters extensions.updated per subscriber and refuses unsupported software", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "1"));
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    const sub = await owner.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view"] });
    expect(sub.statusCode, sub.body).toBe(201);
    expect((await bob.get(`/servers/${id}/extensions`)).statusCode).toBe(403);
    // bob (servers.view only) is subscribed to server:<id> but never receives extensions.updated.
    const bobUi = await UiSocket.open(t, bob);
    sockets.push(bobUi);
    expect((await bobUi.subscribe(`server:${id}`)).op).toBe("subscribed");
    const ownerUi = await UiSocket.open(t, owner);
    sockets.push(ownerUi);
    await ownerUi.subscribe(`server:${id}`);
    await scanned(owner, owner, id);
    await ownerUi.waitForEvent(`server:${id}`, "extensions.updated", 5000);
    await new Promise((r) => setTimeout(r, 200));
    expect(bobUi.frames.some((f) => f.op === "event" && f.type === "extensions.updated")).toBe(false);

    await owner.put(`/servers/${id}/subusers/${sub.json().id}`, { permissions: ["servers.view", "servers.extensions.view"] });
    expect((await bob.get(`/servers/${id}/extensions`)).statusCode).toBe(200);
    const ext = (await list(bob, id)).items[0]!;
    expect((await bob.post(`/servers/${id}/extensions/scan`, {})).statusCode).toBe(403);
    expect((await bob.patch(`/servers/${id}/extensions/${ext.id}`, { enabled: false })).statusCode).toBe(403);
    expect((await bob.delete(`/servers/${id}/extensions/${ext.id}`)).statusCode).toBe(403);
    expect((await bob.post(`/servers/${id}/extensions/uploads`, { filename: "x.jar", sizeBytes: 10 })).statusCode).toBe(403);
    await scanned(owner, owner, id, true);
    await bobUi.waitForEvent(`server:${id}`, "extensions.updated", 5000);

    // Vanilla: no install dir; every other route is 422 unsupported_software.
    const vanilla = await paperServer(owner, { minecraft: { software: "vanilla", version: "1.21.11", acceptEula: true } });
    expect(await list(owner, vanilla)).toMatchObject({ installDir: null, kind: null, items: [] });
    const r = await owner.post(`/servers/${vanilla}/extensions/scan`, {});
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: "PRECONDITION_FAILED", details: { reason: "unsupported_software" } });
    expect((await owner.get(`/servers/${vanilla}/extensions/modrinth/search?query=x`)).statusCode).toBe(422);
    void node;
  });
});

describe("Modrinth browsing and install plans", () => {
  it("searches and shows projects (recorded Modrinth fixtures), plans with dependencies and maps rate limits to 429", async () => {
    // Injected limiter clock/sleep: no wall-clock dependence (this test once failed in a loaded parallel run).
    const limiterClock = { now: Date.parse("2026-10-12T12:00:00Z"), slept: [] as number[] };
    const { owner, up } = await boot({ limiterClock });
    const id = await paperServer(owner);
    const s = await owner.get(`/servers/${id}/extensions/modrinth/search?query=luckperms&limit=5`);
    expect(s.statusCode, s.body).toBe(200);
    const result = ModrinthSearchResult.parse(s.json());
    expect(result.hits.some((h) => h.slug === "luckperms" && h.installed === false && h.loaderMatch === "match")).toBe(true);
    expect(up.calls.at(-1)!.userAgent).toMatch(/^BlockForge\/\d+\.\d+\.\d+ \(.+\)$/);
    const p = await owner.get(`/servers/${id}/extensions/modrinth/projects/luckperms`);
    expect(p.statusCode, p.body).toBe(200);
    const project = ModrinthProjectResponse.parse(p.json());
    expect(project.project).toMatchObject({ slug: "luckperms", compatible: true });
    expect(project.versions.length).toBeGreaterThan(0);
    expect(project.versions[0]).toMatchObject({ loaderMatch: "match", gameVersionMatch: true });
    const lp = await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "luckperms" });
    expect(lp.statusCode, lp.body).toBe(200);
    expect(ModrinthInstallPlan.parse(lp.json())).toMatchObject({ installable: true, installDir: "plugins", root: { slug: "luckperms" }, restartRequired: false });
    expect(up.misses).toEqual([]);

    // Synthetic project with a required dependency: dependency first; allowPrerelease defaults to false.
    const plan = ModrinthInstallPlan.parse((await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "betaplug" })).json());
    expect(plan.files.map((f) => [f.projectId, f.versionId, f.action, f.reason, f.destPath])).toEqual([
      ["AlphaLib", "AlphaV10", "install", "dependency", "plugins/AlphaLib-1.0.0.jar"],
      ["BetaPlug", "BetaV100", "install", "requested", "plugins/BetaPlug-1.0.0.jar"],
    ]);
    up.addVersion("BetaPlug", { id: "BetaB200", number: "2.0.0-beta", type: "beta", filename: "BetaPlug-2.0.0-beta.jar", jar: pluginJar("BetaPlug", "2.0.0-beta") });
    expect(ModrinthInstallPlan.parse((await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "betaplug" })).json()).root.versionId).toBe("BetaV100");
    expect((await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "betaplug", unknown: 1 })).statusCode).toBe(400);
    expect((await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "nosuchproject" })).statusCode).toBe(404);
    // The project's version list follows the installer's rules: prereleases only on request.
    up.addProject({ id: "PrePlug", slug: "preplug", title: "Pre Plug", type: "plugin", loaders: ["paper"] });
    up.addVersion("PrePlug", { id: "PreV1000", number: "1.0.0", filename: "Pre-1.0.0.jar", jar: pluginJar("Pre", "1.0.0") });
    up.addVersion("PrePlug", { id: "PreB2000", number: "2.0.0-beta", type: "beta", filename: "Pre-2.0.0-beta.jar", jar: pluginJar("Pre", "2.0.0-beta") });
    const rel = ModrinthProjectResponse.parse((await owner.get(`/servers/${id}/extensions/modrinth/projects/preplug`)).json());
    expect(rel.versions.map((v) => v.versionId)).toEqual(["PreV1000"]);
    const pre = ModrinthProjectResponse.parse((await owner.get(`/servers/${id}/extensions/modrinth/projects/preplug?allowPrerelease=true`)).json());
    expect(pre.versions.map((v) => v.versionId).sort()).toEqual(["PreB2000", "PreV1000"]);

    // Rate limit: Modrinth says the window is used up for 60 s → the shared limiter refuses (no 2 s+ waits).
    // (Fresh projects: Modrinth responses are cached for 10 minutes.)
    up.addProject({ id: "RateOne", slug: "rateone", title: "Rate One", type: "plugin", loaders: ["paper"] });
    up.rateLimit = { remaining: 0, resetSeconds: 60 };
    // The project request succeeds and reports an exhausted window; the version-list request is refused.
    const limited = await owner.get(`/servers/${id}/extensions/modrinth/projects/rateone`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: "RATE_LIMITED", details: { upstream: "modrinth", retryAfterMs: expect.any(Number), retryAfterSeconds: expect.any(Number) } });
    expect(limited.json().error.details.retryAfterMs).toBeGreaterThan(2000);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(2);
    // The window is exactly Modrinth's 60 s (fixed clock), and nothing waited for real.
    expect(limited.json().error.details.retryAfterMs).toBe(60_000);
    expect(limiterClock.slept).toEqual([]);
  });
});

describe("installs, updates, removal and rollback", () => {
  it("installs with a re-plan (409 plan_changed), idempotency, the job lock and undo on failure", async () => {
    const { t, owner, node, up } = await boot();
    const id = await paperServer(owner);
    await list(owner, id);
    const plan = ModrinthInstallPlan.parse((await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "betaplug" })).json());
    const stale = plan.files.map((f) => ({ projectId: f.projectId, versionId: f.versionId, action: f.action }));
    expect(stale.map((f) => f.projectId)).toEqual(["AlphaLib", "BetaPlug"]);
    await poll(async () => (await list(owner, id)).scan.status === "completed");
    // Meanwhile AlphaLib was put on the server (file manager): the fresh plan differs → 409 with it, nothing touched.
    node.sim.put(id, "plugins/AlphaLib-1.0.0.jar", up.projects.get("AlphaLib")!.versions[0]!.jar);
    await scanned(owner, owner, id);
    const before = node.sim.fetched.length;
    const changed = await owner.post(`/servers/${id}/extensions/modrinth/install`, { project: "betaplug", expect: stale });
    expect(changed.statusCode).toBe(409);
    const fresh = ModrinthInstallPlan.parse(changed.json().error.details.plan);
    expect(changed.json().error.details.reason).toBe("plan_changed");
    expect(fresh.files.map((f) => f.projectId)).toEqual(["BetaPlug"]);
    expect(node.sim.fetched.length).toBe(before);
    const expectFiles = fresh.files.map((f) => ({ projectId: f.projectId, versionId: f.versionId, action: f.action }));
    const headers = { "idempotency-key": "install-beta-1" };
    const r = await owner.post(`/servers/${id}/extensions/modrinth/install`, { project: "betaplug", expect: expectFiles }, headers);
    expect(r.statusCode, r.body).toBe(202);
    const replay = await owner.post(`/servers/${id}/extensions/modrinth/install`, { project: "betaplug", expect: expectFiles }, headers);
    expect(replay.json().jobId).toBe(r.json().jobId);
    expect((await waitJob(owner, r.json().jobId)).status).toBe("succeeded");
    const l = await list(owner, id);
    const ownerId = (await owner.get("/auth/me")).json().user.id as string;
    expect(byName(l, "BetaPlug-1.0.0.jar")).toMatchObject({ source: "modrinth", installedBy: { id: ownerId, name: "owner" }, installedAt: expect.any(Number), compatibility: { loadable: true } });
    expect(byName(l, "AlphaLib-1.0.0.jar")).toMatchObject({ source: "modrinth", installedBy: null, installedAt: null });
    expect(byName(l, "BetaPlug-1.0.0.jar")!.modrinth).toMatchObject({ projectId: "BetaPlug", versionId: "BetaV100", slug: "betaplug" });
    // Downloaded to a temporary name, then renamed into place without overwriting (review round 2, item 6).
    expect(node.sim.fetched.slice(before).map((f) => f.destPath)).toEqual([expect.stringMatching(/^\.blockforge\/extensions\/fetch\/[0-9a-f-]{36}\.jar$/)]);
    expect(node.sim.files(id).get("plugins/BetaPlug-1.0.0.jar")!.data.equals(up.projects.get("BetaPlug")!.versions[0]!.jar)).toBe(true);
    expect([...node.sim.files(id).keys()].filter((k) => k.startsWith(".blockforge/extensions/fetch/"))).toEqual([]);
    expect((cmds(node, "artifact.fetch").at(-1)!.payload as { checksum: { algorithm: string; value: string } }).checksum).toEqual({ algorithm: "sha512", value: up.projects.get("BetaPlug")!.versions[0]!.sha512 });
    const h = await history(owner, id);
    expect(h.items.map((e) => [e.action, e.status, e.path])).toEqual([["install", "succeeded", "plugins/BetaPlug-1.0.0.jar"]]);
    expect(h.items[0]).toMatchObject({ actor: { type: "user", id: ownerId }, from: null, to: { source: "modrinth", versionId: "BetaV100" }, rollback: { available: true } });
    const { rows: audit } = await testPool().query("SELECT action FROM audit_events WHERE action LIKE 'server.extension.%' ORDER BY id");
    expect(audit.map((a) => a.action)).toContain("server.extension.install");


    // Failure after the first file: the dependency fetched before is removed again, history records the failure.
    up.addProject({ id: "DeltaLib", slug: "deltalib", title: "Delta Lib", type: "plugin", loaders: ["paper"] });
    up.addVersion("DeltaLib", { id: "DeltaV10", number: "1.0", filename: "DeltaLib-1.0.jar", jar: pluginJar("DeltaLib", "1.0") });
    up.addProject({ id: "GammaPl", slug: "gammapl", title: "Gamma", type: "plugin", loaders: ["paper"] });
    const gamma = up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0"), dependencies: [{ project_id: "DeltaLib", version_id: null, dependency_type: "required" }] });
    node.sim.artifacts.set(gamma.url, Buffer.from("tampered on the CDN"));
    const gPlan = ModrinthInstallPlan.parse((await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "gammapl" })).json());
    const g = await owner.post(`/servers/${id}/extensions/modrinth/install`, { project: "gammapl", expect: gPlan.files.map((f) => ({ projectId: f.projectId, versionId: f.versionId, action: f.action })) });
    const gj = await waitJob(owner, g.json().jobId);
    expect(gj.status).toBe("failed");
    expect(gj.error).toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(node.sim.read(id, "plugins/DeltaLib-1.0.jar")).toBeNull();
    expect(node.sim.read(id, "plugins/Gamma-1.0.jar")).toBeNull();
    const failed = (await history(owner, id)).items[0]!;
    expect(failed).toMatchObject({ action: "install", status: "failed", path: "plugins/DeltaLib-1.0.jar", rollback: { available: false, reason: "failed_entry" } });
    const rb = await owner.post(`/servers/${id}/extensions/history/${failed.id}/rollback`);
    expect(rb.statusCode).toBe(409);
    expect(rb.json().error.details).toEqual({ reason: "rollback_unavailable", cause: "failed_entry" });

    // One extension job per server: a slow install holds the lock.
    node.sim.options = { delay: { "artifact.fetch": 1500 } };
    const dPlan = ModrinthInstallPlan.parse((await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "deltalib" })).json());
    const slow = await owner.post(`/servers/${id}/extensions/modrinth/install`, { project: "deltalib", expect: dPlan.files.map((f) => ({ projectId: f.projectId, versionId: f.versionId, action: f.action })) });
    expect(slow.statusCode).toBe(202);
    const busy = await owner.post(`/servers/${id}/extensions/scan`, {});
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.details).toEqual({ reason: "extension_job_running" });
    const beta = byName(l, "BetaPlug-1.0.0.jar")!;
    expect((await owner.patch(`/servers/${id}/extensions/${beta.id}`, { enabled: false })).json().error.details).toEqual({ reason: "extension_job_running" });
    expect((await waitJob(owner, slow.json().jobId)).status).toBe("succeeded");
    node.sim.options = {};

    // A running server: changes need a restart (never hot-reloaded).
    const start = await owner.post(`/servers/${id}/actions`, { action: "start" });
    expect((await waitJob(owner, start.json().jobId)).status).toBe("succeeded");
    const toggled = UpdateExtensionResponse.parse((await owner.patch(`/servers/${id}/extensions/${beta.id}`, { enabled: false })).json());
    expect(toggled).toMatchObject({ restartRequired: true, extension: { enabled: false, path: "plugins/BetaPlug-1.0.0.jar.disabled" } });
    void t;
  });

  it("checks and applies updates (old jar kept), rolls back from Modrinth and from the keep area, enable/disable/remove", async () => {
    const { owner, node, up } = await boot();
    const id = await paperServer(owner);
    const v1 = up.projects.get("AlphaLib")!.versions[0]!;
    node.sim.put(id, "plugins/AlphaLib-1.0.0.jar", v1.jar);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "1.0"));
    let l = await scanned(owner, owner, id);
    const alpha = byName(l, "AlphaLib-1.0.0.jar")!;
    const custom = byName(l, "custom.jar")!;
    const v2 = up.addVersion("AlphaLib", { id: "AlphaV20", number: "2.0.0", filename: "AlphaLib-2.0.0.jar", jar: pluginJar("AlphaLib", "2.0.0") });
    up.addVersion("AlphaLib", { id: "AlphaB30", number: "3.0.0-beta", type: "beta", filename: "AlphaLib-3.0.0-beta.jar", jar: pluginJar("AlphaLib", "3.0.0-beta") });

    // Updates: never a less stable type unless allowPrerelease.
    const u = ExtensionUpdatesResponse.parse((await owner.get(`/servers/${id}/extensions/updates`)).json());
    expect(u.items.find((x) => x.extensionId === alpha.id)).toMatchObject({
      updateAvailable: true,
      current: { versionId: "AlphaV10" },
      latest: { versionId: "AlphaV20", versionType: "release" },
      file: { action: "replace", destPath: "plugins/AlphaLib-2.0.0.jar", replaces: ["plugins/AlphaLib-1.0.0.jar"], sha512: v2.sha512 },
      problem: null,
    });
    expect(u.items.find((x) => x.extensionId === custom.id)).toMatchObject({ current: null, updateAvailable: false });
    expect(ExtensionUpdatesResponse.parse((await owner.get(`/servers/${id}/extensions/updates?allowPrerelease=true`)).json()).items.find((x) => x.extensionId === alpha.id)!.latest!.versionId).toBe("AlphaB30");
    const apply = await owner.post(`/servers/${id}/extensions/updates/apply`, { extensionIds: [alpha.id, custom.id] });
    expect(apply.statusCode, apply.body).toBe(202);
    const aj = await waitJob(owner, apply.json().jobId);
    expect(aj.status).toBe("succeeded");
    expect((aj.result as { results: unknown[] }).results).toEqual(
      expect.arrayContaining([
        { extensionId: alpha.id, status: "updated", versionId: "AlphaV20", error: null },
        expect.objectContaining({ extensionId: custom.id, status: "failed" }),
      ]),
    );
    l = await list(owner, id);
    expect(byName(l, "AlphaLib-1.0.0.jar")).toBeUndefined();
    expect(byName(l, "AlphaLib-2.0.0.jar")).toMatchObject({ source: "modrinth", modrinth: { versionId: "AlphaV20" } });
    const upd = (await history(owner, id)).items[0]!;
    expect(upd).toMatchObject({ action: "update", from: { versionId: "AlphaV10", path: "plugins/AlphaLib-1.0.0.jar" }, to: { versionId: "AlphaV20" }, rollback: { available: true } });
    expect(node.sim.read(id, `.blockforge/extensions/kept/${upd.id}.jar`)).not.toBeNull();

    // Rollback of the update: v1 is fetched again by version id (SHA-512 verified), v2 goes to the keep area.
    const rb = await owner.post(`/servers/${id}/extensions/history/${upd.id}/rollback`, {}, { "idempotency-key": "rb-1" });
    expect(rb.statusCode, rb.body).toBe(202);
    expect((await waitJob(owner, rb.json().jobId)).status).toBe("succeeded");
    expect(node.sim.files(id).get("plugins/AlphaLib-1.0.0.jar")!.data.equals(v1.jar)).toBe(true);
    expect(node.sim.read(id, "plugins/AlphaLib-2.0.0.jar")).toBeNull();
    const h = await history(owner, id);
    expect(h.items[0]).toMatchObject({ action: "rollback", from: { versionId: "AlphaV20" }, to: { versionId: "AlphaV10" } });
    expect(h.items.find((e) => e.id === upd.id)!.rollback).toEqual({ available: false, reason: "superseded" });

    // Enable/disable (rename in place, same id; not rolled back through history).
    const off = UpdateExtensionResponse.parse((await owner.patch(`/servers/${id}/extensions/${custom.id}`, { enabled: false })).json());
    expect(off).toMatchObject({ restartRequired: false, extension: { id: custom.id, enabled: false, path: "plugins/custom.jar.disabled", filename: "custom.jar.disabled" } });
    expect(node.sim.read(id, "plugins/custom.jar.disabled")).not.toBeNull();
    const disableEntry = (await history(owner, id)).items[0]!;
    expect(disableEntry).toMatchObject({ action: "disable", rollback: { available: false, reason: "not_supported" } });
    expect((await owner.patch(`/servers/${id}/extensions/${custom.id}`, { enabled: true })).json().extension.path).toBe("plugins/custom.jar");
    expect((await owner.patch(`/servers/${id}/extensions/${custom.id}`, { enabled: true })).json().restartRequired).toBe(false);

    // Remove: kept for rollback; rollback restores it (sha512 re-checked); a second rollback is superseded.
    const rm = RemoveExtensionResponse.parse((await owner.delete(`/servers/${id}/extensions/${custom.id}`)).json());
    expect(rm).toMatchObject({ restartRequired: false, rollbackAvailable: true });
    expect(node.sim.read(id, "plugins/custom.jar")).toBeNull();
    expect(node.sim.read(id, `.blockforge/extensions/kept/${rm.historyEntryId}.jar`)).not.toBeNull();
    expect(byName(await list(owner, id), "custom.jar")).toBeUndefined();
    const back = await owner.post(`/servers/${id}/extensions/history/${rm.historyEntryId}/rollback`);
    expect((await waitJob(owner, back.json().jobId)).status).toBe("succeeded");
    expect(node.sim.read(id, "plugins/custom.jar")).not.toBeNull();
    expect(byName(await list(owner, id), "custom.jar")).toMatchObject({ source: "unknown", metadata: [{ name: "Custom" }] });
    const again = await owner.post(`/servers/${id}/extensions/history/${rm.historyEntryId}/rollback`);
    expect(again.json().error.details).toEqual({ reason: "rollback_unavailable", cause: "superseded" });

    // A kept file that changed is not restored (file_unavailable).
    const restored = byName(await list(owner, id), "custom.jar")!;
    const rm2 = RemoveExtensionResponse.parse((await owner.delete(`/servers/${id}/extensions/${restored.id}`)).json());
    node.sim.put(id, `.blockforge/extensions/kept/${rm2.historyEntryId}.jar`, "swapped");
    const tampered = await owner.post(`/servers/${id}/extensions/history/${rm2.historyEntryId}/rollback`);
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().error.details).toEqual({ reason: "rollback_unavailable", cause: "file_unavailable" });

    // History is paginated, newest first, and filterable by extension.
    const p1 = await history(owner, id, "?limit=2");
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await history(owner, id, `?limit=50&cursor=${encodeURIComponent(p1.nextCursor!)}`);
    expect(new Set([...p1.items, ...p2.items].map((e) => e.id)).size).toBe(p1.items.length + p2.items.length);
    expect((await history(owner, id, `?extensionId=${custom.id}`)).items.every((e) => e.extensionId === custom.id)).toBe(true);
  });
});

describe("extension uploads", () => {
  async function upload(t: TestApp, c: ApiClient, id: string, filename: string, bytes: Buffer, announced = bytes.length) {
    const r = await c.post(`/servers/${id}/extensions/uploads`, { filename, sizeBytes: announced });
    if (r.statusCode !== 200) return { create: r, uploadId: null as string | null };
    const u = ExtensionUploadResponse.parse(r.json());
    const put = await t.app.inject({ method: "PUT", url: u.url, headers: { cookie: c.cookieHeader(), "content-type": "application/octet-stream" }, payload: bytes });
    expect(put.statusCode, put.body).toBe(200);
    return { create: r, uploadId: u.uploadId };
  }
  const complete = (c: ApiClient, id: string, uploadId: string, body: Record<string, unknown> = {}) => c.post(`/servers/${id}/extensions/uploads/${uploadId}/complete`, body);

  it("stages uploads outside plugins/, validates them (policy, jar, metadata, compatibility, size, name) and installs them", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    await list(owner, id);
    await poll(async () => (await list(owner, id)).scan.status === "completed");

    // Policy: disabled → 422 uploads_disabled.
    expect((await owner.put("/settings/extensions.uploads", { value: { allowed: false, requireMetadata: true } })).statusCode).toBe(200);
    const off = await owner.post(`/servers/${id}/extensions/uploads`, { filename: "x.jar", sizeBytes: 10 });
    expect(off.statusCode).toBe(422);
    expect(off.json().error.details).toMatchObject({ reason: "uploads_disabled" });
    await owner.put("/settings/extensions.uploads", { value: { allowed: true, requireMetadata: true } });
    expect((await owner.post(`/servers/${id}/extensions/uploads`, { filename: "../evil.jar", sizeBytes: 10 })).statusCode).toBe(400);
    expect((await owner.post(`/servers/${id}/extensions/uploads`, { filename: "CON.jar", sizeBytes: 10 })).statusCode).toBe(400);

    // Happy path: staged under .blockforge/extensions/uploads, then renamed into plugins/.
    const jar = pluginJar("Uploaded", "1.0");
    const a = await upload(t, owner, id, "Uploaded.jar", jar);
    expect(node.sim.files(id).get(`.blockforge/extensions/uploads/${a.uploadId}.jar.part`)?.data.equals(jar)).toBe(true);
    const done = await complete(owner, id, a.uploadId!);
    expect(done.statusCode, done.body).toBe(200);
    const res = CompleteExtensionUploadResponse.parse(done.json());
    expect(res).toMatchObject({ extension: { source: "upload", path: "plugins/Uploaded.jar", sha512: sha512(jar), installedBy: { name: "owner" } }, compatibility: { loadable: true }, warnings: [], restartRequired: false });
    expect(node.sim.read(id, `.blockforge/extensions/uploads/${a.uploadId}.jar.part`)).toBeNull();
    expect(node.sim.files(id).get("plugins/Uploaded.jar")?.data.equals(jar)).toBe(true);
    // Completion is idempotent per upload id.
    expect(CompleteExtensionUploadResponse.parse((await complete(owner, id, a.uploadId!)).json()).extension.id).toBe(res.extension.id);

    const reject = async (bytes: Buffer, name: string, body: Record<string, unknown> = {}, announced?: number) => {
      const u = await upload(t, owner, id, name, bytes, announced);
      return { uploadId: u.uploadId!, r: await complete(owner, id, u.uploadId!, body) };
    };
    const notZip = await reject(Buffer.from("plain text, no zip"), "text.jar");
    expect(notZip.r.statusCode).toBe(422);
    expect(notZip.r.json().error.details).toMatchObject({ reason: "not_a_jar", compatibility: null });
    const bare = await reject(makeZip([{ name: "README.md", data: "hi" }]), "bare.jar");
    expect(bare.r.json().error.details).toMatchObject({ reason: "no_metadata" });
    const fab = await reject(fabricJar("fabmod"), "fabmod.jar");
    expect(fab.r.statusCode).toBe(422);
    expect(fab.r.json().error.details).toMatchObject({ reason: "incompatible", compatibility: { loadable: false, problems: [expect.objectContaining({ code: "WRONG_PLATFORM" })] } });
    // The staged file stays: the same upload can be completed with the override.
    const forced = CompleteExtensionUploadResponse.parse((await complete(owner, id, fab.uploadId, { allowIncompatible: true })).json());
    expect(forced.warnings.map((w) => w.code)).toEqual(["INCOMPATIBLE_ALLOWED"]);
    const short = await reject(jar, "short.jar", {}, jar.length + 10);
    expect(short.r.json().error.details).toMatchObject({ reason: "size_mismatch" });
    expect((await complete(owner, id, short.uploadId, { unknown: true })).statusCode).toBe(400);

    // Same name: 409 exists, then replaceExisting keeps the old jar for rollback.
    const v2 = pluginJar("Uploaded", "2.0");
    const dup = await reject(v2, "Uploaded.jar");
    expect(dup.r.statusCode).toBe(409);
    expect(dup.r.json().error.details).toMatchObject({ reason: "exists", existing: { extensionId: res.extension.id, path: "plugins/Uploaded.jar" } });
    const replaced = CompleteExtensionUploadResponse.parse((await complete(owner, id, dup.uploadId, { replaceExisting: true })).json());
    expect(replaced.extension).toMatchObject({ id: res.extension.id, sha512: sha512(v2) });
    expect(replaced.warnings.map((w) => w.code)).toEqual(["REPLACED_EXISTING"]);
    const entry = (await history(owner, id)).items[0]!;
    expect(entry).toMatchObject({ action: "upload", from: { sha512: sha512(jar) }, to: { sha512: sha512(v2) }, rollback: { available: true } });
    // Same plugin name under another file name: DUPLICATE_ID warning.
    const twin = await reject(pluginJar("Uploaded", "9"), "Uploaded-copy.jar");
    expect(CompleteExtensionUploadResponse.parse(twin.r.json()).warnings.map((w) => w.code)).toEqual(["DUPLICATE_ID"]);
    // Rolling back the upload of a new file (`from: null`) removes it (into the keep area).
    const twinEntry = (await history(owner, id)).items[0]!;
    expect(twinEntry).toMatchObject({ action: "upload", from: null, path: "plugins/Uploaded-copy.jar", rollback: { available: true } });
    const undo = await owner.post(`/servers/${id}/extensions/history/${twinEntry.id}/rollback`);
    expect((await waitJob(owner, undo.json().jobId)).status).toBe("succeeded");
    expect(node.sim.read(id, "plugins/Uploaded-copy.jar")).toBeNull();
    expect(byName(await list(owner, id), "Uploaded-copy.jar")).toBeUndefined();
    const undoEntry = (await history(owner, id)).items[0]!;
    expect(undoEntry).toMatchObject({ action: "rollback", from: { path: "plugins/Uploaded-copy.jar" }, to: null, rollback: { available: true } });
    expect(node.sim.read(id, `.blockforge/extensions/kept/${undoEntry.id}.jar`)).not.toBeNull();
    // Rolling back the replacing upload restores the kept jar.
    const rb = await owner.post(`/servers/${id}/extensions/history/${entry.id}/rollback`);
    expect((await waitJob(owner, rb.json().jobId)).status).toBe("succeeded");
    expect(node.sim.files(id).get("plugins/Uploaded.jar")?.data.equals(jar)).toBe(true);
    const { rows } = await testPool().query("SELECT action FROM audit_events WHERE action LIKE 'server.extension.upload%' ORDER BY id");
    expect(rows.map((r) => r.action)).toContain("server.extension.upload.complete");
  });

  it("refuses extension work on an agent without fs.hash / jar.readEntries", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    t.ctx.gateway.session(node.nodeId)!.capabilities = ["docker"];
    const r = await owner.post(`/servers/${id}/extensions/scan`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: "INVALID_STATE", details: { reason: "agent_outdated", missingCapabilities: ["fs.hash", "jar.readEntries", "artifact.fetch"] } });
    expect((await list(owner, id)).scan.status).toBe("never");
  });
});

describe("sim agent fs.hash / jar.readEntries (contract shapes, per-file outcomes, budgets)", () => {
  it("answers per file and per jar exactly as the protocol describes", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    const jar = pluginJar("Sim", "1.0");
    node.sim.put(id, "plugins/a.jar", jar);
    node.sim.put(id, "plugins/b.jar", pluginJar("Other", "2.0"));
    node.sim.put(id, "plugins/big.jar", makeJar({ "plugin.yml": pluginYml("Big", "1", `description: '${"x".repeat(4000)}'\n`) }));
    node.sim.put(id, "plugins/crc.jar", makeZip([{ name: "plugin.yml", data: pluginYml("C", "1"), corruptCrc: true }]));
    node.sim.put(id, "plugins/bzip.jar", makeZip([{ name: "plugin.yml", data: pluginYml("C", "1"), rawMethod: 12 }]));
    node.sim.put(id, "plugins/dup.jar", makeZip([{ name: "plugin.yml", data: "a: 1" }, { name: "plugin.yml", data: "b: 2" }]));
    node.sim.put(id, "plugins/ctl.jar", makeZip([{ name: "plugin.yml", data: "name: A\u0001B\tC" }]));
    node.sim.link(id, "plugins/link.jar", "a.jar");
    node.sim.link(id, "linked", "plugins");
    const send = <T extends "fs.hash" | "jar.readEntries">(type: T, payload: Record<string, unknown>) => t.ctx.gateway.send(node.nodeId, type, { workloadId: id, ...payload } as never, { timeoutMs: 10_000 });

    const h = await send("fs.hash", { paths: ["plugins/a.jar", "plugins/link.jar", "linked/a.jar", "nope.jar", "plugins", "plugins/b.jar"], algorithms: ["sha512"], maxBytesPerFile: 2 * 1024 ** 3 });
    expect(h.files.map((f) => (f.ok ? "ok" : f.error))).toEqual(["ok", "NOT_REGULAR", "NOT_REGULAR", "NOT_FOUND", "NOT_REGULAR", "ok"]);
    expect(h.files[0]).toMatchObject({ path: "plugins/a.jar", sizeBytes: jar.length, sha512: sha512(jar) });
    expect(h.files[0]).not.toHaveProperty("sha1");
    const small = await send("fs.hash", { paths: ["plugins/a.jar", "plugins/b.jar"], algorithms: ["sha1"], maxBytesPerFile: 10 });
    expect(small.files.map((f) => (f.ok ? "ok" : f.error))).toEqual(["TOO_LARGE", "TOO_LARGE"]);
    const budget = await send("fs.hash", { paths: ["plugins/a.jar", "plugins/b.jar", "plugins/a.jar"], algorithms: ["sha1"], maxBytesPerFile: 1_000_000, maxTotalBytes: jar.length + 1 });
    expect(budget.files.map((f) => (f.ok ? "ok" : f.error))).toEqual(["ok", "BUDGET_EXCEEDED", "BUDGET_EXCEEDED"]);
    node.sim.options = { ioErrorPaths: ["plugins/b.jar"] };
    expect((await send("fs.hash", { paths: ["plugins/b.jar"], algorithms: ["sha1"], maxBytesPerFile: 1_000_000 })).files[0]).toEqual({ ok: false, path: "plugins/b.jar", error: "IO_ERROR" });
    node.sim.options = {};

    const r = await send("jar.readEntries", {
      paths: ["plugins/a.jar", "plugins/crc.jar", "plugins/bzip.jar", "plugins/dup.jar", "plugins/ctl.jar", "plugins/link.jar", "linked/a.jar"],
      entries: ["plugin.yml", "fabric.mod.json"],
      maxEntryBytes: 256 * 1024,
      maxJarBytes: 1_000_000,
      hash: ["sha512"],
    });
    expect(r.jars.map((j) => (j.ok ? "ok" : j.error))).toEqual(["ok", "NOT_A_ZIP", "NOT_A_ZIP", "AMBIGUOUS_ENTRY", "ok", "NOT_REGULAR", "NOT_REGULAR"]);
    expect(r.jars[0]).toMatchObject({ ok: true, sha512: sha512(jar), missing: ["fabric.mod.json"], entries: [{ name: "plugin.yml", truncated: false, content: pluginYml("Sim", "1.0") }] });
    expect(r.jars[4]).toMatchObject({ entries: [{ content: "name: A\ufffdB\tC" }] });
    // Truncation: the JSON string literal as sent (quotes included) stays within maxEntryBytes.
    const cut = await send("jar.readEntries", { paths: ["plugins/big.jar"], entries: ["plugin.yml"], maxEntryBytes: 100, maxJarBytes: 1_000_000 });
    const e = cut.jars[0]!;
    expect(e.ok && e.entries[0]!.truncated).toBe(true);
    expect(e.ok && Buffer.byteLength(JSON.stringify(e.entries[0]!.content))).toBeLessThanOrEqual(100);
    // Budget: the first jar always comes back; the rest is BUDGET_EXCEEDED.
    const b = await send("jar.readEntries", { paths: ["plugins/big.jar", "plugins/a.jar", "plugins/b.jar"], entries: ["plugin.yml"], maxEntryBytes: 256 * 1024, maxJarBytes: 1_000_000, maxTotalBytes: 1000 });
    expect(b.jars.map((j) => (j.ok ? "ok" : j.error))).toEqual(["ok", "BUDGET_EXCEEDED", "BUDGET_EXCEEDED"]);
    expect((await send("jar.readEntries", { paths: ["plugins/a.jar"], entries: ["plugin.yml"], maxEntryBytes: 1_000_000, maxJarBytes: 1 }).catch((err: unknown) => err)) as Error).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("scans retry BUDGET_EXCEEDED files in follow-up commands (never failures)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    for (const n of ["a", "b", "c", "d"]) node.sim.put(id, `plugins/${n}.jar`, pluginJar(n.toUpperCase(), "1.0"));
    node.sim.options = { budgets: { hashBytes: 1, jarBytes: 1 } };
    const mark = node.agent.commands.length;
    const l = await scanned(owner, owner, id);
    expect(l.items.map((x) => [x.filename, x.sha512 !== null, x.compatibility?.loadable])).toEqual([
      ["a.jar", true, true],
      ["b.jar", true, true],
      ["c.jar", true, true],
      ["d.jar", true, true],
    ]);
    expect(cmds(node, "fs.hash", mark)).toHaveLength(4);
    expect(cmds(node, "jar.readEntries", mark)).toHaveLength(4);
  });

  it("prunes kept jars (30 days / 20 per server), expired uploads and year-old history", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "1.0"));
    const ext = (await scanned(owner, owner, id)).items[0]!;
    const rm = RemoveExtensionResponse.parse((await owner.delete(`/servers/${id}/extensions/${ext.id}`)).json());
    const kept = `.blockforge/extensions/kept/${rm.historyEntryId}.jar`;
    expect(node.sim.read(id, kept)).not.toBeNull();
    const u = ExtensionUploadResponse.parse((await owner.post(`/servers/${id}/extensions/uploads`, { filename: "late.jar", sizeBytes: 3 })).json());
    await t.app.inject({ method: "PUT", url: u.url, headers: { cookie: owner.cookieHeader(), "content-type": "application/octet-stream" }, payload: Buffer.from("abc") });
    expect(node.sim.read(id, `.blockforge/extensions/uploads/${u.uploadId}.jar.part`)).toBe("abc");

    await testPool().query("UPDATE extension_history SET kept_until = now() - interval '1 minute' WHERE id = $1", [rm.historyEntryId]);
    await testPool().query("UPDATE extension_uploads SET expires_at = now() - interval '1 minute' WHERE id = $1", [u.uploadId]);
    await t.tasks.maintenance!.runNow();
    expect(node.sim.read(id, kept)).toBeNull();
    expect(node.sim.read(id, `.blockforge/extensions/uploads/${u.uploadId}.jar.part`)).toBeNull();
    const entry = (await history(owner, id)).items.find((e) => e.id === rm.historyEntryId)!;
    expect(entry.rollback).toEqual({ available: false, reason: "file_unavailable" });
    expect((await owner.post(`/servers/${id}/extensions/uploads/${u.uploadId}/complete`, {})).statusCode).toBe(404);
    await testPool().query("UPDATE extension_history SET at = now() - interval '400 days'");
    await t.tasks.maintenance!.runNow();
    expect((await history(owner, id)).items).toEqual([]);
  });
});

describe("Modrinth and Mojang over the real pinned transport", () => {
  it("identifies jars (POST /version_files), finds updates (POST /version_files/update), plans and looks up players end to end", async () => {
    const { owner, node, up, https } = await boot({ realTransport: true });
    const id = await paperServer(owner);
    const v1 = up.projects.get("AlphaLib")!.versions[0]!;
    node.sim.put(id, "plugins/AlphaLib-1.0.0.jar", v1.jar);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "1.0"));
    const l = await scanned(owner, owner, id);
    expect(byName(l, "AlphaLib-1.0.0.jar")).toMatchObject({ source: "modrinth", modrinth: { projectId: "AlphaLib", versionId: "AlphaV10", slug: "alphalib", title: "Alpha Lib" } });
    expect(byName(l, "custom.jar")).toMatchObject({ source: "unknown", modrinth: null });
    up.addVersion("AlphaLib", { id: "AlphaV20", number: "2.0.0", filename: "AlphaLib-2.0.0.jar", jar: pluginJar("AlphaLib", "2.0.0") });
    const u = await owner.get(`/servers/${id}/extensions/updates`);
    expect(u.statusCode, u.body).toBe(200);
    expect(ExtensionUpdatesResponse.parse(u.json()).items.find((x) => x.path === "plugins/AlphaLib-1.0.0.jar")).toMatchObject({ updateAvailable: true, latest: { versionId: "AlphaV20" } });
    const plan = await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "betaplug" });
    expect(plan.statusCode, plan.body).toBe(200);
    expect(ModrinthInstallPlan.parse(plan.json()).root.versionId).toBe("BetaV100");
    const lookup = await owner.get(`/servers/${id}/players/lookup?name=Notch`);
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json()).toMatchObject({ name: "Notch", source: "mojang" });

    // What went over the wire: real POSTs with JSON bodies, Content-Type and the BlockForge User-Agent.
    const posts = https!.requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => new URL(r.url).pathname)).toEqual(expect.arrayContaining(["/v2/version_files", "/v2/version_files/update"]));
    for (const p of posts) {
      expect(p.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(p.body)).toMatchObject({ hashes: expect.any(Array), algorithm: "sha512" });
    }
    for (const r of https!.requests) expect(r.headers["user-agent"]).toMatch(/^BlockForge\/\d+\.\d+\.\d+ \(.+\)$/);
    expect(https!.requests.some((r) => r.url.startsWith("https://api.mojang.com/users/profiles/minecraft/"))).toBe(true);
    expect(up.misses).toEqual([]);
  });
});
