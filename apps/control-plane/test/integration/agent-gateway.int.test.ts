import { randomUUID } from "node:crypto";
import { ConsoleLinesEvent, EnrollResponse, Job, Node, OverviewSummary } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCommandError } from "../../src/agents/gateway.js";
import type { ApiClient} from "../support/app.js";
import { responseLog, startWithOwner, type TestApp } from "../support/app.js";
import { OffsetClock } from "../support/clock.js";
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

async function enrolledAgent(t: TestApp, owner: ApiClient, opts: { requiresApproval?: boolean } = {}) {
  const created = await owner.post("/nodes/enrollment-tokens", { label: "test node", requiresApproval: opts.requiresApproval ?? false });
  expect(created.statusCode).toBe(201);
  const agent = new FakeAgent(t.baseUrl, t.wsBaseUrl);
  agents.push(agent);
  const res = await agent.enroll(created.json().secretToken, { nodeName: `mc-${randomUUID().slice(0, 8)}` });
  expect(res.status).toBe(201);
  return { agent, token: created.json(), enroll: res.body };
}

async function connected(t: TestApp, owner: ApiClient, opts: { requiresApproval?: boolean } = {}) {
  const e = await enrolledAgent(t, owner, opts);
  await e.agent.connect();
  const welcome = await e.agent.hello();
  return { ...e, welcome, nodeId: e.agent.nodeId as string };
}

async function poll<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("enrollment", () => {
  it("issues single-use tokens (secret shown once, hash stored) and registers the node", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const created = await owner.post("/nodes/enrollment-tokens", { label: "rack 1", expiresInMinutes: 30, tags: ["eu"], location: "fra" });
    const body = created.json();
    expect(body.secretToken).toMatch(/^bfe_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(body.installCommand).toBe(`blockforge-agent enroll --url http://127.0.0.1:5173 --token ${body.secretToken} --insecure-allow-http`);
    const secret = body.secretToken.split("_")[2];
    const { rows } = await testPool().query("SELECT secret_hash FROM enrollment_tokens");
    expect(rows[0].secret_hash).not.toContain(secret);
    const listed = await owner.get("/nodes/enrollment-tokens");
    expect(listed.json()[0]).toMatchObject({ label: "rack 1", usedAt: null, createdBy: "owner@example.com" });
    expect(listed.body).not.toContain(secret);

    const agent = new FakeAgent(t.baseUrl, t.wsBaseUrl);
    agents.push(agent);
    const enrolled = await agent.enroll(body.secretToken, { nodeName: "MC Node 1" });
    expect(enrolled.status).toBe(201);
    const er = EnrollResponse.parse(enrolled.body);
    expect(er).toMatchObject({ approved: true, controlPlaneSigningKey: t.ctx.signer.publicKey, heartbeatIntervalMs: 15_000, metricsIntervalMs: 5000 });

    const node = Node.parse((await owner.get(`/nodes/${er.nodeId}`)).json());
    expect(node).toMatchObject({ name: "MC Node 1", slug: "mc-node-1", status: "active", connection: "offline", tags: ["eu"], location: "fra", latest: null });
    // Capacity defaults from facts: 64 cores, 128 GiB − 1 GiB, data-root filesystem.
    expect(node.capacity).toMatchObject({ cpuAllocatableMillicores: 64_000, memoryAllocatableBytes: 137_438_953_472 - 1024 ** 3, storageAllocatableBytes: 1_000_204_886_016 });

    // Single use; tampered/unknown tokens look identical.
    const reuse = await new FakeAgent(t.baseUrl, t.wsBaseUrl).enroll(body.secretToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error?.code).toBe("ENROLLMENT_TOKEN_INVALID");
    const fresh = (await owner.post("/nodes/enrollment-tokens", { label: "x" })).json().secretToken as string;
    const tampered = await new FakeAgent(t.baseUrl, t.wsBaseUrl).enroll(fresh.slice(0, -2) + (fresh.endsWith("AA") ? "BB" : "AA"));
    expect(tampered.status).toBe(401);
    expect((await new FakeAgent(t.baseUrl, t.wsBaseUrl).enroll("not-a-token")).status).toBe(400);
    // Expired tokens are rejected.
    await testPool().query("UPDATE enrollment_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
    expect((await new FakeAgent(t.baseUrl, t.wsBaseUrl).enroll(fresh)).status).toBe(401);

    const audit = (await owner.get("/audit?action=node.enroll")).json();
    expect(audit.items.map((e: { outcome: string }) => e.outcome).sort()).toEqual(["denied", "denied", "denied", "success"]);
    // The secret appears in exactly one response: the creation response.
    expect(responseLog.filter((r) => r.body.includes(secret))).toHaveLength(1);
  });
});

describe("agent sessions and commands", () => {
  it("authenticates, exchanges hello/welcome, dispatches signed commands and records them", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent } = await enrolledAgent(t, owner);
    const nodeId = agent.nodeId as string;

    const wrongKey = new FakeAgent(t.baseUrl, t.wsBaseUrl);
    wrongKey.nodeId = nodeId;
    await expect(wrongKey.connect()).rejects.toMatchObject({ status: 401 });

    await agent.connect();
    const welcome = await agent.hello();
    expect(welcome).toMatchObject({ t: "welcome", nodeId, approved: true, heartbeatIntervalMs: 15_000, metricsIntervalMs: 5000 });
    const node = Node.parse((await owner.get(`/nodes/${nodeId}`)).json());
    expect(node.connection).toBe("online");
    expect(node.agentVersion).toBe("0.1.0-test");
    expect(node.facts?.hostname).toBe("mc-node-1");

    agent.onCommandType("node.probe", (body) => ({ ok: true, data: { reachable: true, latencyMs: 1.25, host: (body.payload as { host: string }).host } }));
    const probe = await owner.post(`/nodes/${nodeId}/probe`, { host: "play.example.com", port: 25565, kind: "tcp" });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ reachable: true, latencyMs: 1.25 });
    expect(agent.commands[0]).toMatchObject({ type: "node.probe", nodeId, payload: { host: "play.example.com", port: 25565, kind: "tcp", timeoutMs: 3000 } });
    expect(agent.rejectedCommands).toEqual([]);
    const ownerId = (await owner.get("/auth/me")).json().user.id;
    const { rows } = await testPool().query("SELECT * FROM agent_commands WHERE node_id = $1", [nodeId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "node.probe", status: "succeeded", issued_by_user_id: ownerId });
    expect(rows[0].completed_at).not.toBeNull();

    // Sensitive payload fields are redacted before persisting.
    const serverId = await insertServer(testPool(), nodeId);
    agent.onCommandType("fs.write", () => ({ ok: true, data: { sha256: "a".repeat(64), size: 10 } }));
    await t.ctx.gateway.send(nodeId, "fs.write", { workloadId: serverId, path: "server.properties", content: "rcon.password=hunter2", encoding: "utf8" });
    const { rows: writes } = await testPool().query("SELECT payload_redacted FROM agent_commands WHERE type = 'fs.write'");
    expect(writes[0].payload_redacted).toMatchObject({ path: "server.properties", content: "[REDACTED]" });
    expect(JSON.stringify(writes)).not.toContain("hunter2");

    // Agent error results, invalid results, timeouts.
    agent.onCommandType("workload.start", () => ({ ok: false, error: { code: "NOT_FOUND", message: "no such workload" } }));
    await expect(t.ctx.gateway.send(nodeId, "workload.start", { workloadId: serverId })).rejects.toMatchObject({ code: "NOT_FOUND", retryable: false });
    agent.onCommandType("workload.status", () => ({ ok: true, data: { workloads: "nope" } }));
    await expect(t.ctx.gateway.send(nodeId, "workload.status", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    agent.onCommandType("workload.kill", () => null);
    await expect(t.ctx.gateway.send(nodeId, "workload.kill", { workloadId: serverId }, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    await expect(t.ctx.gateway.send(nodeId, "workload.start", { workloadId: "not-a-uuid" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const statuses = Object.fromEntries((await testPool().query("SELECT type, status FROM agent_commands")).rows.map((r) => [r.type, r.status]));
    expect(statuses).toEqual({ "node.probe": "succeeded", "fs.write": "succeeded", "workload.start": "failed", "workload.status": "failed", "workload.kill": "expired" });

    // Pending commands fail with a retryable error when the agent disconnects.
    const pending = t.ctx.gateway.send(nodeId, "workload.kill", { workloadId: serverId }, { timeoutMs: 10_000 });
    await agent.waitFor((f) => f.t === "cmd");
    await agent.close();
    await expect(pending).rejects.toBeInstanceOf(AgentCommandError);
    await expect(pending).rejects.toMatchObject({ code: "NODE_UNAVAILABLE", retryable: true });
    const offline = await owner.post(`/nodes/${nodeId}/probe`, { host: "x.example", port: 1, kind: "tcp" });
    expect(offline.statusCode).toBe(503);
    expect(offline.json().error.code).toBe("NODE_UNAVAILABLE");
  });

  it("keeps one session per node, tolerates malformed frames and rejects replayed tokens", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent, nodeId } = await connected(t, owner);

    const header = agent.authHeader();
    const second = new FakeAgent(t.baseUrl, t.wsBaseUrl);
    second.nodeId = nodeId;
    second.privateKey = agent.privateKey;
    second.cpKey = agent.cpKey;
    agents.push(second);
    const firstClosed = agent.waitForClose();
    await second.connect(header);
    expect(await firstClosed).toBe(4000); // replaced by the newer session
    await second.hello();
    await second.close();
    // Same token again → replay.
    await expect(second.connect(header)).rejects.toMatchObject({ status: 401 });
    const { rows } = await testPool().query("SELECT count(*)::int AS n FROM agent_auth_jti WHERE node_id = $1", [nodeId]);
    expect(rows[0].n).toBe(2);

    // Expired / future tokens are refused.
    await expect(second.connect(second.authHeader({ iat: Date.now() - 200_000, exp: Date.now() - 100_000 }))).rejects.toMatchObject({ status: 401 });
    await expect(second.connect(second.authHeader({ iat: Date.now() + 60_000, exp: Date.now() + 120_000 }))).rejects.toMatchObject({ status: 401 });

    await second.connect();
    await second.hello();
    const before = t.ctx.gateway.stats.malformedFrames;
    second.sendRaw("this is not json");
    second.send({ t: "metrics", ts: Date.now(), node: { bogus: true }, workloads: [] });
    second.send({ t: "metrics", ts: Date.now(), node: nodeSample(Date.now(), { cpu: 150 }), workloads: [] }); // percent > 100
    second.send({ t: "no-such-frame" });
    second.heartbeat();
    await poll(async () => t!.ctx.gateway.stats.malformedFrames >= before + 4);
    expect(t.ctx.gateway.isReady(nodeId)).toBe(true);
    expect(t.ctx.latest.getNode(nodeId)).toBeNull();
  });

  it("pending nodes only receive node.facts until approved; approval re-sends welcome", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent, nodeId, welcome, enroll } = await connected(t, owner, { requiresApproval: true });
    expect(enroll.approved).toBe(false);
    expect(welcome.approved).toBe(false);
    await expect(t.ctx.gateway.send(nodeId, "node.probe", { host: "a.example", port: 1, kind: "tcp" })).rejects.toMatchObject({ code: "NODE_UNAVAILABLE", retryable: false });
    agent.onCommandType("node.facts", () => ({ ok: true, data: agentFacts() }));
    const facts = await t.ctx.gateway.send(nodeId, "node.facts", {});
    expect(facts.hostname).toBe("mc-node-1");
    expect((await owner.get(`/nodes/${nodeId}`)).json().status).toBe("pending");
    const rewelcome = agent.waitFor((f) => f.t === "welcome" && f.approved === true);
    expect((await owner.post(`/nodes/${nodeId}/approve`)).json().status).toBe("active");
    await rewelcome;
    expect((await owner.post(`/nodes/${nodeId}/approve`)).statusCode).toBe(409);
  });

  it("revocation closes the session and rejects new tokens", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent, nodeId } = await connected(t, owner);
    const closed = agent.waitForClose();
    const revoked = await owner.post(`/nodes/${nodeId}/revoke`);
    expect(revoked.json()).toMatchObject({ status: "revoked", connection: "offline" });
    expect(await closed).toBe(4003);
    await expect(agent.connect()).rejects.toMatchObject({ status: 401 });
    const { rows } = await testPool().query("SELECT status FROM node_credentials WHERE node_id = $1", [nodeId]);
    expect(rows.map((r) => r.status)).toEqual(["revoked"]);
    expect((await owner.patch(`/nodes/${nodeId}`, { name: "x" })).statusCode).toBe(409);
    expect((await owner.delete(`/nodes/${nodeId}`)).statusCode).toBe(204);
    expect((await owner.get(`/nodes/${nodeId}`)).statusCode).toBe(404);
  });

  it("refuses to delete a node that hosts servers", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { nodeId } = await connected(t, owner);
    await insertServer(testPool(), nodeId);
    expect((await owner.delete(`/nodes/${nodeId}`)).statusCode).toBe(409);
  });
});

function agentFacts() {
  return { hostname: "mc-node-1", os: "linux", arch: "amd64", cpuLogicalCores: 4, memoryTotalBytes: 8 * 1024 ** 3, dataRoot: "/var/lib/blockforge", interfaces: [], filesystems: [], containerRuntime: null, javaRuntimes: [] };
}

describe("telemetry", () => {
  it("ingests metrics into the latest cache, VictoriaMetrics, realtime and the overview", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ env: { AGENT_METRICS_INTERVAL_MS: "5000" } }));
    const { agent, nodeId } = await connected(t, owner);
    const serverId = await insertServer(testPool(), nodeId, { name: "survival" });

    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    for (const topic of [`node:${nodeId}`, "nodes", "overview", `server:${serverId}`, `console:${serverId}`]) {
      expect((await ui.subscribe(topic)).op).toBe("subscribed");
    }
    const initialOverview = OverviewSummary.parse((await ui.waitForEvent("overview", "overview.updated")).data);
    expect(initialOverview.nodes.online).toBe(1);

    const now = Date.now();
    const workload = (ts: number) => ({
      workloadId: serverId,
      ts,
      running: true,
      cpuPct: 150,
      memoryUsageBytes: 2 * 1024 ** 3,
      memoryLimitBytes: 4 * 1024 ** 3,
      minecraft: { playersOnline: 7, playersMax: 20, playerSample: [], latencyMs: 2 },
    });
    const samples = [now - 20_000, now - 10_000, now].map((ts, i) => nodeSample(ts, { cpu: 10 + i * 10 }));
    for (const [i, s] of samples.entries()) agent.metrics(s, [workload(s.ts)].slice(0, i === 2 ? 1 : 0));
    // A sample for a workload this node does not own is dropped.
    agent.metrics(nodeSample(now + 1, { cpu: 30 }), [{ ...workload(now + 1), workloadId: randomUUID() }]);

    const ev = await ui.waitForEvent(`node:${nodeId}`, "node.metrics", 5000, (d) => (d as { sample: { cpu: { usagePct: number } } }).sample.cpu.usagePct === 30);
    expect(ev.data).toMatchObject({ nodeId });
    await ui.waitForEvent("nodes", "node.metrics");
    await ui.waitForEvent(`server:${serverId}`, "server.metrics");
    await poll(async () => t!.ctx.gateway.stats.droppedWorkloadFrames >= 1);

    const node = Node.parse((await owner.get(`/nodes/${nodeId}`)).json());
    expect(node.latest?.cpu.usagePct).toBe(30);

    const overview = OverviewSummary.parse((await owner.get("/overview")).json());
    expect(overview).toMatchObject({
      nodes: { total: 1, online: 1, pending: 0 },
      servers: { total: 1, byState: { running: 1 } },
      players: { online: 7, reportingServers: 1 },
      backups: null,
      pendingUpdates: null,
    });
    expect(overview.cpu.usagePct).toBe(30);
    expect(overview.cpu.capacityMillicores).toBe(64_000);
    expect(overview.memory.usedBytes).toBe(samples[2]!.memory.usedBytes);
    expect(overview.memory.allocatedBytes).toBe(0);
    expect(overview.network.rxBytesPerSec).toBe(5000);

    // VictoriaMetrics: the points come back from a real range query (null-filled grid).
    await t.ctx.vmWriter.flush(true);
    expect(t.ctx.vmWriter.stats.lastError).toBeNull();
    const from = now - 60_000;
    const to = now + 5000;
    const range = await poll(async () => {
      const r = (await owner.get(`/metrics/range?series=node.cpu.usage&nodeId=${nodeId}&from=${from}&to=${to}&stepMs=5000`)).json();
      // The newest sample becomes visible at the first grid step at/after it, which may still lie a
      // few seconds in the future when the query runs — so wait for it.
      const values: (number | null)[] = r.lines[0]?.points.map((p: [number, number | null]) => p[1]) ?? [];
      return [10, 20, 30].every((v) => values.includes(v)) ? r : null;
    }, 20_000);
    expect(range).toMatchObject({ series: "node.cpu.usage", unit: "percent", stepMs: 5000, lines: [{ labels: { kind: "usage" } }] });
    const points: [number, number | null][] = range.lines[0].points;
    expect(points[0]![0] % 5000).toBe(0);
    expect(points.some((p) => p[1] === null)).toBe(true); // gap before the first sample
    expect(points.map((p) => p[1]).filter((v) => v !== null)).toEqual(expect.arrayContaining([10, 20, 30]));
    const cores = (await owner.get(`/metrics/range?series=node.cpu.core&nodeId=${nodeId}&from=${from}&to=${to}`)).json();
    expect(cores.lines.map((l: { labels: { core: string } }) => l.labels.core).sort()).toEqual(["0", "1"]);
    const players = await poll(async () => {
      const r = (await owner.get(`/metrics/range?series=server.players&serverId=${serverId}&from=${from}&to=${to}`)).json();
      return r.lines.length === 2 ? r : null;
    });
    expect(players.lines.find((l: { labels: { kind: string } }) => l.labels.kind === "online").points.some((p: [number, number | null]) => p[1] === 7)).toBe(true);
    const global = await poll(async () => {
      const r = (await owner.get(`/metrics/range?series=global.cpu.usage&from=${from}&to=${to}`)).json();
      return r.lines[0]?.points.some((p: [number, number | null]) => p[1] !== null) ? r : null;
    });
    expect(global.series).toBe("global.cpu.usage");

    // Console logs → ring buffer with monotonic seq → console:<serverId> subscribers.
    agent.logs(serverId, [
      { ts: now, stream: "stdout", line: "[12:00:00 INFO]: Done (4.211s)!" },
      { ts: now + 1, stream: "stderr", line: "<script>alert(1)</script>" },
    ]);
    agent.logs(randomUUID(), [{ ts: now, stream: "stdout", line: "not mine" }]);
    const consoleEv = await ui.waitForEvent(`console:${serverId}`, "console.lines");
    const lines = ConsoleLinesEvent.parse(consoleEv.data);
    expect(lines.lines.map((l) => [l.seq, l.line])).toEqual([
      [1, "[12:00:00 INFO]: Done (4.211s)!"],
      [2, "<script>alert(1)</script>"],
    ]);
    expect(t.ctx.consoles.tail(serverId, 10).lines).toHaveLength(2);
    expect(ui.invalid).toEqual([]);
  });

  it("marks nodes unreachable after missed heartbeats and offline after a clean disconnect", async () => {
    const clock = new OffsetClock();
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ clock, env: { AGENT_HEARTBEAT_INTERVAL_MS: "1000", NODE_OFFLINE_AFTER_MS: "60000" } }));
    const { agent, nodeId } = await connected(t, owner);
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    await ui.subscribe("nodes");
    expect(t.ctx.tracker.get(nodeId)?.connection).toBe("online");

    clock.advance(3001);
    await t.ctx.tracker.sweep();
    expect(t.ctx.tracker.get(nodeId)?.connection).toBe("unreachable");
    const ev = await ui.waitForEvent("nodes", "node.updated", 5000, (d) => (d as { connection: string }).connection === "unreachable");
    expect((ev.data as { id: string }).id).toBe(nodeId);
    expect((await owner.get(`/nodes/${nodeId}`)).json().connection).toBe("unreachable");
    agent.heartbeat(clock.now());
    await poll(async () => t!.ctx.tracker.get(nodeId)?.connection === "online");

    await agent.close();
    await poll(async () => t!.ctx.tracker.get(nodeId)?.connection === "unreachable");
    clock.advance(60_001);
    await t.ctx.tracker.sweep();
    expect(t.ctx.tracker.get(nodeId)?.connection).toBe("offline");
    const { rows } = await testPool().query(
      "SELECT data->>'from' AS f, data->>'to' AS t FROM events WHERE type = 'node.connection.changed' AND subject_id = $1 ORDER BY id",
      [nodeId],
    );
    expect(rows.map((r) => `${r.f}->${r.t}`)).toEqual(["offline->online", "online->unreachable", "unreachable->online", "online->unreachable", "unreachable->offline"]);
    const { rows: hb } = await testPool().query("SELECT count(*)::int AS n FROM events WHERE type = 'node.heartbeat.received'");
    expect(hb[0].n).toBe(0); // heartbeats are ephemeral
  });

  it("marks a node degraded when the container runtime is unhealthy or the clock is skewed", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent } = await enrolledAgent(t, owner);
    const nodeId = agent.nodeId as string;
    await agent.connect();
    await agent.hello([], { ...agentFacts(), containerRuntime: { name: "docker", version: "29", rootless: false, healthy: false } });
    expect(t.ctx.tracker.get(nodeId)?.connection).toBe("degraded");
    await agent.close();
    await agent.connect();
    await agent.hello([], agentFacts() as never, Date.now() + 120_000);
    expect(t.ctx.tracker.get(nodeId)?.connection).toBe("degraded"); // no runtime + 2 min skew
    expect(Math.abs((await owner.get(`/nodes/${nodeId}`)).json().clockSkewMs)).toBeGreaterThan(100_000);
  });
});

describe("credential rotation job", () => {
  it("rotates the agent key with proof of possession and retires the old key", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ background: true, rotationConfirmTimeoutMs: 15_000 }));
    const { agent, nodeId } = await connected(t, owner);
    const oldKey = agent.privateKey;
    const oldPublic = agent.publicKey;
    agent.enableKeyRotation();
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);

    const res = await owner.request("POST", `/nodes/${nodeId}/rotate-credentials`, {}, { "idempotency-key": "rotate-1" });
    expect(res.statusCode).toBe(202);
    const jobId = res.headers["x-blockforge-job-id"] as string;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await ui.subscribe(`job:${jobId}`)).op).toBe("subscribed");
    const again = await owner.request("POST", `/nodes/${nodeId}/rotate-credentials`, {}, { "idempotency-key": "rotate-1" });
    expect(again.headers["x-blockforge-job-id"]).toBe(jobId);

    const row = await t.ctx.jobs.waitForCompletion(jobId, 30_000);
    expect(row.status).toBe("succeeded");
    const job = Job.parse((await owner.get(`/jobs/${jobId}`)).json());
    expect(job.steps.map((s) => `${s.key}:${s.status}`)).toEqual(["request:succeeded", "confirm:succeeded"]);
    expect(job.result).toEqual({ publicKey: agent.publicKey });
    expect(agent.publicKey).not.toBe(oldPublic);
    const logs = (await owner.get(`/jobs/${jobId}/logs`)).json();
    expect(logs.length).toBeGreaterThanOrEqual(3);
    await ui.waitForEvent(`job:${jobId}`, "job.updated", 5000, (d) => (d as { status: string }).status === "succeeded");
    expect(ui.invalid).toEqual([]);

    const { rows } = await testPool().query("SELECT public_key, status FROM node_credentials WHERE node_id = $1 ORDER BY created_at", [nodeId]);
    expect(rows).toEqual([
      { public_key: oldPublic, status: "rotated" },
      { public_key: agent.publicKey, status: "active" },
    ]);
    // The retired key no longer authenticates; the new one does.
    const probe = new FakeAgent(t.baseUrl, t.wsBaseUrl);
    probe.nodeId = nodeId;
    await expect(probe.connect(probe.authHeader({ key: oldKey }))).rejects.toMatchObject({ status: 401 });
    const actions = (await owner.get("/audit?action=node.credentials.*")).json().items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["node.credentials.rotate", "node.credentials.rotation.pending", "node.credentials.rotated"]));
  });

  it("rejects a rotation result with an invalid proof and keeps the old key", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ background: true }));
    const { agent, nodeId } = await connected(t, owner);
    agent.onCommandType("credentials.rotate", () => ({ ok: true, data: { publicKey: agent.publicKey, proof: "A".repeat(86) } }));
    const res = await owner.post(`/nodes/${nodeId}/rotate-credentials`);
    const row = await t.ctx.jobs.waitForCompletion(res.headers["x-blockforge-job-id"] as string, 20_000);
    expect(row.status).toBe("failed");
    expect(row.error).toMatchObject({ code: "ROTATION_PROOF_INVALID" });
    const { rows } = await testPool().query("SELECT status FROM node_credentials WHERE node_id = $1", [nodeId]);
    expect(rows.map((r) => r.status)).toEqual(["active"]);
  });
});

describe("graceful shutdown", () => {
  it("tells connected agents to come back later (1012) and stops background work", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ background: true }));
    const { agent } = await connected(t, owner);
    const ui = await UiSocket.open(t, owner);
    const closed = agent.waitForClose();
    const app = t;
    t = null;
    await app.close();
    expect(await closed).toBe(1012);
    for (let i = 0; i < 50 && ui.closeCode === null; i++) await new Promise((r) => setTimeout(r, 20));
    expect(ui.closeCode).not.toBeNull();
  });
});
