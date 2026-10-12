/**
 * Regression tests for the Grok review of Phase 1–2 (docs/reviews/2026-10-12-control-plane.md).
 */
import { randomUUID } from "node:crypto";
import { generate } from "otplib";
import pg from "pg";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAuthenticator, RotationCoordinator } from "../../src/agents/authenticator.js";
import { AgentAuthError } from "../../src/agents/token.js";
import { WorkloadOwnership } from "../../src/agents/workload-ownership.js";
import { createDb } from "../../src/db/client.js";
import { runRetention } from "../../src/maintenance/retention.js";
import type { Clock } from "../../src/lib/clock.js";
import { ApiClient, createUserClient, OWNER_PASSWORD, startWithOwner, type TestApp } from "../support/app.js";
import { insertNode, insertServer, testPool } from "../support/db.js";
import { TEST_DATABASE_URL } from "../support/env.js";
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

/** Frozen in the middle of a TOTP step, so codes computed by the test are deterministic. */
class FrozenClock implements Clock {
  t = Math.floor(Date.now() / 30_000) * 30_000 + 15_000;
  now() {
    return this.t;
  }
}
const code = (secret: string, clock: FrozenClock, steps = 0) => generate({ secret, epoch: Math.floor(clock.t / 1000) + steps * 30 });

async function enableMfa(owner: ApiClient, clock: FrozenClock, confirmStep = -1): Promise<string> {
  const { secret } = (await owner.post("/auth/mfa/enroll")).json();
  const res = await owner.post("/auth/mfa/enroll/confirm", { code: await code(secret, clock, confirmStep) });
  expect(res.statusCode).toBe(204);
  return secret;
}

async function connectedAgent(t: TestApp, owner: ApiClient, opts: { requiresApproval?: boolean } = {}) {
  const token = (await owner.post("/nodes/enrollment-tokens", { label: "x", requiresApproval: opts.requiresApproval ?? false })).json().secretToken;
  const agent = new FakeAgent(t.baseUrl, t.wsBaseUrl);
  agents.push(agent);
  expect((await agent.enroll(token)).status).toBe(201);
  await agent.connect();
  await agent.hello();
  return { agent, nodeId: agent.nodeId as string };
}

async function poll(fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("#1 MFA disable vs pending sessions", () => {
  it("a session still waiting for MFA does not become authenticated when MFA is disabled", async () => {
    const clock = new FrozenClock();
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ clock }));
    const secret = await enableMfa(owner, clock);
    const pending = new ApiClient(t);
    expect((await pending.login("owner@example.com", OWNER_PASSWORD)).json()).toEqual({ status: "mfa_required" });
    expect((await pending.get("/users")).json().error.code).toBe("MFA_REQUIRED");
    expect((await owner.post("/auth/mfa/disable", { code: await code(secret, clock) })).statusCode).toBe(204);
    const after = await pending.get("/users");
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("UNAUTHENTICATED");
    expect((await owner.get("/users")).statusCode).toBe(200); // the verified session is unaffected
  });
});

describe("#2 TOTP acceptance is atomic", () => {
  it("accepts a code exactly once under concurrency and rejects out-of-order (older) codes", async () => {
    const clock = new FrozenClock();
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ clock }));
    const secret = await enableMfa(owner, clock, -1);
    const sessions = await Promise.all(
      [1, 2, 3, 4].map(async () => {
        const c = new ApiClient(t!);
        await c.login("owner@example.com", OWNER_PASSWORD);
        return c;
      }),
    );
    const current = await code(secret, clock, 0);
    const results = await Promise.all(sessions.slice(0, 3).map((c) => c.post("/auth/mfa/verify", { code: current })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400, 400]);
    // Newer step accepted, then an older (but still in-window) step is refused.
    const [d] = sessions.slice(3);
    const e = new ApiClient(t);
    await e.login("owner@example.com", OWNER_PASSWORD);
    expect((await d!.post("/auth/mfa/verify", { code: await code(secret, clock, 1) })).statusCode).toBe(200);
    expect((await e.post("/auth/mfa/verify", { code: current })).statusCode).toBe(400);
    const { rows } = await testPool().query("SELECT details->>'reason' AS reason FROM audit_events WHERE action = 'auth.mfa.verify' AND outcome = 'failed'");
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe("#3 login lockout", () => {
  it("counts parallel mixed-case failures atomically and locks the account", async () => {
    ({ t } = await startWithOwner());
    const variants = ["OWNER@example.com", "Owner@Example.com", "owner@EXAMPLE.com", "oWnEr@example.com", "owner@example.COM"];
    const res = await Promise.all(variants.map((e) => new ApiClient(t!).login(e, "definitely wrong password")));
    expect(res.every((r) => r.statusCode === 401)).toBe(true);
    const { rows } = await testPool().query("SELECT failed_login_count, locked_until FROM users WHERE email = 'owner@example.com'");
    expect(rows[0].failed_login_count).toBe(5);
    expect(rows[0].locked_until).not.toBeNull();
    expect((await new ApiClient(t).login("Owner@example.com", OWNER_PASSWORD)).statusCode).toBe(429);
  });

  it("gives identical responses for a locked real account and a 'locked' unknown address", async () => {
    ({ t } = await startWithOwner());
    const attempt = (email: string, password = "wrong password here") => new ApiClient(t!).login(email, password);
    for (let i = 0; i < 5; i++) {
      const real = await attempt("owner@example.com");
      const ghost = await attempt("ghost@example.com");
      expect([real.statusCode, ghost.statusCode]).toEqual([401, 401]);
      expect(real.json().error.message).toBe(ghost.json().error.message);
    }
    const real = await attempt("owner@example.com", OWNER_PASSWORD);
    const ghost = await attempt("ghost@example.com", OWNER_PASSWORD);
    const strip = (b: { error: { requestId: string } }) => ({ ...b, error: { ...b.error, requestId: "x" } });
    expect(real.statusCode).toBe(429);
    expect(ghost.statusCode).toBe(429);
    expect(strip(ghost.json())).toEqual(strip(real.json()));
    expect(ghost.headers["retry-after"]).toBe(real.headers["retry-after"]);
  });
});

describe("#6 login racing a credential change", () => {
  it("does not create a session when the password changed after it was verified", async () => {
    ({ t } = await startWithOwner());
    const db = t.ctx.db;
    const original = db.transaction.bind(db);
    let armed = true;
    // Simulates a password change committing between the password check and session creation.
    (db as { transaction: typeof db.transaction }).transaction = (async (fn: Parameters<typeof db.transaction>[0], cfg?: Parameters<typeof db.transaction>[1]) => {
      if (armed) {
        armed = false;
        await testPool().query("UPDATE users SET password_hash = 'changed-concurrently' WHERE email = 'owner@example.com'");
      }
      return original(fn, cfg);
    }) as typeof db.transaction;
    const before = (await testPool().query("SELECT count(*)::int AS n FROM sessions")).rows[0].n;
    const res = await new ApiClient(t).login("owner@example.com", OWNER_PASSWORD);
    (db as { transaction: typeof db.transaction }).transaction = original;
    expect(res.statusCode).toBe(401);
    expect((await testPool().query("SELECT count(*)::int AS n FROM sessions")).rows[0].n).toBe(before);
  });
});

describe("#4 node records on the nodes topic", () => {
  it("moderators (monitoring.view without nodes.view) receive no node.updated / node.metrics", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent, nodeId } = await connectedAgent(t, owner);
    const moderator = await createUserClient(t, owner, "mod@example.com", [{ roleKey: "moderator", scopeType: "global", scopeId: null }]);
    const mod = await UiSocket.open(t, moderator);
    const own = await UiSocket.open(t, owner);
    sockets.push(mod, own);
    expect((await mod.subscribe("nodes")).op).toBe("subscribed");
    expect((await own.subscribe("nodes")).op).toBe("subscribed");
    await owner.patch(`/nodes/${nodeId}`, { location: "Rack 9" });
    agent.metrics(nodeSample(Date.now()));
    await own.waitForEvent("nodes", "node.updated", 5000, (d) => (d as { location: string }).location === "Rack 9");
    await own.waitForEvent("nodes", "node.metrics");
    await new Promise((r) => setTimeout(r, 150));
    expect(mod.frames.filter((f) => f.op === "event")).toEqual([]);
  });
});

describe("#5 agent frame queue is bounded by bytes", () => {
  it("sheds oversized frames and keeps queued bytes under the hard budget without dropping the session", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ env: { AGENT_MAX_QUEUED_BYTES: String(64 * 1024) } }));
    const { agent, nodeId } = await connectedAgent(t, owner);
    const stats = t.ctx.gateway.stats;
    const before = stats.droppedQueuedFrames;
    agent.sendRaw(JSON.stringify({ t: "logs", workloadId: randomUUID(), lines: [{ ts: 1, stream: "stdout", line: "x".repeat(200 * 1024) }] }));
    await poll(() => stats.droppedQueuedFrames > before);
    const chunk = JSON.stringify({ t: "logs", workloadId: randomUUID(), lines: [{ ts: 1, stream: "stdout", line: "y".repeat(30 * 1024) }] });
    for (let i = 0; i < 60; i++) agent.sendRaw(chunk);
    const hbBefore = t.ctx.tracker.get(nodeId)?.lastHeartbeatAt ?? 0;
    // Heartbeats may themselves be shed while the burst drains; keep sending until one is processed.
    await poll(() => {
      agent.heartbeat();
      return (t!.ctx.tracker.get(nodeId)?.lastHeartbeatAt ?? 0) > hbBefore;
    }, 10_000);
    expect(stats.peakQueuedBytes).toBeLessThanOrEqual(128 * 1024);
    expect(stats.backpressurePauses + stats.droppedQueuedFrames - before).toBeGreaterThan(0);
    expect(t.ctx.gateway.isReady(nodeId)).toBe(true);
  });

  it("gives pending nodes a tiny budget and ignores their telemetry", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent, nodeId } = await connectedAgent(t, owner, { requiresApproval: true });
    const before = t.ctx.gateway.stats.droppedQueuedFrames;
    agent.sendRaw(JSON.stringify({ t: "heartbeat", ts: Date.now(), uptimeMs: 1, pad: "z".repeat(600 * 1024) }));
    await poll(() => t!.ctx.gateway.stats.droppedQueuedFrames > before);
    agent.metrics(nodeSample(Date.now()));
    await new Promise((r) => setTimeout(r, 150));
    expect(t.ctx.latest.getNode(nodeId)).toBeNull();
    expect(t.ctx.gateway.isReady(nodeId)).toBe(true);
  });
});

describe("#7 rotation wait is registered before the command is sent", () => {
  it("authenticates a new-key connection opened before the result reached the control plane", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ background: true, rotationConfirmTimeoutMs: 15_000 }));
    const { agent, nodeId } = await connectedAgent(t, owner);
    const oldKey = agent.publicKey;
    agent.enableKeyRotation("reconnect-first");
    const res = await owner.post(`/nodes/${nodeId}/rotate-credentials`);
    expect(res.statusCode).toBe(202);
    expect(res.json().node.id).toBe(nodeId);
    const row = await t.ctx.jobs.waitForCompletion(res.json().jobId, 30_000);
    expect(row.status).toBe("succeeded");
    expect(agent.publicKey).not.toBe(oldKey);
    const { rows } = await testPool().query("SELECT status FROM node_credentials WHERE node_id = $1 ORDER BY created_at", [nodeId]);
    expect(rows.map((r) => r.status)).toEqual(["rotated", "active"]);
  });

  it("also survives an agent that closes and reconnects in the same tick", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner({ background: true, rotationConfirmTimeoutMs: 15_000 }));
    const { agent, nodeId } = await connectedAgent(t, owner);
    agent.enableKeyRotation("immediate");
    const res = await owner.post(`/nodes/${nodeId}/rotate-credentials`);
    expect((await t.ctx.jobs.waitForCompletion(res.json().jobId, 30_000)).status).toBe("succeeded");
  });
});

describe("#8 revocation racing authentication", () => {
  it("refuses a socket whose handshake authenticated just before the revocation committed", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent, nodeId } = await connectedAgent(t, owner);
    await agent.close();
    const ctx = t.ctx;
    const original = ctx.authenticator.authenticate.bind(ctx.authenticator);
    ctx.authenticator.authenticate = async (header) => {
      const result = await original(header);
      // The revocation lands after the token was accepted but before the socket is attached.
      await ctx.nodes.revoke(nodeId, { actorType: "user", actorId: null, actorName: "test" });
      return result;
    };
    await agent.connect();
    expect(await agent.waitForClose()).toBe(4003);
    expect(ctx.gateway.isReady(nodeId)).toBe(false);
    ctx.authenticator.authenticate = original;
  });

  it("checks the node status inside the jti transaction (blocks on a concurrent revocation)", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { agent, nodeId } = await connectedAgent(t, owner);
    const auth = new AgentAuthenticator(createDb(testPool()), { now: () => Date.now() }, new RotationCoordinator(), pino({ level: "silent" }));
    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("UPDATE nodes SET status = 'revoked' WHERE id = $1", [nodeId]);
    const pending = auth.authenticate(agent.authHeader()).then(
      () => "ok",
      (err: unknown) => (err instanceof AgentAuthError ? err.reason : String(err)),
    );
    await new Promise((r) => setTimeout(r, 200));
    await blocker.query("COMMIT");
    await blocker.end();
    expect(await pending).toBe("node_rejected");
  });
});

describe("#9 workload ownership cache", () => {
  it("does not cache negative answers and honours invalidation", async () => {
    ({ t } = await startWithOwner());
    const pool = testPool();
    const nodeA = await insertNode(pool);
    const nodeB = await insertNode(pool);
    const own = new WorkloadOwnership(createDb(pool), { now: () => Date.now() });
    const serverId = randomUUID();
    expect([...(await own.owned(nodeA, [serverId]))]).toEqual([]); // not yet created: nothing cached
    expect(own.size).toBe(0);
    await insertServer(pool, nodeA, { id: serverId });
    expect([...(await own.owned(nodeA, [serverId]))]).toEqual([serverId]);
    await pool.query("UPDATE servers SET node_id = $1 WHERE id = $2", [nodeB, serverId]);
    own.invalidate(serverId);
    expect([...(await own.owned(nodeA, [serverId]))]).toEqual([]);
    expect([...(await own.owned(nodeB, [serverId]))]).toEqual([serverId]);
  });
});

describe("#10 retention", () => {
  it("deletes expired jobs (with logs) and finished deliveries, keeps recent ones", async () => {
    ({ t } = await startWithOwner());
    const pool = testPool();
    const old = randomUUID();
    const recent = randomUUID();
    for (const [id, age] of [
      [old, "40 days"],
      [recent, "1 day"],
    ] as const) {
      await pool.query(`INSERT INTO jobs (id, type, status, finished_at, created_at) VALUES ($1, 'x', 'succeeded', now() - $2::interval, now() - $2::interval)`, [id, age]);
      await pool.query(`INSERT INTO job_logs (job_id, ts, level, message) VALUES ($1, now(), 'info', 'm')`, [id]);
    }
    await pool.query(`INSERT INTO jobs (id, type, status, created_at) VALUES ($1, 'x', 'running', now() - interval '60 days')`, [randomUUID()]);
    const channel = randomUUID();
    await pool.query(`INSERT INTO notification_channels (id, name, kind) VALUES ($1, 'c', 'webhook')`, [channel]);
    await pool.query(
      `INSERT INTO notification_deliveries (id, channel_id, reason, status, payload, created_at) VALUES ($1, $2, 'test', 'succeeded', '{}', now() - interval '40 days'), ($3, $2, 'test', 'pending', '{}', now() - interval '40 days')`,
      [randomUUID(), channel, randomUUID()],
    );
    const r = await runRetention({ db: t.ctx.db, clock: t.ctx.clock, latest: t.ctx.latest, consoles: t.ctx.consoles });
    expect(r).toMatchObject({ jobs: 1, deliveries: 1 });
    expect((await pool.query("SELECT id FROM jobs WHERE id = ANY($1)", [[old, recent]])).rows.map((x) => x.id)).toEqual([recent]);
    expect((await pool.query("SELECT count(*)::int AS n FROM job_logs WHERE job_id = $1", [old])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE status = 'running'")).rows[0].n).toBe(1);
  });
});

describe("#12/#16 alert visibility", () => {
  it("scopes incident lists in SQL, hides global rules from scoped viewers and resolves incidents of deleted nodes", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const pool = testPool();
    const nodeA = await insertNode(pool, { name: "vis-a" });
    const nodeB = await insertNode(pool, { name: "vis-b" });
    await t.ctx.tracker.load();
    const mk = (subjectId: string, severity: string) =>
      pool.query(
        `INSERT INTO alert_incidents (id, dedup_key, kind, severity, status, subject_type, subject_id, summary, first_fired_at, last_fired_at)
         VALUES ($1, $2, 'node.cpu.high', $3, 'firing', 'node', $4, 's', now(), now())`,
        [randomUUID(), randomUUID(), severity, subjectId],
      );
    await mk(nodeA, "warning");
    await mk(nodeB, "critical");
    const infra = await createUserClient(t, owner, "infra@example.com", [{ roleKey: "infra_admin", scopeType: "node", scopeId: nodeA }]);
    const list = (await infra.get("/alerts/incidents")).json();
    expect(list.items.map((i: { subjectId: string }) => i.subjectId)).toEqual([nodeA]);
    expect((await infra.get("/overview")).json().activeAlerts).toEqual({ critical: 0, warning: 1, info: 0 });
    expect((await infra.get("/alerts/rules")).json()).toEqual([]); // seeded rules are global
    expect((await owner.get("/alerts/rules")).json().length).toBeGreaterThan(0);
    expect((await owner.delete(`/nodes/${nodeB}`)).statusCode).toBe(204);
    const open = (await owner.get("/alerts/incidents?status=open")).json().items.map((i: { subjectId: string }) => i.subjectId);
    expect(open).toEqual([nodeA]);
  });
});

describe("#14 global.players", () => {
  it("is visible to server-scoped viewers, aggregated over their servers only", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const node = await insertNode(testPool());
    const srv = await insertServer(testPool(), node);
    const viewer = await createUserClient(t, owner, "viewer@example.com", [{ roleKey: "server_admin", scopeType: "server", scopeId: srv }]);
    const now = Date.now();
    const res = await viewer.get(`/metrics/range?series=global.players&from=${now - 60_000}&to=${now}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().series).toBe("global.players");
  });
});
