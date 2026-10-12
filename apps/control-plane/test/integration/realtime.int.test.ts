import { randomUUID } from "node:crypto";
import { REALTIME_EVENT_PAYLOADS, type RealtimeEventType } from "@blockforge/contracts";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JobDefinition } from "../../src/jobs/types.js";
import { ApiClient, createUserClient, startWithOwner, type TestApp } from "../support/app.js";
import { insertServer, testPool } from "../support/db.js";
import { FakeAgent, nodeSample } from "../support/fake-agent.js";
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

const logJob: JobDefinition<{ nodeId: string }> = {
  type: "test.realtime",
  input: z.object({ nodeId: z.uuid() }),
  cancelPermission: "nodes.manage",
  steps: [
    {
      key: "log",
      label: "Logs",
      async run(ctx) {
        await new Promise((r) => setTimeout(r, 300));
        await ctx.log("info", "hello from the job");
      },
    },
  ],
};

function upgradeStatus(t: TestApp, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${t.wsBaseUrl}/api/v1/realtime`, { headers });
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(-1));
  });
}

describe("realtime gateway", () => {
  it("requires a session cookie and the PUBLIC_URL origin", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    expect(await upgradeStatus(t, { origin: "http://127.0.0.1:5173" })).toBe(401);
    expect(await upgradeStatus(t, { cookie: owner.cookieHeader(), origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus(t, { cookie: owner.cookieHeader() })).toBe(403);
    expect(await upgradeStatus(t, { cookie: owner.cookieHeader(), origin: "http://127.0.0.1:5173" })).toBe(101);
  });

  it("validates client frames and authorises topics per scope", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    ui.send(JSON.stringify({ op: "ping" }));
    await ui.waitFor((f) => f.op === "pong");
    ui.send("{nope");
    expect(await ui.waitFor((f) => f.op === "error" && f.code === "INVALID_FRAME")).toBeTruthy();
    expect(await ui.subscribe("not-a-topic")).toMatchObject({ op: "error", code: "INVALID_FRAME" });
    expect(await ui.subscribe(`server:${randomUUID()}`)).toMatchObject({ op: "error", code: "FORBIDDEN" });
    expect(await ui.subscribe(`job:${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`)).toMatchObject({ op: "error", code: "FORBIDDEN" });
    expect(await ui.subscribe("overview")).toMatchObject({ op: "subscribed" });
    ui.send(JSON.stringify({ op: "unsubscribe", topic: "overview" }));
    await ui.waitFor((f) => f.op === "unsubscribed" && f.topic === "overview");

    const moderator = await createUserClient(t, owner, "mod@example.com", [{ roleKey: "moderator", scopeType: "global", scopeId: null }]);
    const m = await UiSocket.open(t, moderator);
    sockets.push(m);
    expect(await m.subscribe("overview")).toMatchObject({ op: "subscribed" });
    expect(await m.subscribe("alerts")).toMatchObject({ op: "error", code: "FORBIDDEN" }); // no alerts.view
    expect(await m.subscribe(`node:${randomUUID()}`)).toMatchObject({ op: "error", code: "FORBIDDEN" });
  });

  it("delivers every event type with payloads matching REALTIME_EVENT_PAYLOADS", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ background: true, extraJobs: [logJob] }));
    const token = (await owner.post("/nodes/enrollment-tokens", { label: "rt" })).json().secretToken;
    const agent = new FakeAgent(t.baseUrl, t.wsBaseUrl);
    agents.push(agent);
    await agent.enroll(token);
    const nodeId = agent.nodeId as string;
    const serverId = await insertServer(testPool(), nodeId);
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    for (const topic of ["overview", "nodes", `node:${nodeId}`, `server:${serverId}`, `console:${serverId}`, "alerts"]) {
      expect((await ui.subscribe(topic)).op).toBe("subscribed");
    }

    await agent.connect();
    await agent.hello();
    await ui.waitForEvent("nodes", "node.updated");
    agent.metrics(nodeSample(Date.now(), { cpu: 99 }), [{ workloadId: serverId, ts: Date.now(), running: true, cpuPct: 250 }]);
    agent.logs(serverId, [{ ts: Date.now(), stream: "stdout", line: "hello" }]);
    await ui.waitForEvent(`node:${nodeId}`, "node.metrics");
    await ui.waitForEvent(`server:${serverId}`, "server.metrics");
    await ui.waitForEvent(`console:${serverId}`, "console.lines");
    await ui.waitForEvent("overview", "overview.updated", 6000, (d) => (d as { cpu: { usagePct: number | null } }).cpu.usagePct === 99);

    await owner.post("/alerts/rules", { name: "cpu", kind: "node.cpu.high", severity: "info", enabled: true, scopeType: "global", scopeId: null, threshold: 50, forSeconds: 0, cooldownSeconds: 60, channelIds: [] });
    await t.ctx.alertEvaluator.evaluate();
    await ui.waitForEvent("alerts", "alert.updated");

    const jobId = await t.ctx.jobs.enqueue("test.realtime", { nodeId }, { targetType: "node", targetId: nodeId });
    expect((await ui.subscribe(`job:${jobId}`)).op).toBe("subscribed");
    await ui.waitForEvent(`job:${jobId}`, "job.log");
    await ui.waitForEvent(`job:${jobId}`, "job.updated", 10_000, (d) => (d as { status: string }).status === "succeeded");

    const seen = new Set(ui.frames.flatMap((f) => (f.op === "event" ? [f.type] : [])));
    const expected: RealtimeEventType[] = ["overview.updated", "node.updated", "node.metrics", "server.metrics", "console.lines", "job.updated", "job.log", "alert.updated"];
    for (const type of expected) expect(seen.has(type), type).toBe(true);
    for (const f of ui.frames) {
      if (f.op !== "event") continue;
      const r = REALTIME_EVENT_PAYLOADS[f.type].safeParse(f.data);
      expect(r.success, `${f.type}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
    expect(ui.invalid).toEqual([]);
  });

  it("disconnects slow consumers with 4008 once their buffer exceeds 1 MiB", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    const serverId = randomUUID();
    // Subscribe directly through the hub (the topic needs a real server row otherwise).
    const client = t.ctx.hub.allClients()[0]!;
    t.ctx.hub.subscribe(client, `console:${serverId}`);
    (ui.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // stop reading: TCP backpressure builds up
    const line = "x".repeat(64 * 1024);
    for (let i = 0; i < 400 && t.ctx.hub.allClients().length > 0; i++) {
      t.ctx.hub.publish(`console:${serverId}`, "console.lines", { serverId, lines: [{ seq: i, ts: Date.now(), stream: "stdout", line }] });
      if ((client as unknown as { closed: boolean }).closed) break;
      await new Promise((r) => setImmediate(r));
    }
    expect((client as unknown as { closed: boolean }).closed).toBe(true);
    (ui.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    for (let i = 0; i < 100 && ui.closeCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    expect(ui.closeCode).toBe(4008);
  });

  it("closes the sockets of a session on logout (other sessions stay connected)", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const other = new ApiClient(t);
    await other.login("owner@example.com", "correct horse battery staple");
    const ui = await UiSocket.open(t, other);
    const mine = await UiSocket.open(t, owner);
    sockets.push(ui, mine);
    expect((await ui.subscribe("overview")).op).toBe("subscribed");
    await other.post("/auth/logout");
    for (let i = 0; i < 100 && ui.closeCode === null; i++) await new Promise((r) => setTimeout(r, 20));
    expect(ui.closeCode).toBe(4001);
    expect(mine.closeCode).toBeNull();
    expect(t.ctx.hub.allClients()).toHaveLength(1);
  });
});
