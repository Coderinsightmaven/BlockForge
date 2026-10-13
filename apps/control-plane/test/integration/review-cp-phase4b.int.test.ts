import { PlayerActionResult, PlayerLookupResponse } from "@blockforge/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { FakeUpstreams } from "../support/modrinth.js";
import { catalogOptions, connectSimNode, paperRequest, publicLookup, templateIdByKey, waitJob, type SimNodeHandle } from "../support/panel.js";
import { UiSocket } from "../support/realtime-client.js";

/**
 * Regression tests for the Grok review of the control plane Phase 4b
 * (docs/reviews/2026-10-12-control-plane-phase4b.md): #4 player action feedback, #8 Mojang
 * Retry-After + shared limiter, L5 audited op/deop 403, L1 realtime delivery after permission changes
 * (also unit-tested in test/unit/server-events.test.ts).
 */

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
const sockets: UiSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

const NOTCH = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
const info = (msg: string) => `[12:00:00 INFO]: ${msg}`;
const PROPS = "online-mode=true\nwhite-list=true\nenforce-whitelist=false\nmotd=A Minecraft Server";
const FEEDBACK_TIMEOUT_MS = 1000;
const LINGER_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const up = new FakeUpstreams();
  const cat = catalogOptions();
  // Limiter clock: fixed unless a limiter sleeps (deterministic Retry-After windows).
  const clock = { now: Date.parse("2026-10-12T12:00:00Z"), slept: [] as number[] };
  const r = await startWithOwner({
    background: true,
    catalog: cat.catalog,
    env: { SCHEDULER_INTERVAL_MS: "300000" },
    serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 },
    upstream: { fetchImpl: up.fetch, lookup: publicLookup, limiter: { now: () => clock.now, sleep: async (ms) => void ((clock.now += ms), clock.slept.push(ms)) } },
    players: { feedbackTimeoutMs: FEEDBACK_TIMEOUT_MS, commandLingerMs: LINGER_MS },
  });
  t = r.t;
  const node = await connectSimNode(r.t, r.owner, { agents });
  return { ...r, node, up, clock };
}

async function paperServer(owner: ApiClient, node: SimNodeHandle, over: Record<string, unknown> = {}): Promise<string> {
  const created = await owner.post("/servers", paperRequest(await templateIdByKey(owner, "minecraft-java"), over));
  expect(created.statusCode, created.body).toBe(202);
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  const id = created.json().server.id as string;
  node.sim.put(id, "server.properties", PROPS);
  return id;
}

const act = (c: ApiClient, id: string, body: Record<string, unknown>) => c.post(`/servers/${id}/players/actions`, body);
const feedback = (r: LightMyRequestResponse | { statusCode: number; body: string; json(): unknown }) => {
  expect(r.statusCode, r.body).toBe(200);
  return PlayerActionResult.parse(r.json()).feedback;
};
const noFeedback = (r: { statusCode: number; body: string; json(): { error: unknown } }) => {
  expect(r.statusCode, r.body).toBe(504);
  expect(r.json().error).toMatchObject({ code: "UPSTREAM_ERROR", details: { reason: "no_feedback", sent: true } });
};

describe("#4 player action feedback must be about the requested target", () => {
  it("ignores success and failure lines about another player; a failure naming our target counts", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.options = {
      consoleReplies: {
        // Another operator's command answers first (1.12.2 wording names the player).
        "op Steve": [info("Could not op Alex"), info("Made Steve a server operator")],
        "deop Steve": [info("Made Alex no longer a server operator")],
        "ban Steve": [info("Could not ban player Alex")],
        "whitelist add Steve": [info("Could not add Alex to the whitelist")],
        "op Notch": [info("Could not op Notch")],
        "pardon notch": [info("Could not unban player Notch")],
      },
    };
    expect(feedback(await act(owner, id, { action: "op", name: "Steve" }))).toEqual({ ok: true, message: "Made Steve a server operator" });
    noFeedback(await act(owner, id, { action: "deop", name: "Steve" }));
    noFeedback(await act(owner, id, { action: "ban", name: "Steve" }));
    noFeedback(await act(owner, id, { action: "whitelist-add", name: "Steve" }));
    expect(feedback(await act(owner, id, { action: "op", name: "Notch" }))).toEqual({ ok: false, message: "Could not op Notch" });
    expect(feedback(await act(owner, id, { action: "pardon", name: "notch" }))).toEqual({ ok: false, message: "Could not unban player Notch" });
  });

  it("concurrent player actions each take their own feedback, even when the answers cross", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.options = {
      consoleReplies: { "op Steve": [info("Made Alex a server operator")], "op Alex": [info("Made Steve a server operator")] },
      consoleReplyDelayMs: 300,
    };
    const [steve, alex] = await Promise.all([act(owner, id, { action: "op", name: "Steve" }), act(owner, id, { action: "op", name: "Alex" })]);
    expect(feedback(steve)).toEqual({ ok: true, message: "Made Steve a server operator" });
    expect(feedback(alex)).toEqual({ ok: true, message: "Made Alex a server operator" });
  });

  it("target-less failures count only when no other command can be answering (else 504 no_feedback)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    const ALREADY = "Nothing changed. The player is already an operator";
    node.sim.options = {
      consoleReplies: {
        "op Notch": [info(ALREADY)],
        "kick Ghost": [info("No player was found")],
        "list uuids": [info("There are 0 of a max of 20 players online:")],
        "op Steve": [info(ALREADY)],
        "op Alex": [info("Made Alex a server operator")],
      },
      consoleReplyDelayMs: { "op Steve": 150, "op Alex": 500 },
    };
    // Alone: the failure is ours.
    expect(feedback(await act(owner, id, { action: "op", name: "Notch" }))).toEqual({ ok: false, message: ALREADY });
    expect(feedback(await act(owner, id, { action: "kick", name: "Ghost" }))).toEqual({ ok: false, message: "No player was found" });
    // The overview's `list uuids` cannot print such a failure: it does not make the next answer ambiguous.
    expect((await owner.get(`/servers/${id}/players`)).statusCode).toBe(200);
    expect(feedback(await act(owner, id, { action: "op", name: "Notch" }))).toEqual({ ok: false, message: ALREADY });

    // Someone typed a command into the console just before: its answer is unknown → 504.
    expect((await owner.post(`/servers/${id}/console`, { command: "say hi" })).statusCode).toBe(204);
    noFeedback(await act(owner, id, { action: "op", name: "Notch" }));
    noFeedback(await act(owner, id, { action: "kick", name: "Ghost" }));
    // Once nothing else can still be answering, target-less failures are attributable again.
    await sleep(LINGER_MS + 100);
    expect(feedback(await act(owner, id, { action: "op", name: "Notch" }))).toEqual({ ok: false, message: ALREADY });

    // Two player actions in flight: the target-less failure is nobody's; the named success is Alex's.
    const [steve, alex] = await Promise.all([act(owner, id, { action: "op", name: "Steve" }), act(owner, id, { action: "op", name: "Alex" })]);
    noFeedback(steve);
    expect(feedback(alex)).toEqual({ ok: true, message: "Made Alex a server operator" });
  });
});

describe("#4 round 2: target-less lines never end the wait; decided at the end of the window", () => {
  const ALREADY = "Nothing changed. The player is already an operator";

  it("a batch printing a target-less failure and then our named success → ok:true", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.options = { consoleReplies: { "op Steve": [info(ALREADY), info("Made Steve a server operator")] } };
    expect(feedback(await act(owner, id, { action: "op", name: "Steve" }))).toEqual({ ok: true, message: "Made Steve a server operator" });
  });

  it("a target-less failure alone, uncontended for the whole window → ok:false after the window (kick refusals too)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.options = { consoleReplies: { "op Notch": [info(ALREADY)], "kick Owner": [info("Cannot kick the server owner in a LAN game")] } };
    const started = Date.now();
    expect(feedback(await act(owner, id, { action: "op", name: "Notch" }))).toEqual({ ok: false, message: ALREADY });
    expect(Date.now() - started).toBeGreaterThanOrEqual(FEEDBACK_TIMEOUT_MS - 50);
    expect(feedback(await act(owner, id, { action: "kick", name: "Owner" }))).toEqual({ ok: false, message: "Cannot kick the server owner in a LAN game" });
  });

  it("a foreign command sent while we wait (after our target-less line) → 504; so does a second feedback line", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.options = { consoleReplies: { "op Notch": [info(ALREADY)], "op Alex": [info(ALREADY), info("Made Carl a server operator")], "whitelist on": [info("Whitelist is now turned on")] } };
    const pending = act(owner, id, { action: "op", name: "Notch" });
    await sleep(FEEDBACK_TIMEOUT_MS / 2);
    expect((await owner.post(`/servers/${id}/console`, { command: "say hi" })).statusCode).toBe(204);
    noFeedback(await pending);
    await sleep(LINGER_MS + 100);
    // Another command's named answer in the window: the target-less line is nobody's.
    noFeedback(await act(owner, id, { action: "op", name: "Alex" }));
    // Whitelist toggles are target-less by nature: the same rule.
    const toggle = act(owner, id, { action: "whitelist-set", enabled: true });
    await sleep(FEEDBACK_TIMEOUT_MS / 2);
    expect((await owner.post(`/servers/${id}/console`, { command: "say hi" })).statusCode).toBe(204);
    noFeedback(await toggle);
    await sleep(LINGER_MS + 100);
    expect(feedback(await act(owner, id, { action: "whitelist-set", enabled: true }))).toEqual({ ok: true, message: "Whitelist is now turned on" });
  });

  it("a save-all keeps the console contended until the save finished (late output after a long save → 504)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.options = { saveConfirm: false, consoleReplies: { "op Notch": [info(ALREADY)] } };
    expect((await owner.post(`/servers/${id}/console`, { command: "save-all flush" })).statusCode).toBe(204);
    await sleep(LINGER_MS + 100); // longer than the ordinary linger: the save is still running
    noFeedback(await act(owner, id, { action: "op", name: "Notch" }));
    node.agent.logs(id, [{ ts: Date.now(), stream: "stdout", line: info("Saved the game") }]);
    await sleep(LINGER_MS + 100);
    expect(feedback(await act(owner, id, { action: "op", name: "Notch" }))).toEqual({ ok: false, message: ALREADY });
  });

  it("the op broadcast of an in-game command is not feedback", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner, node);
    node.sim.options = { consoleReplies: { "op Steve": [info("System chat: [Alex: Made Steve a server operator]"), info("[Alex: Nothing changed. The player is already an operator]")] } };
    noFeedback(await act(owner, id, { action: "op", name: "Steve" }));
  });
});

describe("L1 player events follow permission changes at delivery time (real permissionsOf)", () => {
  it("role revocation, subuser removal and ownership transfer stop player.* events; suspension keeps .view ones", async () => {
    const { t, owner, node } = await boot();
    const frank = await createUserClient(t, owner, "frank@example.com", [{ roleKey: "observer", scopeType: "global", scopeId: null }]);
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    const dave = await createUserClient(t, owner, "dave@example.com", []);
    const erin = await createUserClient(t, owner, "erin@example.com", []);
    const idOf = async (c: ApiClient) => (await c.get("/auth/me")).json().user.id as string;
    const [frankId, daveId, ownerId] = [await idOf(frank), await idOf(dave), await idOf(owner)];
    const id = await paperServer(owner, node, { ownerId: daveId });
    const bobSub = await owner.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view", "servers.players.view"] });
    expect(bobSub.statusCode, bobSub.body).toBe(201);
    expect((await owner.post(`/servers/${id}/subusers`, { user: "erin", permissions: ["servers.view", "servers.players.view"] })).statusCode).toBe(201);
    const users = { owner, frank, bob, dave, erin };
    const ui: Record<string, UiSocket> = {};
    for (const [name, c] of Object.entries(users)) {
      ui[name] = await UiSocket.open(t, c);
      sockets.push(ui[name]);
      expect((await ui[name].subscribe(`server:${id}`)).op, name).toBe("subscribed");
    }
    const join = async (player: string): Promise<string[]> => {
      node.agent.logs(id, [{ ts: Date.now(), stream: "stdout", line: info(`${player} joined the game`) }]);
      await ui.owner!.waitForEvent(`server:${id}`, "player.joined", 5000, (d) => (d as { name: string }).name === player);
      await sleep(300);
      return Object.keys(users).filter((n) => ui[n]!.frames.some((f) => f.op === "event" && f.type === "player.joined" && (f.data as { name: string }).name === player));
    };
    expect(await join("Pone")).toEqual(["owner", "frank", "bob", "dave", "erin"]);

    const binding = (await owner.get(`/users/${frankId}`)).json().roles[0];
    expect((await owner.delete(`/users/${frankId}/roles/${binding.id}`)).statusCode).toBe(200);
    expect((await owner.delete(`/servers/${id}/subusers/${bobSub.json().id}`)).statusCode).toBe(204);
    const transfer = await owner.patch(`/servers/${id}/build`, { ownerId });
    expect(transfer.statusCode, transfer.body).toBe(200);
    await sleep(1_100); // the per-user principal cache (1 s); the socket's own refresh would take 30 s
    expect(await join("Ptwo")).toEqual(["owner", "erin"]);

    // Suspension keeps `.view` permissions (effectiveServerPermissions), as over HTTP.
    expect((await owner.post(`/servers/${id}/suspend`, {})).statusCode).toBe(200);
    expect((await erin.get(`/servers/${id}/players`)).statusCode).not.toBe(403);
    expect(await join("Pthree")).toEqual(["owner", "erin"]);
  });
});

describe("L5 operator escalation refusal is audited", () => {
  it("op/deop without servers.console.send → 403 + authz.denied audit event", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner, node, { startup: "manual" });
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    await owner.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view", "servers.players.view", "servers.players.manage"] });
    for (const action of ["op", "deop"]) expect((await act(bob, id, { action, name: "Notch" })).statusCode).toBe(403);
    const { rows } = await testPool().query(
      "SELECT a.action, a.outcome, a.target_id, a.details FROM audit_events a JOIN users u ON u.id::text = a.actor_id WHERE u.username = 'bob' AND a.action = 'authz.denied' ORDER BY a.id",
    );
    expect(rows).toHaveLength(2);
    for (const [i, action] of ["op", "deop"].entries()) {
      expect(rows[i]).toMatchObject({ action: "authz.denied", outcome: "denied", target_id: id, details: { permission: "servers.console.send", action, method: "POST" } });
    }
  });
});

describe("#8 Mojang 429 honours Retry-After through one shared limiter", () => {
  it("lookup and list edits share the back-off; seconds and HTTP-date; no request while blocked", async () => {
    const { owner, node, up, clock } = await boot();
    const id = await paperServer(owner, node, { startup: "manual" });
    const mojangCalls = () => up.calls.filter((c) => c.url.startsWith("https://api.mojang.com/")).length;

    up.mojang429 = true;
    up.mojangRetryAfter = "120";
    const first = await owner.get(`/servers/${id}/players/lookup?name=Someone`);
    expect(first.statusCode).toBe(429);
    expect(first.json().error).toMatchObject({ code: "RATE_LIMITED", details: { upstream: "mojang", retryAfterSeconds: 120, retryAfterMs: 120_000 } });
    expect(first.headers["retry-after"]).toBe("120");
    const calls = mojangCalls();
    up.mojang429 = false;

    // Blocked for everyone: the lookup route and the stopped-server list edit (profile resolution) alike.
    clock.now += 20_000;
    const blocked = await owner.get(`/servers/${id}/players/lookup?name=notch`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.details).toMatchObject({ upstream: "mojang", retryAfterSeconds: 100 });
    const edit = await act(owner, id, { action: "whitelist-add", name: "Notch" });
    expect(edit.statusCode).toBe(429);
    expect(edit.json().error.details).toMatchObject({ upstream: "mojang", retryAfterSeconds: 100 });
    expect(mojangCalls()).toBe(calls);

    clock.now += 100_000;
    expect(PlayerLookupResponse.parse((await owner.get(`/servers/${id}/players/lookup?name=notch`)).json())).toEqual({ name: "Notch", uuid: NOTCH, source: "mojang" });

    // HTTP-date form; an absurd value is clamped to 15 minutes; garbage falls back to 60 s.
    up.mojang429 = true;
    up.mojangRetryAfter = new Date(clock.now + 300_000).toUTCString();
    expect((await owner.get(`/servers/${id}/players/lookup?name=DateCase`)).json().error.details).toMatchObject({ retryAfterSeconds: 300 });
    clock.now += 300_000;
    up.mojangRetryAfter = "86400";
    expect((await owner.get(`/servers/${id}/players/lookup?name=Clamped`)).json().error.details).toMatchObject({ retryAfterSeconds: 900 });
    clock.now += 900_000;
    up.mojangRetryAfter = "later";
    expect((await owner.get(`/servers/${id}/players/lookup?name=Garbage`)).json().error.details).toMatchObject({ retryAfterSeconds: 60 });
  });
});
