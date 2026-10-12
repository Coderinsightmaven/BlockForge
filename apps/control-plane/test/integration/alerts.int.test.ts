import { AlertIncident, AlertRule, NotificationChannel } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RawPost } from "../../src/notifications/http.js";
import type { LookupFn } from "../../src/notifications/ssrf.js";
import { ApiClient, responseLog, startWithOwner, type TestApp } from "../support/app.js";
import { OffsetClock } from "../support/clock.js";
import { testPool } from "../support/db.js";
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

const WEBHOOK_URL = "https://hooks.example.com/services/secret-path?token=supersecret123";
const DISCORD_URL = "https://discord.com/api/webhooks/123456789/discord-secret-token";
const PUBLIC_IP = "93.184.216.34";
const lookup: LookupFn = async (host) => [{ address: host.endsWith(".internal") ? "10.0.0.7" : PUBLIC_IP, family: 4 }];

interface Sent {
  host: string;
  path: string;
  address: string;
  payload: Record<string, unknown>;
}

function recorder() {
  const state = { status: 204 };
  const sent: Sent[] = [];
  const transport: RawPost = async (target, body) => {
    sent.push({ host: target.url.hostname, path: `${target.url.pathname}${target.url.search}`, address: target.address, payload: JSON.parse(body) });
    return { status: state.status, body: "" };
  };
  return { sent, transport, state };
}

async function onlineNode(t: TestApp, owner: ApiClient) {
  const token = (await owner.post("/nodes/enrollment-tokens", { label: "alerts" })).json().secretToken;
  const agent = new FakeAgent(t.baseUrl, t.wsBaseUrl);
  agents.push(agent);
  await agent.enroll(token, { nodeName: "alert-node" });
  await agent.connect();
  await agent.hello();
  return { agent, nodeId: agent.nodeId as string };
}

async function waitMetrics(t: TestApp, nodeId: string, cpu: number) {
  for (let i = 0; i < 100; i++) {
    if (t.ctx.latest.getNode(nodeId)?.cpu.usagePct === cpu) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("metrics not ingested");
}

describe("notification channels", () => {
  it("stores webhook URLs as secrets, never returns them, and validates targets", async () => {
    const rec = recorder();
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ notifications: { lookup, transport: rec.transport } }));

    const created = await owner.post("/notification-channels", { name: "Ops hook", kind: "webhook", config: { url: WEBHOOK_URL } });
    expect(created.statusCode).toBe(201);
    const channel = NotificationChannel.parse(created.json());
    expect(channel.config).toEqual({ host: "hooks.example.com" });
    const discord = NotificationChannel.parse((await owner.post("/notification-channels", { name: "Discord", kind: "discord", config: { url: DISCORD_URL } })).json());
    expect(discord.config).toEqual({});

    const listed = await owner.get("/notification-channels");
    expect(listed.json()).toHaveLength(2);
    const { rows } = await testPool().query("SELECT ciphertext FROM secrets");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(Buffer.from(r.ciphertext).toString("latin1")).not.toContain("supersecret123");

    // Invalid targets.
    const bad = async (config: unknown, kind = "webhook") => (await owner.post("/notification-channels", { name: "x", kind, config })).json();
    expect((await bad({ url: "http://hooks.example.com/x" })).error.code).toBe("VALIDATION_FAILED");
    expect((await bad({ url: "https://metadata.internal/x" })).error.message).toMatch(/non-public/);
    expect((await bad({ url: "https://169.254.169.254/latest" })).error.message).toMatch(/non-public/);
    expect((await bad({ url: "https://evil.example.com/api/webhooks/1/x" }, "discord")).error.message).toMatch(/discord.com/);
    expect((await bad({})).error.details.issues[0].path).toBe("");
    expect((await owner.post("/notification-channels", { name: "Mail", kind: "email", config: { to: ["ops@example.com"] } })).statusCode).toBe(412);

    // Admin allowlist lets an internal host through.
    await t.ctx.settings.set("notifications.webhookAllowlist", ["ci.internal"], null);
    expect((await owner.post("/notification-channels", { name: "CI", kind: "webhook", config: { url: "https://ci.internal/hook" } })).statusCode).toBe(201);

    // Test delivery goes to the stored URL via the pinned address.
    const test = await owner.post(`/notification-channels/${channel.id}/test`);
    expect(test.json()).toEqual({ delivered: true, error: null });
    expect(rec.sent[0]).toMatchObject({ host: "hooks.example.com", path: "/services/secret-path?token=supersecret123", address: PUBLIC_IP });
    expect(rec.sent[0]!.payload).toMatchObject({ source: "blockforge", status: "test" });
    expect((await owner.post(`/notification-channels/${discord.id}/test`)).json().delivered).toBe(true);
    expect(rec.sent[1]!.payload).toMatchObject({ allowed_mentions: { parse: [] } });

    // PUT without url keeps the secret; with url replaces it.
    await owner.put(`/notification-channels/${channel.id}`, { name: "Renamed", kind: "webhook", enabled: true, config: {} });
    await owner.post(`/notification-channels/${channel.id}/test`);
    expect(rec.sent[2]!.path).toBe("/services/secret-path?token=supersecret123");
    const replaced = await owner.put(`/notification-channels/${channel.id}`, { name: "Renamed", kind: "webhook", enabled: true, config: { url: "https://other.example.com/new" } });
    expect(replaced.json().config).toEqual({ host: "other.example.com" });
    await owner.post(`/notification-channels/${channel.id}/test`);
    expect(rec.sent[3]!.host).toBe("other.example.com");

    rec.state.status = 500;
    expect((await owner.post(`/notification-channels/${channel.id}/test`)).json()).toEqual({ delivered: false, error: "webhook responded with HTTP 500" });
    const { rows: deliveries } = await testPool().query("SELECT status, count(*)::int AS n FROM notification_deliveries GROUP BY status");
    expect(Object.fromEntries(deliveries.map((d) => [d.status, d.n]))).toEqual({ succeeded: 4, failed: 1 });

    const ruleWithChannel = (
      await owner.post("/alerts/rules", { name: "r", kind: "job.failed", severity: "info", enabled: true, scopeType: "global", scopeId: null, threshold: null, forSeconds: 0, cooldownSeconds: 0, channelIds: [channel.id, discord.id] })
    ).json();
    expect((await owner.delete(`/notification-channels/${channel.id}`)).statusCode).toBe(204);
    expect((await owner.get("/alerts/rules")).json().find((r: { id: string }) => r.id === ruleWithChannel.id).channelIds).toEqual([discord.id]);
    expect((await testPool().query("SELECT count(*)::int AS n FROM secrets WHERE name LIKE $1", [`%${channel.id}%`])).rows[0].n).toBe(0);

    // Secret URLs never appear in any API response or audit record.
    const leaked = responseLog.filter((r) => r.body.includes("supersecret123") || r.body.includes("discord-secret-token") || r.body.includes("secret-path"));
    expect(leaked).toEqual([]);
    const { rows: audit } = await testPool().query("SELECT details::text AS d FROM audit_events");
    expect(audit.some((a) => a.d.includes("supersecret123") || a.d.includes("discord-secret-token"))).toBe(false);
  });
});

describe("alert rules and evaluation", () => {
  it("seeds defaults and validates thresholds per ALERT_RULE_KINDS", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const rules = AlertRule.array().parse((await owner.get("/alerts/rules")).json());
    expect(rules.map((r) => `${r.kind}:${r.severity}:${r.threshold}`).sort()).toEqual([
      "job.failed:warning:null",
      "node.cpu.high:warning:90",
      "node.disk.low:critical:5",
      "node.disk.low:warning:10",
      "node.memory.high:warning:90",
      "node.unreachable:critical:null",
    ]);
    await t.ctx.alerts.seedDefaults();
    expect((await owner.get("/alerts/rules")).json()).toHaveLength(6);
    const base = { name: "r", severity: "warning", enabled: true, scopeType: "global", scopeId: null, forSeconds: 0, cooldownSeconds: 60, channelIds: [] };
    expect((await owner.post("/alerts/rules", { ...base, kind: "node.cpu.high", threshold: null })).json().error.details.issues[0].path).toBe("threshold");
    expect((await owner.post("/alerts/rules", { ...base, kind: "job.failed", threshold: 5 })).statusCode).toBe(400);
    expect((await owner.post("/alerts/rules", { ...base, kind: "node.cpu.high", threshold: 150 })).statusCode).toBe(400);
    expect((await owner.post("/alerts/rules", { ...base, kind: "node.cpu.high", threshold: 50, channelIds: ["00000000-0000-4000-8000-000000000000"] })).statusCode).toBe(400);
    const created = await owner.post("/alerts/rules", { ...base, kind: "node.cpu.high", threshold: 50 });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await owner.put(`/alerts/rules/${id}`, { ...base, name: "renamed", kind: "node.cpu.high", threshold: 60 })).json()).toMatchObject({ name: "renamed", threshold: 60 });
    expect((await owner.delete(`/alerts/rules/${id}`)).statusCode).toBe(204);
  });

  it("fires, notifies, acknowledges, auto-resolves, re-opens within cooldown and honours manual resolve", async () => {
    const rec = recorder();
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ notifications: { lookup, transport: rec.transport } }));
    const channel = (await owner.post("/notification-channels", { name: "Hook", kind: "webhook", config: { url: WEBHOOK_URL } })).json();
    const rule = (
      await owner.post("/alerts/rules", {
        name: "CPU above 50%",
        kind: "node.cpu.high",
        severity: "critical",
        enabled: true,
        scopeType: "global",
        scopeId: null,
        threshold: 50,
        forSeconds: 0,
        cooldownSeconds: 3600,
        channelIds: [channel.id],
      })
    ).json();
    const { agent, nodeId } = await onlineNode(t, owner);
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    expect((await ui.subscribe("alerts")).op).toBe("subscribed");

    agent.metrics(nodeSample(Date.now(), { cpu: 80 }));
    await waitMetrics(t, nodeId, 80);
    await t.ctx.alertEvaluator.evaluate();
    const open = (await owner.get("/alerts/incidents?status=open")).json().items;
    expect(open).toHaveLength(1);
    const incident = AlertIncident.parse(open[0]);
    expect(incident).toMatchObject({ ruleId: rule.id, kind: "node.cpu.high", severity: "critical", status: "firing", subjectType: "node", subjectId: nodeId, subjectName: "alert-node", value: 80, occurrences: 1 });
    await ui.waitForEvent("alerts", "alert.updated", 5000, (d) => (d as { status: string }).status === "firing");
    for (let i = 0; i < 50 && rec.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rec.sent[0]!.payload).toMatchObject({ status: "firing", severity: "critical", incidentId: incident.id });
    expect((await owner.get("/alerts/incidents?severity=warning")).json().items).toHaveLength(0);
    expect((await owner.get("/overview")).json().activeAlerts).toEqual({ critical: 1, warning: 0, info: 0 });

    // Dedup: another evaluation does not open a second incident or re-notify.
    await t.ctx.alertEvaluator.evaluate();
    expect((await owner.get("/alerts/incidents")).json().items).toHaveLength(1);
    expect(rec.sent).toHaveLength(1);

    const acked = await owner.post(`/alerts/incidents/${incident.id}/ack`);
    expect(acked.json()).toMatchObject({ status: "acknowledged", acknowledgedBy: "owner@example.com" });
    expect((await owner.post(`/alerts/incidents/${incident.id}/ack`)).statusCode).toBe(409);

    // Condition clears → auto-resolve + resolved notification.
    agent.metrics(nodeSample(Date.now(), { cpu: 20 }));
    await waitMetrics(t, nodeId, 20);
    await t.ctx.alertEvaluator.evaluate();
    const resolved = (await owner.get("/alerts/incidents?status=resolved")).json().items[0];
    expect(resolved).toMatchObject({ id: incident.id, status: "resolved" });
    for (let i = 0; i < 50 && rec.sent.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rec.sent[1]!.payload).toMatchObject({ status: "resolved" });

    // Re-fires within the cooldown: the same incident re-opens, no new notification.
    agent.metrics(nodeSample(Date.now(), { cpu: 90 }));
    await waitMetrics(t, nodeId, 90);
    await t.ctx.alertEvaluator.evaluate();
    const reopened = (await owner.get("/alerts/incidents?status=open")).json().items;
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ id: incident.id, status: "firing", occurrences: 2, acknowledgedAt: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.sent).toHaveLength(2);

    // Manual resolve suppresses re-firing until the condition clears.
    expect((await owner.post(`/alerts/incidents/${incident.id}/resolve`)).json().status).toBe("resolved");
    await t.ctx.alertEvaluator.evaluate();
    await new Promise((r) => setTimeout(r, 50));
    await t.ctx.alertEvaluator.evaluate();
    expect((await owner.get("/alerts/incidents?status=open")).json().items).toHaveLength(0);
    expect((await owner.get("/audit?action=alert_incident.*")).json().items.map((e: { action: string }) => e.action).sort()).toEqual([
      "alert_incident.acknowledge",
      "alert_incident.resolve",
    ]);
    const { rows } = await testPool().query("SELECT type FROM events WHERE type LIKE 'alert.%' ORDER BY id");
    expect(rows.map((r) => r.type)).toEqual(["alert.fired", "alert.resolved", "alert.fired", "alert.resolved"]);
    expect(ui.invalid).toEqual([]);
  });

  it("applies forSeconds, free-space semantics for disks and the unreachable rule", async () => {
    const clock = new OffsetClock();
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ clock }));
    const { agent, nodeId } = await onlineNode(t, owner);

    // 92% used = 8% free: below the 10% warning threshold, above the 5% critical one; forSeconds 60.
    agent.metrics(nodeSample(clock.now(), { cpu: 11, fsUsedPct: 92 }));
    await waitMetrics(t, nodeId, 11);
    await t.ctx.alertEvaluator.evaluate();
    expect((await owner.get("/alerts/incidents")).json().items).toHaveLength(0);
    clock.advance(61_000);
    agent.metrics(nodeSample(clock.now(), { cpu: 12, fsUsedPct: 92 }));
    await waitMetrics(t, nodeId, 12);
    agent.heartbeat(clock.now());
    await t.ctx.alertEvaluator.evaluate();
    const items = (await owner.get("/alerts/incidents")).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "node.disk.low", severity: "warning", subjectName: "alert-node /" });
    expect(items[0].value).toBeCloseTo(8, 5);

    // Node goes away → unreachable (critical, forSeconds 0).
    await agent.close();
    for (let i = 0; i < 50 && t.ctx.tracker.get(nodeId)?.connection !== "unreachable"; i++) await new Promise((r) => setTimeout(r, 20));
    await t.ctx.alertEvaluator.evaluate();
    const open = (await owner.get("/alerts/incidents?status=open")).json().items.map((i: { kind: string }) => i.kind).sort();
    expect(open).toEqual(["node.disk.low", "node.unreachable"]);
  });

  it("filters incidents by the subscriber's scope", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const a = await onlineNode(t, owner);
    const b = await onlineNode(t, owner);
    const rule = (
      await owner.post("/alerts/rules", { name: "cpu", kind: "node.cpu.high", severity: "warning", enabled: true, scopeType: "global", scopeId: null, threshold: 50, forSeconds: 0, cooldownSeconds: 60, channelIds: [] })
    ).json();
    expect(rule.id).toBeTruthy();
    a.agent.metrics(nodeSample(Date.now(), { cpu: 70 }));
    b.agent.metrics(nodeSample(Date.now(), { cpu: 71 }));
    await waitMetrics(t, a.nodeId, 70);
    await waitMetrics(t, b.nodeId, 71);
    await t.ctx.alertEvaluator.evaluate();
    expect((await owner.get("/alerts/incidents")).json().items).toHaveLength(2);
    const infra = new ApiClient(t);
    await owner.post("/users", { email: "infra@example.com", displayName: "Infra", password: "a long enough password", roles: [{ roleKey: "infra_admin", scopeType: "node", scopeId: a.nodeId }] });
    await infra.login("infra@example.com", "a long enough password");
    const visible = (await infra.get("/alerts/incidents?limit=1")).json();
    expect(visible.items.map((i: { subjectId: string }) => i.subjectId)).toEqual([a.nodeId]);
    expect(visible.nextCursor).toBeNull();
    const other = (await owner.get("/alerts/incidents")).json().items.find((i: { subjectId: string }) => i.subjectId === b.nodeId);
    expect((await infra.post(`/alerts/incidents/${other.id}/ack`)).statusCode).toBe(403);
    const ui = await UiSocket.open(t, infra);
    sockets.push(ui);
    expect((await ui.subscribe("alerts")).op).toBe("subscribed");
    expect((await ui.subscribe(`node:${b.nodeId}`)).op).toBe("error");
    await owner.post(`/alerts/incidents/${other.id}/ack`);
    const mine = (await owner.get("/alerts/incidents")).json().items.find((i: { subjectId: string }) => i.subjectId === a.nodeId);
    await owner.post(`/alerts/incidents/${mine.id}/ack`);
    const ev = await ui.waitForEvent("alerts", "alert.updated");
    expect((ev.data as { subjectId: string }).subjectId).toBe(a.nodeId);
    await new Promise((r) => setTimeout(r, 100));
    expect(ui.frames.filter((f) => f.op === "event" && (f.data as { subjectId: string }).subjectId === b.nodeId)).toEqual([]);
  });
});
