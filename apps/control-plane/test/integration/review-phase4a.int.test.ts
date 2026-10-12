import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, ListMultipartUploadsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { AccountPermissions, Backup, BUILTIN_ROLES, CreatedApiKey, Schedule, ScheduleRun, TransferUrlResponse } from "@blockforge/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { abortStaleUploads, pruneFailedBackups, removeBackup, retryPendingSaveOn } from "../../src/backups/jobs.js";
import type { S3Config } from "../../src/backups/storage.js";
import { createUserClient, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import { TEST_S3 } from "../support/env.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { catalogOptions, connectSimNode, PANEL_FACTS, paperRequest, poll, templateIdByKey, waitJob, type SimNodeHandle } from "../support/panel.js";

/** Regression tests for the Codex Phase 4a review (docs/reviews/2026-10-12-control-plane-phase4a.md). */

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
afterEach(async () => {
  gate = null;
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.ctx.scheduler.idle();
  await t?.close();
  t = null;
});

/** Schedule task offsets wait here while `gate` is set. */
let gate: Promise<void> | null = null;

async function boot(timing: { saveTimeoutMs?: number; saveToggleTimeoutMs?: number } = {}, env: Record<string, string> = {}) {
  const cat = catalogOptions();
  const r = await startWithOwner({
    background: true,
    catalog: cat.catalog,
    // No periodic scheduler tick during a test (ticks are driven explicitly).
    env: { SCHEDULER_INTERVAL_MS: "300000", ...env },
    serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0, saveTimeoutMs: timing.saveTimeoutMs ?? 1500, saveToggleTimeoutMs: timing.saveToggleTimeoutMs ?? 1500 },
    scheduler: {
      sleep: async () => {
        if (gate) await gate;
      },
    },
  });
  t = r.t;
  const node = await connectSimNode(r.t, r.owner, { agents });
  return { ...r, node };
}

async function paperServer(owner: ApiClient, over: Record<string, unknown> = {}): Promise<string> {
  const created = await owner.post("/servers", paperRequest(await templateIdByKey(owner, "minecraft-java"), over));
  expect(created.statusCode, created.body).toBe(202);
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  return created.json().server.id as string;
}

async function backupJob(c: ApiClient, owner: ApiClient, id: string, body: Record<string, unknown> = {}) {
  const r = await c.post(`/servers/${id}/backups`, body);
  expect(r.statusCode, r.body).toBe(202);
  const job = await waitJob(owner, r.json().jobId);
  return { backupId: r.json().backup.id as string, jobId: r.json().jobId as string, job: job as Record<string, unknown> & { status: string; error?: { code: string; message: string } } };
}

const state = async (c: ApiClient, id: string) => (await c.get(`/servers/${id}`)).json().state as string;
const list = async (c: ApiClient, id: string) => ((await c.get(`/servers/${id}/backups`)).json() as unknown[]).map((b) => Backup.parse(b));
const userId = async (c: ApiClient) => (await c.get("/auth/me")).json().user.id as string;
const sent = (node: SimNodeHandle, id: string) => node.sim.consoleLines.filter((l) => l.workloadId === id).map((l) => l.line);
const pending = async (id: string) => (await testPool().query("SELECT save_on_pending FROM servers WHERE id = $1", [id])).rows[0].save_on_pending as boolean;

/** Command types (and console lines) the sim received for a server, in order. */
function trail(node: SimNodeHandle, serverId: string): string[] {
  return node.agent.commands
    .filter((c) => (c.payload as { workloadId?: string }).workloadId === serverId)
    .map((c) => (c.type === "workload.console" ? `console:${(c.payload as { line: string }).line}` : c.type));
}

/** Data statements of migration 0004 (comments stripped), by their first words. */
const MIGRATION_0004 = readFileSync(fileURLToPath(new URL("../../drizzle/0004_phase4_review.sql", import.meta.url)), "utf8")
  .split("--> statement-breakpoint")
  .map((s) =>
    s
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter(Boolean);
const statement = (start: string) => {
  const s = MIGRATION_0004.find((x) => x.startsWith(start));
  if (!s) throw new Error(`no statement starting with ${start}`);
  return s;
};

describe("backups: rotation, locks, retention, permissions (B1, H5, H6, M6, L3)", () => {
  it("B1: rotates out the oldest backup only after the new one is complete; a failed backup keeps it", async () => {
    const { t, owner, node } = await boot();
    const alice = await createUserClient(t, owner, "alice@example.com", []);
    const id = await paperServer(owner, { ownerId: await userId(alice), startup: "manual", backupLimit: 1 });
    node.sim.put(id, "world/level.dat", "v1");
    const first = await backupJob(alice, owner, id, { name: "first" });
    expect(first.job.status).toBe("succeeded");

    // The node is out of space: the new backup fails with a clear message and the old one is untouched.
    node.sim.options = { fail: { "backup.create": { code: "QUOTA_EXCEEDED", message: "free disk below the reserve" } } };
    const failed = await backupJob(alice, owner, id, { name: "second", rotate: true });
    expect(failed.job.status).toBe("failed");
    expect(failed.job.error).toMatchObject({ code: "QUOTA_EXCEEDED", message: expect.stringContaining("not have enough free disk space") });
    expect((await list(alice, id)).filter((b) => b.status === "completed").map((b) => b.id)).toEqual([first.backupId]);
    expect(node.sim.backupArchives.has(`${id}:${first.backupId}`)).toBe(true);

    // Success: the new archive is created (and the row completed) before the oldest one is deleted.
    node.sim.options = {};
    const mark = node.agent.commands.length;
    const third = await backupJob(alice, owner, id, { name: "third", rotate: true });
    expect(third.job.status).toBe("succeeded");
    const ops = node.agent.commands
      .slice(mark)
      .filter((c) => c.type.startsWith("backup."))
      .map((c) => `${c.type}:${(c.payload as { backupId: string }).backupId}`);
    expect(ops).toEqual([`backup.create:${third.backupId}`, `backup.delete:${first.backupId}`]);
    expect((await list(alice, id)).filter((b) => b.status === "completed").map((b) => b.id)).toEqual([third.backupId]);
  });

  it("H5: deletion is a conditional delete of an unlocked row; a locked backup is never removed", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner, { startup: "manual" });
    const b = await backupJob(owner, owner, id, { name: "keep" });
    await owner.patch(`/servers/${id}/backups/${b.backupId}`, { locked: true });
    // The delete path (job, rotation, pruning) deletes `WHERE locked = false` first: a lock wins.
    expect(await removeBackup(t.ctx.backupJobs, b.backupId)).toBeNull();
    expect((await list(owner, id)).map((x) => x.id)).toEqual([b.backupId]);
    expect(node.sim.backupArchives.has(`${id}:${b.backupId}`)).toBe(true);
    await owner.patch(`/servers/${id}/backups/${b.backupId}`, { locked: false });
    expect(await removeBackup(t.ctx.backupJobs, b.backupId)).toMatchObject({ id: b.backupId });
    expect(await list(owner, id)).toEqual([]);
    expect(node.sim.backupArchives.has(`${id}:${b.backupId}`)).toBe(false);
  });

  it("H6/M6/L3: failed backups are pruned (10 per server, 7 days), the list is paginated, locked backups need delete", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner, { startup: "manual", backupLimit: 20 });
    const ok = await backupJob(owner, owner, id, { name: "good" });
    const insertFailed = (n: number, minutesAgo: number) =>
      testPool().query(
        `INSERT INTO backups (id, server_id, name, status, storage, created_at)
         SELECT gen_random_uuid(), $1, 'failed-' || g, 'failed', 'local', now() - ((g + $2) || ' minutes')::interval FROM generate_series(1, $3) g`,
        [id, minutesAgo, n],
      );
    await insertFailed(5, 0);
    await testPool().query("INSERT INTO backups (id, server_id, name, status, storage, created_at) VALUES ($1, $2, 'old', 'failed', 'local', now() - interval '8 days')", [randomUUID(), id]);
    await testPool().query("INSERT INTO backups (id, server_id, name, status, storage, locked, created_at) VALUES ($1, $2, 'old-locked', 'failed', 'local', true, now() - interval '9 days')", [
      randomUUID(),
      id,
    ]);
    // Older than 7 days → removed (unless locked); completed backups are never touched.
    expect(await pruneFailedBackups(t.ctx.backupJobs)).toBe(1);
    const names = async () => (await testPool().query("SELECT name FROM backups WHERE server_id = $1 ORDER BY name", [id])).rows.map((r) => r.name as string);
    expect(await names()).not.toContain("old");
    expect(await names()).toContain("old-locked");
    expect(await names()).toContain("good");
    // More than 10 failed: the newest 10 stay.
    await insertFailed(7, 100);
    expect(await pruneFailedBackups(t.ctx.backupJobs)).toBe(2);
    const { rows } = await testPool().query("SELECT count(*)::int AS n FROM backups WHERE server_id = $1 AND status = 'failed' AND NOT locked", [id]);
    expect(rows[0].n).toBe(10);
    // The data of pruned rows is deleted on the node too.
    expect(trail(node, id).filter((x) => x === "backup.delete").length).toBeGreaterThanOrEqual(3);

    // M6: the list is paginated (?limit / ?cursor, next page in x-next-cursor): 1 good + 10 failed + 1 locked.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await owner.get(`/servers/${id}/backups?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.statusCode).toBe(200);
      seen.push(...(r.json() as unknown[]).map((b) => Backup.parse(b).id));
      cursor = r.headers["x-next-cursor"] as string | undefined;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen).toContain(ok.backupId);
    expect((await owner.get(`/servers/${id}/backups?limit=501`)).statusCode).toBe(400);

    // L3: creating a locked backup needs servers.backups.delete (only that permission can unlock it).
    const carol = await createUserClient(t, owner, "carol@example.com", []);
    const sub = await owner.post(`/servers/${id}/subusers`, { user: "carol", permissions: ["servers.view", "servers.backups.view", "servers.backups.create"] });
    expect(sub.statusCode, sub.body).toBe(201);
    const locked = await carol.post(`/servers/${id}/backups`, { name: "pinned", locked: true });
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error.message).toContain("servers.backups.delete");
    const plain = await carol.post(`/servers/${id}/backups`, { name: "plain" });
    expect(plain.statusCode, plain.body).toBe(202);
    await waitJob(owner, plain.json().jobId);
    await owner.put(`/servers/${id}/subusers/${sub.json().id}`, { permissions: ["servers.view", "servers.backups.view", "servers.backups.create", "servers.backups.delete"] });
    const allowed = await carol.post(`/servers/${id}/backups`, { name: "pinned", locked: true });
    expect(allowed.statusCode, allowed.body).toBe(202);
    await waitJob(owner, allowed.json().jobId);
  });
});

describe("backups: the Minecraft save cycle and the server state (H7, H8, M1)", () => {
  it("H7: only a confirmation after save-all counts (console sequence, not timestamps; clock skew either way)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    // A stale "Saved the game" stamped an hour ahead by a skewed agent clock is not this save's confirmation.
    node.agent.logs(id, [{ ts: Date.now() + 3_600_000, stream: "stdout", line: "[12:00:00 INFO]: Saved the game" }]);
    await poll(async () => t!.ctx.consoles.tail(id, 10).lines.some((l) => l.line.endsWith("Saved the game")));
    node.sim.options = { saveConfirm: false };
    const stale = await backupJob(owner, owner, id, { name: "stale" });
    expect(stale.job.status).toBe("failed");
    expect(stale.job.error).toMatchObject({ code: "SAVE_TIMEOUT" });
    // An agent clock an hour behind: its (older-looking) confirmation still counts.
    node.sim.options = { clockSkewMs: -3_600_000 };
    const skewed = await backupJob(owner, owner, id, { name: "skewed" });
    expect(skewed.job.status, JSON.stringify(skewed.job)).toBe("succeeded");
    expect((await list(owner, id)).find((b) => b.id === skewed.backupId)).toMatchObject({ status: "completed", consistency: "save-flush" });
    expect(await state(owner, id)).toBe("running");
  });

  it("Grok 4b #1: the save-all wait needs this save's progress line; forged or stray confirmations do not end it", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    // A mod logging "Saved the game" through its own logger, and a real-looking confirmation that
    // arrives before this save's "Saving the game …" line (an earlier save / autosave).
    const stray = ["[12:00:00] [Server thread/INFO] [EvilMod]: Saved the game", "[12:00:00 INFO]: Saved the game"];
    node.sim.options = { saveConfirm: false, saveStrayLines: stray };
    const forged = await backupJob(owner, owner, id, { name: "forged" });
    expect(forged.job.status).toBe("failed");
    expect(forged.job.error).toMatchObject({ code: "SAVE_TIMEOUT" });
    // The same stray lines followed by the real progress + confirmation: accepted.
    node.sim.options = { saveStrayLines: stray };
    const real = await backupJob(owner, owner, id, { name: "real" });
    expect(real.job.status, JSON.stringify(real.job)).toBe("succeeded");
    expect((await list(owner, id)).find((b) => b.id === real.backupId)).toMatchObject({ status: "completed", consistency: "save-flush" });
  });

  it("H7: a save failure fails at once and an unconfirmed save-off stops the backup (save-on is still sent)", async () => {
    // A long save timeout: the failure must not wait for it.
    const { owner, node } = await boot({ saveTimeoutMs: 60_000, saveToggleTimeoutMs: 1000 });
    const id = await paperServer(owner);
    node.sim.options = { saveFailure: true };
    const started = Date.now();
    const failed = await backupJob(owner, owner, id, { name: "disk-full" });
    expect(failed.job.status).toBe("failed");
    expect(failed.job.error).toMatchObject({ code: "SAVE_FAILED" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(sent(node, id).at(-1)).toBe("save-on");

    node.sim.options = { saveOffConfirm: false };
    const mark = trail(node, id).length;
    const off = await backupJob(owner, owner, id, { name: "no-save-off" });
    expect(off.job.error).toMatchObject({ code: "SAVE_OFF_TIMEOUT" });
    // No save-all and no archive without a confirmed save-off; save-on, state settle and cleanup follow.
    expect(trail(node, id).slice(mark)).toEqual(["workload.status", "console:save-off", "console:save-on", "workload.status", "backup.delete"]);
    expect(await state(owner, id)).toBe("running");
    expect(await pending(id)).toBe(false);
  });

  it("H8: the state after a backup comes from the workload (a crash during the backup is not hidden)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.options = { exitDuringBackup: true };
    const b = await backupJob(owner, owner, id, { name: "crashy" });
    expect(b.job.status).toBe("succeeded");
    expect((await list(owner, id))[0]).toMatchObject({ status: "completed" });
    expect(await state(owner, id)).toBe("crashed");
    const { rows } = await testPool().query("SELECT active_operation, last_exit_code FROM servers WHERE id = $1", [id]);
    expect(rows[0]).toMatchObject({ active_operation: null, last_exit_code: 1 });
  });

  it("M1: an unacknowledged save-on stays pending and is retried on reconnect and by maintenance", async () => {
    const { t, owner, node } = await boot({ saveToggleTimeoutMs: 500 });
    const id = await paperServer(owner);
    const saveOns = () => sent(node, id).filter((l) => l === "save-on").length;
    node.sim.options = { saveOnConfirm: false };
    const b = await backupJob(owner, owner, id, { name: "unacked" });
    expect(b.job.status).toBe("succeeded");
    expect(JSON.stringify((await owner.get(`/jobs/${b.jobId}/logs`)).json())).toContain("will be retried");
    expect(await pending(id)).toBe(true);
    // Still not acknowledged: stays pending.
    expect(await retryPendingSaveOn(t.ctx.backupJobs)).toBe(0);
    expect(await pending(id)).toBe(true);

    // The node reconnects (and now answers): save-on is sent again and acknowledged.
    node.sim.options = {};
    const before = saveOns();
    await node.agent.close();
    await poll(async () => t.ctx.tracker.get(node.nodeId)?.connection === "unreachable");
    await node.agent.connect();
    await node.agent.hello([node.sim.status(id)], PANEL_FACTS);
    await poll(async () => !(await pending(id)), 10_000);
    expect(saveOns()).toBe(before + 1);

    // Periodic maintenance retries too.
    await testPool().query("UPDATE servers SET save_on_pending = true WHERE id = $1", [id]);
    await t.tasks.maintenance!.runNow();
    expect(await pending(id)).toBe(false);
    expect(saveOns()).toBe(before + 2);

    // A server that is no longer running re-enabled autosave by restarting: the flag is just cleared.
    await poll(async () => (await state(owner, id)) === "running");
    const stop = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    expect(stop.statusCode, stop.body).toBe(202);
    expect((await waitJob(owner, stop.json().jobId)).status).toBe("succeeded");
    await testPool().query("UPDATE servers SET save_on_pending = true WHERE id = $1", [id]);
    expect(await retryPendingSaveOn(t.ctx.backupJobs)).toBe(0);
    expect(await pending(id)).toBe(false);
    expect(saveOns()).toBe(before + 2);
  });
});

describe("migration 0004 (H1, H4)", () => {
  it("revokes pre-0003 / non-standard API tokens and gives S3 settings and backups a storage reference", async () => {
    const { t, owner } = await boot();
    const uid = await userId(owner);
    const token = (prefix: string, createdAt: string) =>
      testPool().query("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
        randomUUID(),
        uid,
        prefix,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        prefix,
        createdAt,
      ]);
    // H1: a pre-0003 row (possibly revoked or scoped before those columns were dropped) and a legacy-format one.
    await token("bfk_00112233445566aa", "2026-10-01T00:00:00Z");
    await token("bft_legacy", new Date().toISOString());
    await token("bfk_8899aabbccddeeff", new Date().toISOString());
    await testPool().query(statement(`DELETE FROM "api_tokens"`));
    const { rows: left } = await testPool().query("SELECT prefix FROM api_tokens ORDER BY prefix");
    expect(left.map((r) => r.prefix)).toEqual(["bfk_8899aabbccddeeff"]);

    // H4: settings stored before secret versioning point at the legacy secret row; S3 backups get a reference.
    const secretId = await t.ctx.secrets.create({ scopeType: "global", scopeId: null }, "backups.s3.secretAccessKey", "legacy-secret");
    const legacy = { type: "s3", endpoint: "https://s3.example.com", region: "eu-1", bucket: "old", prefix: "bf/", forcePathStyle: true, accessKeyId: "AKIA" };
    await testPool().query("UPDATE settings SET value = $1 WHERE key = 'backups.storage'", [JSON.stringify(legacy)]);
    await testPool().query("INSERT INTO settings (key, value) SELECT 'backups.storage', $1::jsonb WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'backups.storage')", [JSON.stringify(legacy)]);
    const id = await paperServer(owner, { startup: "manual" });
    const bid = randomUUID();
    await testPool().query("INSERT INTO backups (id, server_id, name, status, storage, object_key) VALUES ($1, $2, 'legacy', 'completed', 's3', 'bf/x.tar.gz')", [bid, id]);
    await testPool().query(statement(`UPDATE "settings"`));
    await testPool().query(statement(`UPDATE "backups"`));
    const { rows: s } = await testPool().query("SELECT value FROM settings WHERE key = 'backups.storage'");
    expect(s[0].value).toEqual({ ...legacy, secretId });
    const { rows: b } = await testPool().query("SELECT storage_ref FROM backups WHERE id = $1", [bid]);
    expect(b[0].storage_ref).toEqual({ endpoint: legacy.endpoint, region: legacy.region, bucket: "old", prefix: "bf/", forcePathStyle: true, accessKeyId: "AKIA", secretId });
  });
});

describe("schedules (H2, H3, M3, M4, M5, M6)", () => {
  const schedule = (over: Record<string, unknown> = {}) => ({
    name: "Task",
    cron: { minute: "*/5", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
    tasks: [{ action: "command", command: "say hi" }],
    ...over,
  });
  const runs = async (c: ApiClient, id: string, sid: string) => ((await c.get(`/servers/${id}/schedules/${sid}/runs`)).json().items as unknown[]).map((x) => ScheduleRun.parse(x));

  it("H2/H3: run-now needs every task's permission and runs as the caller under a lease; only expired leases are recovered", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    await owner.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view", "schedules.view", "schedules.manage", "servers.console.send"] });
    const power = Schedule.parse((await owner.post(`/servers/${id}/schedules`, schedule({ tasks: [{ action: "command", command: "say a" }, { action: "power", power: "restart" }] }))).json());
    const denied = await bob.post(`/servers/${id}/schedules/${power.id}/run`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain("servers.control");
    expect(await runs(owner, id, power.id)).toEqual([]);

    // A schedule last edited by the owner, run by bob: it executes with bob's permissions.
    const say = Schedule.parse((await owner.post(`/servers/${id}/schedules`, schedule({ tasks: [{ action: "command", command: "say from bob" }] }))).json());
    const run = await bob.post(`/servers/${id}/schedules/${say.id}/run`);
    expect(run.statusCode, run.body).toBe(202);
    const { rows: lease } = await testPool().query("SELECT runner_id, lease_expires_at, definition FROM schedule_runs WHERE schedule_id = $1", [say.id]);
    expect(lease[0].runner_id).toBe(t.ctx.scheduler.runnerId);
    expect(new Date(lease[0].lease_expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(lease[0].definition).toMatchObject({ updatedBy: await userId(bob), tasks: [{ action: "command", command: "say from bob" }] });
    await t.ctx.scheduler.idle();
    expect((await runs(owner, id, say.id))[0]).toMatchObject({ trigger: "manual", status: "succeeded" });
    expect(sent(node, id)).toContain("say from bob");

    // H3: a run held by another (live) replica is left alone; once its lease expires it is recovered.
    const other = randomUUID();
    await testPool().query(
      "INSERT INTO schedule_runs (id, schedule_id, trigger, status, tasks, runner_id, lease_expires_at, started_at) VALUES ($1, $2, 'cron', 'running', '[]'::jsonb, 'other-replica', now() + interval '60 seconds', now())",
      [other, say.id],
    );
    await testPool().query("UPDATE schedules SET running_run_id = $1 WHERE id = $2", [other, say.id]);
    expect(await t.ctx.scheduler.recover()).toBe(0);
    expect(await t.ctx.scheduler.tick()).toEqual([]);
    expect((await runs(owner, id, say.id)).find((r) => r.id === other)).toMatchObject({ status: "running" });
    await testPool().query("UPDATE schedule_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [other]);
    expect(await t.ctx.scheduler.recover()).toBe(1);
    expect((await runs(owner, id, say.id)).find((r) => r.id === other)).toMatchObject({ status: "failed", reason: "interrupted by a control-plane restart" });
    expect(Schedule.parse((await owner.get(`/servers/${id}/schedules/${say.id}`)).json()).running).toBe(false);
  });

  it("M3/M6: one tick drains every due schedule in batches; at most 50 schedules per server", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    for (let i = 0; i < 45; i++) {
      const r = await owner.post(`/servers/${id}/schedules`, schedule({ name: `s${i}`, tasks: [{ action: "command", command: `say ${i}` }] }));
      expect(r.statusCode, r.body).toBe(201);
    }
    await testPool().query("UPDATE schedules SET next_run_at = now() - interval '1 second'");
    expect(await t.ctx.scheduler.tick()).toHaveLength(45);
    await t.ctx.scheduler.idle();
    const { rows } = await testPool().query("SELECT status, count(*)::int AS n FROM schedule_runs GROUP BY status");
    expect(rows).toEqual([{ status: "succeeded", n: 45 }]);
    expect(sent(node, id).filter((l) => l.startsWith("say ")).length).toBe(45);

    for (let i = 45; i < 50; i++) expect((await owner.post(`/servers/${id}/schedules`, schedule({ name: `s${i}` }))).statusCode).toBe(201);
    const over = await owner.post(`/servers/${id}/schedules`, schedule({ name: "s50" }));
    expect(over.statusCode).toBe(409);
    expect(over.json().error.message).toContain("50");
  });

  it("M5: a run executes the definition it was claimed with; deleting the schedule fences the remaining tasks", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    const tasks = [
      { action: "command", command: "say one" },
      { action: "command", command: "say two", offsetSeconds: 1 },
    ];
    const s = Schedule.parse((await owner.post(`/servers/${id}/schedules`, schedule({ tasks }))).json());
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    expect((await owner.post(`/servers/${id}/schedules/${s.id}/run`)).statusCode).toBe(202);
    await poll(async () => sent(node, id).includes("say one"));
    // Edited mid-run: the running run keeps its snapshot.
    expect((await owner.put(`/servers/${id}/schedules/${s.id}`, schedule({ tasks: [{ action: "command", command: "say changed" }] }))).statusCode).toBe(200);
    release();
    gate = null;
    await t.ctx.scheduler.idle();
    const [run] = await runs(owner, id, s.id);
    expect(run!.tasks.map((x) => [x.action, x.status])).toEqual([
      ["command", "succeeded"],
      ["command", "succeeded"],
    ]);
    expect(sent(node, id)).toContain("say two");
    expect(sent(node, id)).not.toContain("say changed");

    // Deleted mid-run: the next task does not run.
    await owner.put(`/servers/${id}/schedules/${s.id}`, schedule({ tasks: [{ action: "command", command: "say three" }, { action: "command", command: "say four", offsetSeconds: 1 }] }));
    gate = new Promise((r) => (release = r));
    expect((await owner.post(`/servers/${id}/schedules/${s.id}/run`)).statusCode).toBe(202);
    await poll(async () => sent(node, id).includes("say three"));
    expect((await owner.delete(`/servers/${id}/schedules/${s.id}`)).statusCode).toBe(204);
    release();
    gate = null;
    await t.ctx.scheduler.idle();
    expect(sent(node, id)).not.toContain("say four");
  });

  it("M4: waiting for a task's job ends at once when the scheduler stops", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    const s = Schedule.parse((await owner.post(`/servers/${id}/schedules`, schedule({ tasks: [{ action: "backup" }] }))).json());
    node.sim.options = { delay: { "backup.create": 3000 } };
    expect((await owner.post(`/servers/${id}/schedules/${s.id}/run`)).statusCode).toBe(202);
    await poll(async () => (await testPool().query("SELECT 1 FROM backups WHERE server_id = $1 AND status = 'running'", [id])).rowCount === 1);
    const started = Date.now();
    await t.ctx.scheduler.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    const [run] = await runs(owner, id, s.id);
    expect(run).toMatchObject({ status: "failed" });
    expect(run!.tasks[0]!.message).toBe("interrupted (control plane stopping)");
  });
});

describe("API keys (L1) and GET /account/permissions", () => {
  function keyClient(t: TestApp, secret: string) {
    return {
      get: (url: string) => t.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${secret}` } }),
    };
  }
  async function createKey(c: ApiClient, body: Record<string, unknown>) {
    const r = await c.post("/account/api-keys", body);
    expect(r.statusCode, r.body).toBe(201);
    return CreatedApiKey.parse(r.json());
  }

  it("L1: the per-key limit is counted in the database (shared by replicas); invalid keys are throttled per IP", async () => {
    const r = await startWithOwner({ env: { API_KEY_RATE_LIMIT_PER_MIN: "5" } });
    t = r.t;
    const created = await createKey(r.owner, { name: "ci" });
    const k = keyClient(r.t, created.secret);
    expect((await k.get("/servers")).statusCode).toBe(200);
    const { rows } = await testPool().query("SELECT count FROM api_key_usage WHERE key_id = $1", [created.key.id]);
    expect(rows).toEqual([{ count: 1 }]);
    // Another replica used up this minute (and the next, so a window boundary cannot interfere).
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    await testPool().query(
      "INSERT INTO api_key_usage (key_id, window_start, count) VALUES ($1, $2, 5), ($1, $3, 5) ON CONFLICT (key_id, window_start) DO UPDATE SET count = 5",
      [created.key.id, new Date(minute), new Date(minute + 60_000)],
    );
    expect((await k.get("/servers")).statusCode).toBe(429);
    // Old windows are pruned by maintenance.
    await testPool().query("INSERT INTO api_key_usage (key_id, window_start, count) VALUES ($1, now() - interval '1 hour', 3)", [created.key.id]);
    await r.t.ctx.apiKeys.pruneUsage();
    const { rows: windows } = await testPool().query("SELECT count(*)::int AS n FROM api_key_usage WHERE key_id = $1", [created.key.id]);
    expect(windows[0].n).toBe(2);

    // Invalid keys: 30 failures per IP within 5 minutes, then even a valid key is refused from that IP.
    const valid = keyClient(r.t, (await createKey(r.owner, { name: "other" })).secret);
    for (let i = 0; i < 30; i++) expect((await keyClient(r.t, `bfk_${"0".repeat(16)}_${"A".repeat(43)}`).get("/servers")).statusCode).toBe(401);
    expect((await keyClient(r.t, "bfk_nope").get("/servers")).statusCode).toBe(429);
    expect((await valid.get("/servers")).statusCode).toBe(429);
    // Sessions are unaffected.
    expect((await r.owner.get("/servers")).statusCode).toBe(200);
  });

  it("returns global, scoped and per-server permissions (owner / subuser), limited for API keys", async () => {
    const { t, owner } = await boot();
    const alice = await createUserClient(t, owner, "alice@example.com", [{ roleKey: "observer", scopeType: "global", scopeId: null }]);
    const aliceId = await userId(alice);
    const alpha = await paperServer(owner, { name: "Alpha", ownerId: aliceId, startup: "manual" });
    const beta = await paperServer(owner, { name: "Beta", startup: "manual" });
    expect((await owner.post(`/servers/${beta}/subusers`, { user: "alice", permissions: ["servers.view", "servers.console.send"] })).statusCode).toBe(201);
    const bound = await owner.post(`/users/${aliceId}/roles`, { roleKey: "moderator", scopeType: "server", scopeId: beta });
    expect(bound.statusCode, bound.body).toBeLessThan(300);

    const p = AccountPermissions.parse((await alice.get("/account/permissions")).json());
    expect(p.global).toEqual([...new Set(BUILTIN_ROLES.observer.permissions)].sort());
    expect(p.scoped).toEqual([{ scopeType: "server", scopeId: beta, permissions: [...new Set(BUILTIN_ROLES.moderator.permissions)].sort() }]);
    expect(p.servers.map((s) => [s.serverName, s.via])).toEqual([
      ["Alpha", "owner"],
      ["Beta", "subuser"],
    ]);
    expect(p.servers[0]!.permissions).toEqual(expect.arrayContaining(["servers.view", "servers.control", "servers.backups.delete", "schedules.manage"]));
    expect(p.servers[1]!.permissions).toEqual(["servers.console.send", "servers.view"]);

    // A suspended server leaves only view permissions.
    await testPool().query("UPDATE servers SET suspended = true WHERE id = $1", [alpha]);
    const suspended = AccountPermissions.parse((await alice.get("/account/permissions")).json());
    expect(suspended.servers[0]!.permissions.every((x) => x.endsWith(".view"))).toBe(true);
    await testPool().query("UPDATE servers SET suspended = false WHERE id = $1", [alpha]);

    // API keys may read it (the one /account route they may use), limited to the key's permissions.
    const key = await createKey(alice, { name: "narrow", permissions: ["servers.view", "nodes.view"] });
    const viaKey = await keyClient(t, key.secret).get("/account/permissions");
    expect(viaKey.statusCode, viaKey.body).toBe(200);
    const kp = AccountPermissions.parse(viaKey.json());
    expect(kp.global).toEqual(["nodes.view", "servers.view"].filter((x) => (BUILTIN_ROLES.observer.permissions as readonly string[]).includes(x)));
    expect(kp.servers.map((s) => s.permissions)).toEqual([["servers.view"], ["servers.view"]]);
    expect(kp.scoped.every((s) => s.permissions.every((x) => x === "servers.view" || x === "nodes.view"))).toBe(true);
    expect((await keyClient(t, key.secret).get("/account/api-keys")).statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/account/permissions" })).statusCode).toBe(401);
  });
});

describe("console backfill (L2)", () => {
  it("always fetches BACKFILL_MAX_LINES and is not suppressed by control-plane system lines", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    t.ctx.consoles.remove(id);
    t.ctx.consoles.appendSystem(id, Date.now(), "[blockforge] server started by owner");
    node.sim.options = { logTail: ["[12:00:00 INFO]: Starting minecraft server", '[12:00:02 INFO]: Done (1.0s)! For help, type "help"'] };
    const h = (await owner.get(`/servers/${id}/console/history?lines=5`)).json() as { lines: { line: string }[] };
    const tails = node.agent.commands.filter((c) => c.type === "workload.logs.tail" && (c.payload as { workloadId: string }).workloadId === id);
    expect(tails).toHaveLength(1);
    expect((tails[0]!.payload as { lines: number }).lines).toBe(500);
    expect(h.lines.map((l) => l.line)).toEqual(expect.arrayContaining(["[12:00:00 INFO]: Starting minecraft server", '[12:00:02 INFO]: Done (1.0s)! For help, type "help"']));
  });
});

describe("S3 storage references, upload hygiene (H4, H6, M2, M7)", () => {
  const s3 = new S3Client({ endpoint: TEST_S3.endpoint, region: TEST_S3.region, forcePathStyle: true, credentials: { accessKeyId: TEST_S3.accessKeyId, secretAccessKey: TEST_S3.secretAccessKey } });
  let bucketA = "";
  let bucketB = "";
  beforeAll(async () => {
    bucketA = `bf-a-${randomUUID().slice(0, 8)}`;
    bucketB = `bf-b-${randomUUID().slice(0, 8)}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucketA }));
    await s3.send(new CreateBucketCommand({ Bucket: bucketB }));
  });
  const settings = (bucket: string) => ({
    type: "s3",
    endpoint: TEST_S3.endpoint,
    region: TEST_S3.region,
    bucket,
    prefix: "bf/",
    forcePathStyle: true,
    accessKeyId: TEST_S3.accessKeyId,
    secretAccessKey: TEST_S3.secretAccessKey,
  });
  const keys = async (bucket: string, prefix: string) => ((await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))).Contents ?? []).map((o) => o.Key!);
  const secretCount = async () => (await testPool().query("SELECT count(*)::int AS n FROM secrets WHERE name LIKE 'backups.s3.secretAccessKey%'")).rows[0].n as number;

  it("keeps each backup's storage location and credentials across settings changes; cleans up failed uploads", async () => {
    const { t, owner, node } = await boot();
    expect((await owner.put("/settings/backups.storage", { value: settings(bucketA) })).statusCode).toBe(200);
    const id = await paperServer(owner, { startup: "manual" });
    node.sim.put(id, "world/level.dat", "in-a");
    const a1 = await backupJob(owner, owner, id, { name: "a1" });
    expect(a1.job.status, JSON.stringify(a1.job)).toBe("succeeded");
    expect(await keys(bucketA, `bf/${id}/`)).toEqual([`bf/${id}/${a1.backupId}.tar.gz`]);

    // M7: presigned part URLs carry no SDK checksum parameters (the agent PUTs raw bytes).
    const upload = node.agent.commands.find((c) => c.type === "backup.upload")!;
    const urls = (upload.payload as { parts: { url: string }[] }).parts.map((p) => p.url.toLowerCase());
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).not.toContain("x-amz-checksum");
      expect(u).not.toContain("x-amz-sdk-checksum-algorithm");
    }

    // H4: the settings move to bucket B with a new secret version; a1 keeps bucket A and its secret.
    expect((await owner.put("/settings/backups.storage", { value: settings(bucketB) })).statusCode).toBe(200);
    expect(await secretCount()).toBe(2);
    const { rows: refs } = await testPool().query("SELECT storage_ref FROM backups WHERE id = $1", [a1.backupId]);
    expect(refs[0].storage_ref).toMatchObject({ bucket: bucketA, prefix: "bf/" });
    const dl = TransferUrlResponse.parse((await owner.get(`/servers/${id}/backups/${a1.backupId}/download`)).json());
    expect(dl.url.startsWith(`${TEST_S3.endpoint}/${bucketA}/bf/${id}/${a1.backupId}.tar.gz?`)).toBe(true);
    expect((await fetch(dl.url)).status).toBe(200);
    node.sim.put(id, "world/level.dat", "changed");
    const restore = await owner.post(`/servers/${id}/backups/${a1.backupId}/restore`, { safetyBackup: false, startAfter: false });
    expect((await waitJob(owner, restore.json().jobId)).status).toBe("succeeded");
    expect(node.sim.read(id, "world/level.dat")).toBe("in-a");
    const b1 = await backupJob(owner, owner, id, { name: "b1" });
    expect(b1.job.status).toBe("succeeded");
    expect(await keys(bucketB, `bf/${id}/`)).toEqual([`bf/${id}/${b1.backupId}.tar.gz`]);
    // Deleting a1 deletes the object in bucket A (not in B) and releases the old secret version.
    const del = await owner.delete(`/servers/${id}/backups/${a1.backupId}`);
    expect((await waitJob(owner, del.json().jobId)).status).toBe("succeeded");
    expect(await keys(bucketA, `bf/${id}/`)).toEqual([]);
    expect(await keys(bucketB, `bf/${id}/`)).toEqual([`bf/${id}/${b1.backupId}.tar.gz`]);
    expect(await secretCount()).toBe(1);

    // H6: a failed upload removes the node-local archive too (no uncounted disk usage) and the open upload.
    node.sim.options = { fail: { "backup.upload": { code: "RUNTIME_ERROR", message: "connection reset" } } };
    const broken = await backupJob(owner, owner, id, { name: "broken" });
    expect(broken.job.status).toBe("failed");
    expect(node.sim.backupArchives.has(`${id}:${broken.backupId}`)).toBe(false);
    expect((await s3.send(new ListMultipartUploadsCommand({ Bucket: bucketB, Prefix: `bf/${id}/` }))).Uploads ?? []).toEqual([]);
    node.sim.options = {};

    // M2: an upload id persisted by a job that died is aborted by the startup/periodic sweep.
    const cfg = (await t.ctx.backupStorage.current()) as S3Config;
    const key = t.ctx.backupStorage.objectKey(cfg, id, broken.backupId);
    const uploadId = await t.ctx.backupStorage.createMultipart(cfg, key);
    await testPool().query("UPDATE backups SET upload_id = $1, object_key = $2 WHERE id = $3", [uploadId, key, broken.backupId]);
    expect(((await s3.send(new ListMultipartUploadsCommand({ Bucket: bucketB, Prefix: key }))).Uploads ?? []).length).toBe(1);
    expect(await abortStaleUploads(t.ctx.backupJobs)).toBe(1);
    expect((await s3.send(new ListMultipartUploadsCommand({ Bucket: bucketB, Prefix: key }))).Uploads ?? []).toEqual([]);
    const { rows: open } = await testPool().query("SELECT upload_id FROM backups WHERE id = $1", [broken.backupId]);
    expect(open[0].upload_id).toBeNull();
  });
});
