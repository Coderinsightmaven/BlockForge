import { Job } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_LOG_LINES_PER_JOB } from "../../src/jobs/runner.js";
import { JobError, type JobDefinition } from "../../src/jobs/types.js";
import type { ApiClient} from "../support/app.js";
import { createUserClient, startWithOwner, type TestApp } from "../support/app.js";
import { insertNode, testPool } from "../support/db.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const counters = { s1: 0, s2: 0, recover1: 0, recover2: 0, afterCheckpoint: 0 };
const Input = z.object({ nodeId: z.uuid().optional(), lines: z.number().int().optional() });

const testJobs: JobDefinition<z.infer<typeof Input>>[] = [
  {
    type: "test.resume",
    input: Input,
    cancelPermission: "nodes.manage",
    retryLimit: 2,
    retryDelaySeconds: 1,
    steps: [
      {
        key: "s1",
        label: "Step one",
        async run(ctx) {
          counters.s1++;
          ctx.state.fromStep1 = "kept";
          await ctx.log("info", "step one done");
        },
      },
      {
        key: "s2",
        label: "Step two (fails once)",
        async run(ctx) {
          counters.s2++;
          if (ctx.attempt === 1) throw new JobError("FLAKY", "transient failure", true);
          ctx.state.sawState = ctx.state.fromStep1;
        },
      },
    ],
    result: (state) => ({ sawState: state.sawState }),
  },
  {
    type: "test.fail",
    input: Input,
    cancelPermission: "nodes.manage",
    steps: [
      {
        key: "only",
        label: "Fails permanently",
        async run() {
          throw new JobError("BROKEN", "this cannot work", false);
        },
      },
      { key: "never", label: "Never runs", run: async () => undefined },
    ],
  },
  {
    type: "test.wait",
    input: Input,
    cancelPermission: "nodes.manage",
    steps: [
      {
        key: "wait",
        label: "Waits for cancellation",
        async run(ctx) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 20_000);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(ctx.signal.reason);
            });
          });
        },
      },
    ],
  },
  {
    type: "test.spam",
    input: Input,
    cancelPermission: "nodes.manage",
    steps: [
      {
        key: "spam",
        label: "Logs a lot",
        async run(ctx) {
          for (let i = 0; i < (ctx.input.lines ?? 0); i++) await ctx.log("debug", `line ${i}`);
        },
      },
    ],
  },
  {
    type: "test.checkpoint-then-throw",
    input: Input,
    cancelPermission: "nodes.manage",
    retryLimit: 0,
    steps: [
      {
        key: "done",
        label: "Completes, then throws",
        async run(ctx) {
          ctx.state.recorded = true;
          await ctx.checkpoint(undefined, { completeStep: true });
          throw new JobError("LATE", "failure after the completion was committed");
        },
      },
      { key: "next", label: "Runs afterwards", run: async () => void counters.afterCheckpoint++ },
    ],
  },
  {
    type: "test.recover",
    input: Input,
    cancelPermission: "nodes.manage",
    steps: [
      { key: "a", label: "A", run: async () => void counters.recover1++ },
      { key: "b", label: "B", run: async () => void counters.recover2++ },
    ],
  },
];

async function start() {
  const r = await startWithOwner({ background: true, extraJobs: testJobs });
  t = r.t;
  return r;
}

describe("job runner", () => {
  it("retries retryable failures with backoff and resumes after the completed steps", async () => {
    const { owner } = await start();
    const nodeId = await insertNode(testPool());
    const before = { ...counters };
    const jobId = await t!.ctx.jobs.enqueue("test.resume", { nodeId }, { targetType: "node", targetId: nodeId });
    const row = await t!.ctx.jobs.waitForCompletion(jobId, 30_000);
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(2);
    expect(counters.s1 - before.s1).toBe(1); // completed step skipped on retry
    expect(counters.s2 - before.s2).toBe(2);
    const job = Job.parse((await owner.get(`/jobs/${jobId}`)).json());
    expect(job.result).toEqual({ sawState: "kept" });
    expect(job.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
    const logs = (await owner.get(`/jobs/${jobId}/logs`)).json();
    expect(logs.map((l: { message: string }) => l.message)).toEqual(
      expect.arrayContaining(["step one done", "Attempt 1 failed (FLAKY): transient failure — will retry", "Attempt 2 of 3"]),
    );
    const after = (await owner.get(`/jobs/${jobId}/logs?afterId=${logs[1].id}`)).json();
    expect(after.length).toBe(logs.length - 2);
  });

  it("fails permanently on non-retryable errors, emits job.updated and raises a job.failed alert", async () => {
    const { owner } = await start();
    const nodeId = await insertNode(testPool(), { name: "broken-node" });
    await t!.ctx.tracker.load();
    const jobId = await t!.ctx.jobs.enqueue("test.fail", { nodeId }, { targetType: "node", targetId: nodeId });
    const row = await t!.ctx.jobs.waitForCompletion(jobId);
    expect(row).toMatchObject({ status: "failed", attempts: 1, error: { code: "BROKEN", message: "this cannot work" } });
    const job = Job.parse((await owner.get(`/jobs/${jobId}`)).json());
    expect(job.steps.map((s) => `${s.key}:${s.status}`)).toEqual(["only:failed", "never:skipped"]);
    const { rows } = await testPool().query("SELECT data FROM events WHERE type = 'job.updated' AND subject_id = $1", [jobId]);
    expect(rows[0].data).toMatchObject({ status: "failed", type: "test.fail" });
    const incidents = await (async () => {
      for (let i = 0; i < 50; i++) {
        const r = (await owner.get("/alerts/incidents?status=open")).json();
        if (r.items.length) return r.items;
        await new Promise((res) => setTimeout(res, 100));
      }
      return [];
    })();
    expect(incidents[0]).toMatchObject({ kind: "job.failed", severity: "warning", subjectType: "node", subjectId: nodeId, subjectName: "broken-node" });
    const overview = (await owner.get("/overview")).json();
    expect(overview.recentFailedJobs[0]).toMatchObject({ jobId, type: "test.fail", targetName: "broken-node", message: "this cannot work" });
    expect(overview.activeAlerts.warning).toBe(1);
  });

  it("cancels running jobs, with idempotent replays of the cancel request", async () => {
    const { owner } = await start();
    const nodeId = await insertNode(testPool());
    const jobId = await t!.ctx.jobs.enqueue("test.wait", { nodeId }, { targetType: "node", targetId: nodeId });
    for (let i = 0; i < 100 && (await t!.ctx.jobs.getRow(jobId))?.status !== "running"; i++) await new Promise((r) => setTimeout(r, 50));
    const first = await owner.request("POST", `/jobs/${jobId}/cancel`, {}, { "idempotency-key": "cancel-1" });
    expect(first.statusCode).toBe(200);
    const row = await t!.ctx.jobs.waitForCompletion(jobId);
    expect(row.status).toBe("cancelled");
    const replay = await owner.request("POST", `/jobs/${jobId}/cancel`, {}, { "idempotency-key": "cancel-1" });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());
    // Same key, different request → conflict; a fresh cancel of a finished job → invalid state.
    const other = await t!.ctx.jobs.enqueue("test.wait", { nodeId }, { targetType: "node", targetId: nodeId });
    expect((await owner.request("POST", `/jobs/${other}/cancel`, {}, { "idempotency-key": "cancel-1" })).statusCode).toBe(409);
    expect((await owner.post(`/jobs/${jobId}/cancel`)).json().error.code).toBe("INVALID_STATE");
    expect((await owner.request("POST", `/jobs/${other}/cancel`, {}, { "idempotency-key": "has spaces" })).statusCode).toBe(400);
    await owner.post(`/jobs/${other}/cancel`);
    expect((await t!.ctx.jobs.waitForCompletion(other)).status).toBe("cancelled");
  });

  it("caps job logs at 2000 lines", async () => {
    await start();
    const jobId = await t!.ctx.jobs.enqueue("test.spam", { lines: MAX_LOG_LINES_PER_JOB + 100 });
    await t!.ctx.jobs.waitForCompletion(jobId, 60_000);
    const { rows } = await testPool().query("SELECT count(*)::int AS n, max(id) AS last FROM job_logs WHERE job_id = $1", [jobId]);
    expect(rows[0].n).toBe(MAX_LOG_LINES_PER_JOB);
    const { rows: last } = await testPool().query("SELECT level, message FROM job_logs WHERE id = $1", [rows[0].last]);
    expect(last[0]).toMatchObject({ level: "warn", message: expect.stringContaining("Log limit") });
  }, 90_000);

  it("a step whose completing checkpoint committed stays succeeded when it throws afterwards", async () => {
    await start();
    const before = counters.afterCheckpoint;
    const jobId = await t!.ctx.jobs.enqueue("test.checkpoint-then-throw", {});
    const row = await t!.ctx.jobs.waitForCompletion(jobId);
    expect(row.status).toBe("succeeded");
    expect(row.state).toMatchObject({ recorded: true });
    expect(counters.afterCheckpoint - before).toBe(1);
    const { rows } = await testPool().query("SELECT key, status FROM job_steps WHERE job_id = $1 ORDER BY ordinal", [jobId]);
    expect(rows).toEqual([
      { key: "done", status: "succeeded" },
      { key: "next", status: "succeeded" },
    ]);
    expect((await t!.ctx.jobs.logs(jobId, 0)).map((l) => l.message)).toContainEqual(expect.stringContaining("a later error was ignored"));
  });

  it("resumes jobs that were running when the control plane stopped", async () => {
    await start();
    const before = { ...counters };
    const jobId = await t!.ctx.jobs.enqueue("test.recover", {});
    await t!.ctx.jobs.waitForCompletion(jobId);
    await t!.ctx.jobs.stop();
    // Simulate a crash in step b: a completed step a, step b mid-flight, job "running".
    await testPool().query("UPDATE jobs SET status = 'running', finished_at = NULL WHERE id = $1", [jobId]);
    await testPool().query("UPDATE job_steps SET status = 'running', finished_at = NULL WHERE job_id = $1 AND key = 'b'", [jobId]);
    await t!.ctx.jobs.start();
    const row = await t!.ctx.jobs.waitForCompletion(jobId);
    expect(row.status).toBe("succeeded");
    expect(counters.recover1 - before.recover1).toBe(1);
    expect(counters.recover2 - before.recover2).toBe(2);
    const logs = await t!.ctx.jobs.logs(jobId, 0);
    expect(logs.map((l) => l.message)).toContain("Control plane restarted; resuming job");
  });

  it("filters job lists by scope", async () => {
    const { owner } = await start();
    const nodeA = await insertNode(testPool(), { name: "job-a" });
    const nodeB = await insertNode(testPool(), { name: "job-b" });
    const jobA = await t!.ctx.jobs.enqueue("test.recover", { nodeId: nodeA }, { targetType: "node", targetId: nodeA });
    const jobB = await t!.ctx.jobs.enqueue("test.recover", { nodeId: nodeB }, { targetType: "node", targetId: nodeB });
    await t!.ctx.jobs.waitForCompletion(jobA);
    await t!.ctx.jobs.waitForCompletion(jobB);
    const infra: ApiClient = await createUserClient(t!, owner, "infra@example.com", [{ roleKey: "infra_admin", scopeType: "node", scopeId: nodeA }]);
    const mine = (await infra.get("/jobs")).json();
    expect(mine.items.map((j: { id: string }) => j.id)).toEqual([jobA]);
    expect((await infra.get(`/jobs/${jobB}`)).statusCode).toBe(403);
    expect((await infra.get(`/jobs/${jobA}`)).statusCode).toBe(200);
    expect((await infra.post(`/jobs/${jobB}/cancel`)).statusCode).toBe(403);
    const all = (await owner.get("/jobs?limit=1")).json();
    expect(all.items).toHaveLength(1);
    const next = (await owner.get(`/jobs?limit=1&cursor=${all.nextCursor}`)).json();
    expect(next.items[0].id).not.toBe(all.items[0].id);
    expect((await owner.get(`/jobs?targetId=${nodeB}`)).json().items.map((j: { id: string }) => j.id)).toEqual([jobB]);
    expect((await owner.get("/jobs?status=failed")).json().items).toEqual([]);
  });
});
