import { readFileSync } from "node:fs";
import { PlayerActionResult, PlayerLookupResponse, PlayerSessionPage, PlayersOverview } from "@blockforge/contracts";
import { offlinePlayerUuid } from "@blockforge/minecraft";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { FakeUpstreams } from "../support/modrinth.js";
import { catalogOptions, connectSimNode, paperRequest, poll, publicLookup, templateIdByKey, waitJob, type SimNodeHandle } from "../support/panel.js";
import { UiSocket } from "../support/realtime-client.js";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
const sockets: UiSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

const fixture = (name: string) => readFileSync(new URL(`../../../../packages/minecraft/test/fixtures/players/${name}`, import.meta.url), "utf8");
const NOTCH = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
const STEVE_UUID = "8667ba71-b85a-4004-af54-457a9734eed7";
const info = (msg: string) => `[12:00:00 INFO]: ${msg}`;
const PROPS = (o: Record<string, string> = {}) =>
  Object.entries({ "online-mode": "true", "white-list": "true", "enforce-whitelist": "false", motd: "A Minecraft Server", ...o })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

async function boot() {
  const up = new FakeUpstreams();
  const cat = catalogOptions();
  const r = await startWithOwner({
    background: true,
    catalog: cat.catalog,
    env: { SCHEDULER_INTERVAL_MS: "300000" },
    serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 },
    upstream: { fetchImpl: up.fetch, lookup: publicLookup },
    players: { feedbackTimeoutMs: 600 },
  });
  t = r.t;
  const node = await connectSimNode(r.t, r.owner, { agents });
  return { ...r, node, up };
}

async function paperServer(owner: ApiClient, node: SimNodeHandle, over: Record<string, unknown> = {}): Promise<string> {
  const created = await owner.post("/servers", paperRequest(await templateIdByKey(owner, "minecraft-java"), over));
  expect(created.statusCode, created.body).toBe(202);
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  const id = created.json().server.id as string;
  node.sim.put(id, "server.properties", PROPS());
  return id;
}

const overview = async (c: ApiClient, id: string) => {
  const r = await c.get(`/servers/${id}/players`);
  expect(r.statusCode, r.body).toBe(200);
  return PlayersOverview.parse(r.json());
};
const act = (c: ApiClient, id: string, body: Record<string, unknown>) => c.post(`/servers/${id}/players/actions`, body);
const state = async (c: ApiClient, id: string) => (await c.get(`/servers/${id}`)).json().state as string;
async function stop(owner: ApiClient, id: string) {
  const r = await owner.post(`/servers/${id}/actions`, { action: "stop" });
  expect((await waitJob(owner, r.json().jobId)).status).toBe("succeeded");
}

describe("players overview", () => {
  it("reads the four lists and server.properties, the online list from `list uuids` (SLP fallback), with errors reported", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.put(id, "whitelist.json", fixture("gson-whitelist.json"));
    node.sim.put(id, "ops.json", fixture("gson-ops.json"));
    node.sim.put(id, "banned-players.json", fixture("gson-banned-players.json"));
    node.sim.put(id, "banned-ips.json", "{ not json");
    node.sim.options = { consoleReplies: { "list uuids": [info(`There are 1 of a max of 20 players online: Steve (${STEVE_UUID})`)] } };
    const o = await overview(owner, id);
    expect(o.online).toMatchObject({ count: 1, max: 20, players: [{ name: "Steve", uuid: STEVE_UUID }], source: "list", skipped: 0 });
    expect(o).toMatchObject({ onlineMode: true, whitelist: { enabled: true, enforced: false }, truncated: [] });
    expect(o.whitelist.entries.length).toBeGreaterThan(0);
    expect(o.ops.length).toBeGreaterThan(0);
    expect(o.bannedPlayers.length).toBeGreaterThan(0);
    expect(o.bannedIps).toEqual([]);
    // The unreadable file is reported (invalid entries of other files may be listed too).
    expect(o.listErrors).toEqual(expect.arrayContaining([expect.objectContaining({ file: "banned-ips.json", message: expect.stringContaining("not valid JSON") })]));
    expect(o.availableActions).toEqual(["kick", "ban", "pardon", "ban-ip", "pardon-ip", "op", "deop", "whitelist-add", "whitelist-remove", "whitelist-set", "whitelist-reload"]);

    // No answer to `list`: the latest Server List Ping sample (may be partial).
    node.sim.options = {};
    node.sim.sendSlp(id);
    await poll(async () => t!.ctx.latest.getWorkload(id)?.minecraft !== undefined);
    expect((await overview(owner, id)).online).toMatchObject({ source: "slp" });

    // Stopped: nothing online is known; file actions only.
    await stop(owner, id);
    const s = await overview(owner, id);
    expect(s.online).toEqual({ count: null, max: null, players: [], skipped: 0, source: null, at: null });
    expect(s.availableActions).toEqual(["ban", "pardon", "ban-ip", "pardon-ip", "op", "deop", "whitelist-add", "whitelist-remove", "whitelist-set"]);
    // Missing files are empty lists, never errors.
    node.sim.files(id).delete("banned-ips.json");
    expect((await overview(owner, id)).listErrors.filter((e) => e.file === "banned-ips.json")).toEqual([]);
  });

  it("checks permissions and refuses Velocity actions", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner, node, { startup: "manual" });
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    const sub = await owner.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view"] });
    expect((await bob.get(`/servers/${id}/players`)).statusCode).toBe(403);
    expect((await bob.get(`/servers/${id}/players/sessions`)).statusCode).toBe(403);
    await owner.put(`/servers/${id}/subusers/${sub.json().id}`, { permissions: ["servers.view", "servers.players.view"] });
    expect((await bob.get(`/servers/${id}/players`)).statusCode).toBe(200);
    expect((await act(bob, id, { action: "whitelist-add", name: "Notch" })).statusCode).toBe(403);
    // players.manage without console.send: list edits yes, op/deop no (operator escalation).
    await owner.put(`/servers/${id}/subusers/${sub.json().id}`, { permissions: ["servers.view", "servers.players.view", "servers.players.manage"] });
    expect((await act(bob, id, { action: "whitelist-add", name: "Notch" })).statusCode).toBe(200);
    const op = await act(bob, id, { action: "op", name: "Notch" });
    expect(op.statusCode).toBe(403);
    expect(op.json().error.message).toContain("servers.console.send");
    await owner.put(`/servers/${id}/subusers/${sub.json().id}`, { permissions: ["servers.view", "servers.players.view", "servers.players.manage", "servers.console.send"] });
    expect((await act(bob, id, { action: "op", name: "Notch" })).statusCode).toBe(200);
    // Strict bodies and validated names/IPs; reasons are single-line.
    expect((await act(owner, id, { action: "kick", name: "Steve", reason: "Bye\u2028now" })).statusCode).toBe(400);
    expect((await act(owner, id, { action: "ban", name: "Notch", expires: 1 })).statusCode).toBe(400);
    expect((await act(owner, id, { action: "ban", name: "@a" })).statusCode).toBe(400);
    expect((await act(owner, id, { action: "ban-ip", ip: "::1" })).statusCode).toBe(400);

    node.sim.options = { readyLine: "[12:00:00 INFO]: Done (1.0s)!" };
    const velocity = await owner.post("/servers", {
      name: "Proxy",
      slug: "proxy-p",
      templateId: await templateIdByKey(owner, "velocity"),
      placement: { mode: "auto" },
      memoryLimitBytes: 1024 ** 3,
      minecraft: { software: "velocity", version: "4.2.0" },
    });
    expect((await waitJob(owner, velocity.json().jobId)).status).toBe("succeeded");
    const vid = velocity.json().server.id as string;
    expect((await overview(owner, vid)).availableActions).toEqual([]);
    const v = await act(owner, vid, { action: "whitelist-add", name: "Notch" });
    expect(v.statusCode).toBe(422);
    expect(v.json().error).toMatchObject({ code: "PRECONDITION_FAILED", details: { reason: "unsupported_software" } });
  });
});

describe("player actions", () => {
  it("on a running server: console command + the server's own feedback (forged feedback ignored, 504 without feedback)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.options = {
      consoleReplies: {
        "whitelist add Notch": [info("Added Notch to the whitelist")],
        "op Notch": [info("Made Notch a server operator")],
        "kick Steve Bye now": [info("Kicked Steve: Bye now")],
        "whitelist on": [info("Whitelist is now turned on")],
        "whitelist add Nobody": [info("That player does not exist")],
        "ban-ip 203.0.113.7 spam": [info("Banned IP 203.0.113.7: spam")],
        // A mod logging the expected text through its own logger is not the server's feedback.
        "whitelist add Alex": ["[12:00:00] [Server thread/INFO] [EvilMod]: Added Alex to the whitelist", "[12:00:00 INFO]: <Alex> Added Alex to the whitelist"],
      },
    };
    const ok = PlayerActionResult.parse((await act(owner, id, { action: "whitelist-add", name: "Notch" })).json());
    expect(ok).toEqual({ applied: "console", feedback: { ok: true, message: "Added Notch to the whitelist" }, overview: null });
    expect(node.sim.consoleLines.filter((l) => l.workloadId === id).map((l) => l.line)).toContain("whitelist add Notch");
    expect(PlayerActionResult.parse((await act(owner, id, { action: "op", name: "Notch" })).json()).feedback).toEqual({ ok: true, message: "Made Notch a server operator" });
    expect(PlayerActionResult.parse((await act(owner, id, { action: "kick", name: "Steve", reason: "Bye now" })).json()).feedback!.ok).toBe(true);
    expect(PlayerActionResult.parse((await act(owner, id, { action: "whitelist-set", enabled: true })).json()).feedback).toEqual({ ok: true, message: "Whitelist is now turned on" });
    expect(PlayerActionResult.parse((await act(owner, id, { action: "whitelist-add", name: "Nobody" })).json()).feedback).toEqual({ ok: false, message: "That player does not exist" });
    expect(PlayerActionResult.parse((await act(owner, id, { action: "ban-ip", ip: "203.0.113.7", reason: "spam" })).json()).feedback!.ok).toBe(true);
    const forged = await act(owner, id, { action: "whitelist-add", name: "Alex" });
    expect(forged.statusCode).toBe(504);
    expect(forged.json().error).toMatchObject({ code: "UPSTREAM_ERROR", details: { reason: "no_feedback", sent: true } });
    // The console cannot express expiry or operator level/bypass.
    for (const body of [
      { action: "ban", name: "Notch", expiresAt: Date.now() + 86_400_000 },
      { action: "op", name: "Notch", level: 2 },
      { action: "op", name: "Notch", bypassesPlayerLimit: true },
    ]) {
      const r = await act(owner, id, body);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatchObject({ code: "INVALID_STATE", details: { reason: "requires_stopped" } });
    }
    const { rows } = await testPool().query("SELECT action FROM audit_events WHERE action LIKE 'server.players.%' ORDER BY id");
    expect(rows.map((r) => r.action)).toEqual(["server.players.whitelist-add", "server.players.op", "server.players.kick", "server.players.whitelist-set", "server.players.whitelist-add", "server.players.ban-ip"]);
  });

  it("on a stopped server: atomic list/properties edits with Mojang (online mode) or offline UUIDs; lookup", async () => {
    const { owner, node, up } = await boot();
    const id = await paperServer(owner, node, { startup: "manual" });
    expect(await state(owner, id)).toBe("stopped");
    for (const action of [{ action: "kick", name: "Notch" }, { action: "whitelist-reload" }]) {
      const r = await act(owner, id, action);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.details).toEqual({ reason: "not_running" });
    }
    // Lookup (online mode → Mojang, recorded profile; unknown → 404; throttled → 429).
    expect(PlayerLookupResponse.parse((await owner.get(`/servers/${id}/players/lookup?name=notch`)).json())).toEqual({ name: "Notch", uuid: NOTCH, source: "mojang" });
    expect((await owner.get(`/servers/${id}/players/lookup?name=bf_nobody_x`)).statusCode).toBe(404);
    expect((await owner.get(`/servers/${id}/players/lookup?name=not%20valid`)).statusCode).toBe(400);

    const wl = PlayerActionResult.parse((await act(owner, id, { action: "whitelist-add", name: "Notch" })).json());
    expect(wl.applied).toBe("file");
    expect(wl.overview!.whitelist.entries).toEqual([{ uuid: NOTCH, name: "Notch" }]);
    expect(JSON.parse(node.sim.read(id, "whitelist.json")!)).toEqual([{ uuid: NOTCH, name: "Notch" }]);
    const expires = Date.now() + 7 * 86_400_000;
    const ban = PlayerActionResult.parse((await act(owner, id, { action: "ban", name: "Notch", reason: "griefing", expiresAt: expires })).json());
    expect(ban.overview!.bannedPlayers[0]).toMatchObject({ uuid: NOTCH, name: "Notch", reason: "griefing", active: true, source: "BlockForge (owner)" });
    expect(Math.abs(ban.overview!.bannedPlayers[0]!.expiresAt! - expires)).toBeLessThan(2000);
    const op = PlayerActionResult.parse((await act(owner, id, { action: "op", name: "Notch", level: 2, bypassesPlayerLimit: true })).json());
    expect(op.overview!.ops).toEqual([{ uuid: NOTCH, name: "Notch", level: 2, bypassesPlayerLimit: true }]);
    await act(owner, id, { action: "ban-ip", ip: "203.0.113.7" });
    expect(JSON.parse(node.sim.read(id, "banned-ips.json")!)[0]).toMatchObject({ ip: "203.0.113.7", expires: "forever" });
    const off = PlayerActionResult.parse((await act(owner, id, { action: "whitelist-set", enabled: false })).json());
    expect(off.overview!.whitelist.enabled).toBe(false);
    expect(node.sim.read(id, "server.properties")).toContain("white-list=false");
    expect(node.sim.read(id, "server.properties")).toContain("motd=A Minecraft Server");
    for (const body of [{ action: "deop", name: "Notch" }, { action: "pardon", name: "notch" }, { action: "pardon-ip", ip: "203.0.113.7" }, { action: "whitelist-remove", name: "Notch" }]) {
      expect((await act(owner, id, body)).statusCode).toBe(200);
    }
    const after = await overview(owner, id);
    expect([after.ops, after.bannedPlayers, after.bannedIps, after.whitelist.entries]).toEqual([[], [], [], []]);

    // Unknown premium name → 404; Mojang throttling → 429 (upstream mojang).
    expect((await act(owner, id, { action: "whitelist-add", name: "bf_nobody_y" })).statusCode).toBe(404);
    up.mojang429 = true;
    const limited = await act(owner, id, { action: "whitelist-add", name: "Someone" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: "RATE_LIMITED", details: { upstream: "mojang", retryAfterMs: expect.any(Number) } });
    up.mojang429 = false;

    // Offline mode: the server's offline UUID, no Mojang request.
    node.sim.put(id, "server.properties", PROPS({ "online-mode": "false" }));
    const calls = up.calls.length;
    await act(owner, id, { action: "whitelist-add", name: "Steve" });
    expect(JSON.parse(node.sim.read(id, "whitelist.json")!)).toEqual([{ uuid: offlinePlayerUuid("Steve"), name: "Steve" }]);
    expect(PlayerLookupResponse.parse((await owner.get(`/servers/${id}/players/lookup?name=Steve`)).json())).toEqual({ name: "Steve", uuid: offlinePlayerUuid("Steve"), source: "offline" });
    expect(up.calls.length).toBe(calls);
  });
});

describe("player sessions", () => {
  it("tracks join/leave from the server's own console lines (forged lines ignored), closes sessions on stop and `list`, filters realtime", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner, node);
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    await owner.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view"] });
    const ownerUi = await UiSocket.open(t, owner);
    const bobUi = await UiSocket.open(t, bob);
    sockets.push(ownerUi, bobUi);
    await ownerUi.subscribe(`server:${id}`);
    expect((await bobUi.subscribe(`server:${id}`)).op).toBe("subscribed");
    const log = (...lines: string[]) => node.agent.logs(id, lines.map((line) => ({ ts: Date.now(), stream: "stdout", line })));
    const sessions = async (q = "") => PlayerSessionPage.parse((await owner.get(`/servers/${id}/players/sessions${q}`)).json());

    log(
      info(`UUID of player Steve is ${STEVE_UUID}`),
      info("Steve joined the game"),
      "[12:00:00] [Server thread/INFO] [EvilMod]: Alex joined the game",
      info("<Mallory> Alex joined the game"),
      "Alex joined the game",
    );
    const joined = await ownerUi.waitForEvent(`server:${id}`, "player.joined", 5000);
    expect(joined.data).toMatchObject({ serverId: id, name: "Steve", uuid: STEVE_UUID, sessionId: expect.any(String) });
    await t.ctx.playerSessions.idle();
    expect((await sessions()).items).toEqual([expect.objectContaining({ name: "Steve", uuid: STEVE_UUID, leftAt: null })]);

    log(info("Steve lost connection: Disconnected"), info("Steve left the game"));
    const left = await ownerUi.waitForEvent(`server:${id}`, "player.left", 5000);
    expect(left.data).toMatchObject({ name: "Steve", reason: "Disconnected" });
    await t.ctx.playerSessions.idle();
    expect((await sessions()).items[0]).toMatchObject({ name: "Steve", leftAt: expect.any(Number), leaveReason: "Disconnected" });
    // bob (no servers.players.view) never sees player events on the same topic.
    await new Promise((r) => setTimeout(r, 200));
    expect(bobUi.frames.some((f) => f.op === "event" && (f.type === "player.joined" || f.type === "player.left"))).toBe(false);
    expect(ownerUi.invalid).toEqual([]);

    // A complete `list` closes sessions of players no longer online.
    log(info("Alex joined the game"), info("Carl joined the game"));
    await poll(async () => (await sessions()).items.filter((s) => s.leftAt === null).length === 2);
    node.sim.options = { consoleReplies: { "list uuids": [info("There are 1 of a max of 20 players online: Alex (11111111-2222-3333-4444-555555555555)")] } };
    await overview(owner, id);
    await t.ctx.playerSessions.idle();
    const open = (await sessions()).items.filter((s) => s.leftAt === null).map((s) => s.name);
    expect(open).toEqual(["Alex"]);
    // Stopping the server closes the rest with leaveReason null.
    await stop(owner, id);
    await t.ctx.playerSessions.idle();
    await poll(async () => (await sessions()).items.every((s) => s.leftAt !== null));
    expect((await sessions("?name=alex")).items[0]).toMatchObject({ name: "Alex", leaveReason: null });
    const page = await sessions("?limit=1");
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect((await sessions(`?limit=10&cursor=${encodeURIComponent(page.nextCursor!)}`)).items).toHaveLength(2);
    // Retention: 90 days.
    await testPool().query("UPDATE player_sessions SET joined_at = now() - interval '91 days' WHERE lower(name) = 'carl'");
    await t.ctx.playerSessions.prune();
    expect((await sessions()).items.map((s) => s.name).sort()).toEqual(["Alex", "Steve"]);
  });
});
