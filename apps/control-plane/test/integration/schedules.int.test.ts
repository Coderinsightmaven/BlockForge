import { randomUUID } from "node:crypto";
import { Schedule, ScheduleRun } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { OffsetClock } from "../support/clock.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { catalogOptions, connectSimNode, paperRequest, templateIdByKey, waitJob, type SimNodeHandle } from "../support/panel.js";
import { UiSocket } from "../support/realtime-client.js";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
const sockets: UiSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.ctx.scheduler.idle();
  await t?.close();
  t = null;
});

const EVERY_5_MIN = { minute: "*/5", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" };
const DAILY_3AM = { minute: "0", hour: "3", dayOfMonth: "*", month: "*", dayOfWeek: "*" };

/** Offsets are recorded and, while `gate` is set, held until it resolves. */
const sleeps: number[] = [];
let gate: Promise<void> | null = null;

async function boot() {
  sleeps.length = 0;
  gate = null;
  const clock = new OffsetClock();
  const cat = catalogOptions();
  const r = await startWithOwner({
    background: true,
    clock,
    catalog: cat.catalog,
    serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0, saveTimeoutMs: 1500 },
    scheduler: {
      sleep: async (ms) => {
        sleeps.push(ms);
        if (gate) await gate;
      },
    },
  });
  t = r.t;
  const node = await connectSimNode(r.t, r.owner, { agents });
  const created = await r.owner.post("/servers", paperRequest(await templateIdByKey(r.owner, "minecraft-java")));
  expect((await waitJob(r.owner, created.json().jobId)).status).toBe("succeeded");
  return { ...r, clock, node, id: created.json().server.id as string };
}

const schedule = (over: Record<string, unknown> = {}) => ({ name: "Nightly", cron: EVERY_5_MIN, tasks: [{ action: "command", command: "say hi" }], ...over });
const runs = async (c: ApiClient, id: string, sid: string) => ((await c.get(`/servers/${id}/schedules/${sid}/runs`)).json().items as unknown[]).map((x) => ScheduleRun.parse(x));
const get = async (c: ApiClient, id: string, sid: string) => Schedule.parse((await c.get(`/servers/${id}/schedules/${sid}`)).json());
const consoleSent = (node: SimNodeHandle, id: string) => node.sim.consoleLines.filter((l) => l.workloadId === id).map((l) => l.line);

describe("schedules", () => {
  it("validates triggers and task permissions, previews cron times and publishes changes", async () => {
    const { t, owner, id } = await boot();
    const created = await owner.post(`/servers/${id}/schedules`, schedule());
    expect(created.statusCode, created.body).toBe(201);
    const s = Schedule.parse(created.json());
    expect(s).toMatchObject({ timezone: "UTC", enabled: true, running: false, lastRunAt: null, lastRunStatus: null });
    expect(s.nextRunAt! - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(new Date(s.nextRunAt!).getUTCMinutes() % 5).toBe(0);
    expect((await owner.post(`/servers/${id}/schedules`, schedule({ cron: { ...EVERY_5_MIN, minute: "61" } }))).statusCode).toBe(400);
    expect((await owner.post(`/servers/${id}/schedules`, schedule({ timezone: "Mars/Olympus" }))).statusCode).toBe(400);

    const preview = (await owner.post("/schedules/preview", { cron: DAILY_3AM, timezone: "Europe/Berlin", count: 3 })).json();
    expect(preview).toMatchObject({ valid: true, error: null, description: null });
    expect(preview.next).toHaveLength(3);
    for (const n of preview.next as number[]) expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(n)).toBe("03:00");
    expect((await owner.post("/schedules/preview", { cron: { ...DAILY_3AM, hour: "25" }, timezone: "UTC" })).json()).toMatchObject({ valid: false, next: [] });

    // No escalation through schedules: tasks need the editor's own permissions.
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    await owner.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view", "schedules.view", "schedules.manage", "servers.console.send"] });
    expect((await bob.post(`/servers/${id}/schedules`, schedule({ tasks: [{ action: "power", power: "restart" }] }))).statusCode).toBe(403);
    expect((await bob.post(`/servers/${id}/schedules`, schedule())).statusCode).toBe(201);

    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    await ui.subscribe(`server:${id}`);
    const updated = await owner.put(`/servers/${id}/schedules/${s.id}`, schedule({ name: "Renamed", enabled: false }));
    expect(updated.json()).toMatchObject({ name: "Renamed", enabled: false, nextRunAt: null });
    await ui.waitForEvent(`server:${id}`, "schedule.updated", 5000, (d) => (d as Schedule).name === "Renamed");
    expect((await owner.delete(`/servers/${id}/schedules/${s.id}`)).statusCode).toBe(204);
    await ui.waitForEvent(`server:${id}`, "schedule.deleted", 5000, (d) => (d as { scheduleId: string }).scheduleId === s.id);
    expect(ui.invalid).toEqual([]);
  });

  it("runs due schedules once: command, power (waits for the job) and backup tasks in order with offsets", async () => {
    const { t, owner, clock, node, id } = await boot();
    const s = Schedule.parse(
      (
        await owner.post(
          `/servers/${id}/schedules`,
          schedule({
            tasks: [
              { action: "command", command: "say restarting" },
              { action: "power", power: "restart", offsetSeconds: 2 },
              { action: "backup", rotate: true, offsetSeconds: 1 },
            ],
          }),
        )
      ).json(),
    );
    expect(await t.ctx.scheduler.tick()).toEqual([]);
    // Due now. (The clock is not advanced here: readiness compares the agent's real line timestamps.)
    await testPool().query("UPDATE schedules SET next_run_at = $1 WHERE id = $2", [new Date(clock.now() - 1000), s.id]);
    // Two schedulers ticking at once: one run.
    const [a, b] = await Promise.all([t.ctx.scheduler.tick(), t.ctx.scheduler.tick()]);
    expect([...a, ...b]).toHaveLength(1);
    await t.ctx.scheduler.idle();
    const [run] = await runs(owner, id, s.id);
    expect(run).toMatchObject({ trigger: "cron", status: "succeeded", reason: null });
    expect(run!.tasks.map((x) => [x.action, x.status])).toEqual([
      ["command", "succeeded"],
      ["power", "succeeded"],
      ["backup", "succeeded"],
    ]);
    expect(run!.tasks[1]!.jobId).not.toBeNull();
    expect(sleeps).toEqual([2000, 1000]);
    expect(consoleSent(node, id)).toContain("say restarting");
    const after = await get(owner, id, s.id);
    expect(after).toMatchObject({ running: false, lastRunStatus: "succeeded" });
    expect(after.nextRunAt!).toBeGreaterThan(clock.now());
    const { rows: backups } = await testPool().query("SELECT schedule_id, created_by FROM backups WHERE server_id = $1", [id]);
    expect(backups).toEqual([{ schedule_id: s.id, created_by: null }]);
    const { rows: ev } = await testPool().query("SELECT type FROM events WHERE subject_id = $1 AND type LIKE 'schedule.%'", [id]);
    expect(ev.map((e) => e.type)).toEqual(["schedule.run.completed"]);
    // Not due again until the next time.
    expect(await t.ctx.scheduler.tick()).toEqual([]);
  });

  it("skips offline servers, stops after a failed task unless continueOnFailure, and re-checks permissions at run time", async () => {
    const { t, owner, id } = await boot();
    const stop = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    await waitJob(owner, stop.json().jobId);

    const online = Schedule.parse((await owner.post(`/servers/${id}/schedules`, schedule({ onlyWhenOnline: true }))).json());
    const strict = Schedule.parse((await owner.post(`/servers/${id}/schedules`, schedule({ tasks: [{ action: "command", command: "say a" }, { action: "power", power: "start" }] }))).json());
    const lenient = Schedule.parse(
      (await owner.post(`/servers/${id}/schedules`, schedule({ tasks: [{ action: "command", command: "say a", continueOnFailure: true }, { action: "power", power: "start" }] }))).json(),
    );
    for (const s of [online, strict, lenient]) {
      const r = await owner.post(`/servers/${id}/schedules/${s.id}/run`);
      expect(r.statusCode).toBe(202);
      await t.ctx.scheduler.idle();
    }
    expect((await runs(owner, id, online.id))[0]).toMatchObject({ trigger: "manual", status: "skipped", reason: "server offline" });
    expect((await get(owner, id, online.id)).lastRunStatus).toBe("skipped");
    const sr = (await runs(owner, id, strict.id))[0]!;
    expect(sr.status).toBe("failed");
    expect(sr.tasks.map((x) => x.status)).toEqual(["failed", "skipped"]);
    expect(sr.tasks[0]!.message).toMatch(/INVALID_STATE/);
    const lr = (await runs(owner, id, lenient.id))[0]!;
    expect(lr.status).toBe("failed");
    expect(lr.tasks.map((x) => x.status)).toEqual(["failed", "succeeded"]);
    expect((await owner.get(`/servers/${id}`)).json().state).toBe("running");

    // The last editor lost servers.console.send: the task fails with FORBIDDEN at run time.
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    const sub = await owner.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view", "schedules.view", "schedules.manage", "servers.console.send"] });
    const bobs = Schedule.parse((await bob.post(`/servers/${id}/schedules`, schedule())).json());
    expect((await owner.put(`/servers/${id}/subusers/${sub.json().id}`, { permissions: ["servers.view", "schedules.view", "schedules.manage"] })).statusCode).toBe(200);
    // Running it by hand needs the task permissions (H2) ...
    expect((await bob.post(`/servers/${id}/schedules/${bobs.id}/run`)).statusCode).toBe(403);
    // ... and a scheduled run re-checks the editor's permissions at run time.
    await testPool().query("UPDATE schedules SET next_run_at = now() - interval '1 second' WHERE id = $1", [bobs.id]);
    expect(await t.ctx.scheduler.tick()).toHaveLength(1);
    await t.ctx.scheduler.idle();
    const br = (await runs(owner, id, bobs.id))[0]!;
    expect(br).toMatchObject({ status: "failed" });
    expect(br.tasks[0]!.message).toMatch(/^FORBIDDEN/);
  });

  it("allows one run at a time, catches up once within 5 minutes, recovers interrupted runs and prunes history", async () => {
    const { t, owner, clock, id } = await boot();
    const s = Schedule.parse((await owner.post(`/servers/${id}/schedules`, schedule({ tasks: [{ action: "command", command: "say slow", offsetSeconds: 5 }] }))).json());
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    expect((await owner.post(`/servers/${id}/schedules/${s.id}/run`)).statusCode).toBe(202);
    expect((await owner.post(`/servers/${id}/schedules/${s.id}/run`)).statusCode).toBe(409);
    expect((await get(owner, id, s.id)).running).toBe(true);
    // While running, a due time does not start a second run.
    // (Due via the database, not the clock: advancing the clock would also expire the run's lease.)
    await testPool().query("UPDATE schedules SET next_run_at = $1 WHERE id = $2", [new Date(clock.now() - 1000), s.id]);
    expect(await t.ctx.scheduler.tick()).toEqual([]);
    release();
    gate = null;
    await t.ctx.scheduler.idle();
    expect((await get(owner, id, s.id)).running).toBe(false);
    // Still due (missed while running, within 5 minutes): one catch-up run on the next tick.
    expect(await t.ctx.scheduler.tick()).toHaveLength(1);
    await t.ctx.scheduler.idle();
    await owner.put(`/servers/${id}/schedules/${s.id}`, schedule({ enabled: false, tasks: [{ action: "command", command: "say slow", offsetSeconds: 5 }] }));

    // Missed long ago (control plane down): not replayed; missed within 5 minutes: one catch-up run.
    const daily = Schedule.parse((await owner.post(`/servers/${id}/schedules`, schedule({ cron: DAILY_3AM }))).json());
    const now = clock.now();
    await testPool().query("UPDATE schedules SET next_run_at = $1 WHERE id = $2", [new Date(now - 10 * 60_000), daily.id]);
    expect(await t.ctx.scheduler.tick()).toEqual([]);
    expect((await get(owner, id, daily.id)).nextRunAt!).toBeGreaterThan(now);
    await testPool().query("UPDATE schedules SET next_run_at = $1 WHERE id = $2", [new Date(now - 2 * 60_000), daily.id]);
    expect(await t.ctx.scheduler.tick()).toHaveLength(1);
    await t.ctx.scheduler.idle();

    // A run left `running` by a crashed control plane is failed and the schedule unlocked.
    const stale = randomUUID();
    await testPool().query("INSERT INTO schedule_runs (id, schedule_id, trigger, status, tasks, started_at) VALUES ($1, $2, 'cron', 'running', $3, now())", [
      stale,
      s.id,
      JSON.stringify([{ index: 0, action: "command", status: "running", message: null, jobId: null, startedAt: null, finishedAt: null }]),
    ]);
    await testPool().query("UPDATE schedules SET running_run_id = $1 WHERE id = $2", [stale, s.id]);
    await t.ctx.scheduler.recover();
    const recovered = (await runs(owner, id, s.id)).find((r) => r.id === stale)!;
    expect(recovered).toMatchObject({ status: "failed", reason: "interrupted by a control-plane restart" });
    expect(await get(owner, id, s.id)).toMatchObject({ running: false, lastRunStatus: "failed" });

    // Retention: 30 days and 100 runs per schedule.
    await testPool().query(
      `INSERT INTO schedule_runs (id, schedule_id, trigger, status, tasks, started_at, finished_at)
       SELECT gen_random_uuid(), $1, 'cron', 'succeeded', '[]'::jsonb, now() - (g || ' minutes')::interval, now() FROM generate_series(1, 110) g`,
      [s.id],
    );
    await testPool().query("INSERT INTO schedule_runs (id, schedule_id, trigger, status, tasks, started_at) VALUES ($1, $2, 'cron', 'succeeded', '[]'::jsonb, now() - interval '40 days')", [randomUUID(), daily.id]);
    await t.ctx.scheduler.prune();
    const { rows } = await testPool().query("SELECT schedule_id, count(*)::int AS n FROM schedule_runs GROUP BY schedule_id");
    const counts = Object.fromEntries(rows.map((r) => [r.schedule_id, r.n]));
    expect(counts[s.id]).toBe(100);
    expect(counts[daily.id]).toBe(1);
    // Paging through runs.
    const page1 = (await owner.get(`/servers/${id}/schedules/${s.id}/runs?limit=60`)).json();
    expect(page1.items).toHaveLength(60);
    const page2 = (await owner.get(`/servers/${id}/schedules/${s.id}/runs?limit=60&cursor=${encodeURIComponent(page1.nextCursor)}`)).json();
    expect(page2.items).toHaveLength(40);
    expect(page2.nextCursor).toBeNull();
  });
});
