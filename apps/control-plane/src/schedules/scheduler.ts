import { randomUUID } from "node:crypto";
import type { ScheduleRun, ScheduleTask } from "@blockforge/contracts";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { AuditActor } from "../audit/service.js";
import type { BackupsService } from "../backups/service.js";
import type { Db } from "../db/client.js";
import { scheduleRuns, schedules, servers } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { EventBus } from "../events/bus.js";
import type { JobRunner } from "../jobs/runner.js";
import type { Clock } from "../lib/clock.js";
import { AppError } from "../lib/errors.js";
import type { RbacService } from "../rbac/service.js";
import type { ServerAccessService } from "../servers/access.js";
import type { ServersService } from "../servers/service.js";
import { nextRun } from "./cron.js";
import { pendingTasks, TASK_PERMISSION, type SchedulesService } from "./service.js";

/** A due time missed by more than this (control plane down) is not replayed; at most one catch-up. */
export const CATCH_UP_MS = 5 * 60_000;
export const RUN_RETENTION_MS = 30 * 86_400_000;
export const RUNS_KEPT_PER_SCHEDULE = 100;
const JOB_WAIT_MS = 6 * 3600_000;

export interface SchedulerDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  bus: EventBus;
  rbac: RbacService;
  access: ServerAccessService;
  servers: ServersService;
  backups: BackupsService;
  jobs: JobRunner;
  schedules: () => SchedulesService;
  /** Offsets between tasks (tests shorten them). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

type TaskResult = { status: "succeeded" | "failed" | "skipped"; message: string | null; jobId: string | null };

/**
 * Runs schedules (api.md "Schedules"): every tick claims due schedules with `FOR UPDATE SKIP LOCKED`
 * (several control planes never run one twice), at most one run per schedule, a single catch-up for a
 * time missed within the last 5 minutes. Tasks run in order with their offsets; each one re-checks the
 * last editor's current permissions on the server.
 */
export class Scheduler {
  private readonly running = new Set<Promise<void>>();
  private readonly abort = new AbortController();

  constructor(private readonly d: SchedulerDeps) {}

  /** Runs left `running` by a previous process are failed and their schedules unlocked. */
  async recover(): Promise<void> {
    const stale = await this.d.db.select().from(scheduleRuns).where(eq(scheduleRuns.status, "running"));
    for (const r of stale) {
      const tasks = r.tasks.map((t) => (t.status === "running" || t.status === "pending" ? { ...t, status: "failed" as const, message: t.status === "running" ? "interrupted" : t.message } : t));
      await this.d.db.update(scheduleRuns).set({ status: "failed", reason: "interrupted by a control-plane restart", tasks, finishedAt: new Date(this.d.clock.now()) }).where(eq(scheduleRuns.id, r.id));
      await this.d.db.update(schedules).set({ runningRunId: null, lastRunStatus: "failed" }).where(eq(schedules.runningRunId, r.id));
    }
    if (stale.length) this.d.logger.warn({ n: stale.length }, "interrupted schedule runs marked failed");
  }

  /** Claims due schedules and starts their runs. Returns the started run ids. */
  async tick(): Promise<string[]> {
    const now = this.d.clock.now();
    const nowDate = new Date(now);
    const started = await withTransaction(this.d.db, async (tx) => {
      const due = await tx
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), isNull(schedules.runningRunId), lte(schedules.nextRunAt, nowDate)))
        .orderBy(asc(schedules.nextRunAt))
        .limit(20)
        .for("update", { skipLocked: true });
      const ids: string[] = [];
      for (const s of due) {
        let next: Date | null;
        try {
          next = nextRun(s.cron, s.timezone, nowDate);
        } catch (err) {
          this.d.logger.warn({ err, scheduleId: s.id }, "schedule has an invalid trigger; disabled");
          await tx.update(schedules).set({ enabled: false, nextRunAt: null }).where(eq(schedules.id, s.id));
          continue;
        }
        const dueAt = s.nextRunAt!.getTime();
        // Missed by more than CATCH_UP_MS: run only if some occurrence fell within the catch-up window.
        const catchUp = now - dueAt <= CATCH_UP_MS || (nextRun(s.cron, s.timezone, new Date(now - CATCH_UP_MS))?.getTime() ?? Infinity) <= now;
        if (!catchUp) {
          await tx.update(schedules).set({ nextRunAt: next }).where(eq(schedules.id, s.id));
          continue;
        }
        const runId = randomUUID();
        await tx.insert(scheduleRuns).values({ id: runId, scheduleId: s.id, trigger: "cron", status: "running", tasks: pendingTasks(s.tasks), startedAt: nowDate });
        await tx.update(schedules).set({ runningRunId: runId, lastRunAt: nowDate, nextRunAt: next }).where(eq(schedules.id, s.id));
        ids.push(runId);
      }
      return ids;
    });
    for (const id of started) this.execute(id);
    return started;
  }

  /** Starts a claimed run in the background. */
  execute(runId: string): void {
    const p = this.run(runId)
      .catch((err: unknown) => this.d.logger.error({ err, runId }, "schedule run crashed"))
      .finally(() => this.running.delete(p));
    this.running.add(p);
  }

  /** Resolves when every run started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.idle();
  }

  private async run(runId: string): Promise<void> {
    const [run] = await this.d.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, runId)).limit(1);
    if (!run) return;
    const [s] = await this.d.db.select().from(schedules).where(eq(schedules.id, run.scheduleId)).limit(1);
    if (!s) return;
    void this.d.schedules().publish(s.id);
    const tasks: ScheduleRun["tasks"] = run.tasks.map((t) => ({ ...t }));
    const save = async (patch: Partial<typeof scheduleRuns.$inferInsert> = {}) => {
      await this.d.db.update(scheduleRuns).set({ tasks, ...patch }).where(eq(scheduleRuns.id, runId));
    };
    const finish = async (status: "succeeded" | "failed" | "skipped", reason: string | null) => {
      await save({ status, reason, finishedAt: new Date(this.d.clock.now()) });
      await this.d.db.update(schedules).set({ runningRunId: null, lastRunStatus: status }).where(and(eq(schedules.id, s.id), eq(schedules.runningRunId, runId)));
      if (status !== "skipped") {
        await this.d.bus.publish({
          type: status === "succeeded" ? "schedule.run.completed" : "schedule.run.failed",
          subjectType: "server",
          subjectId: s.serverId,
          data: { scheduleId: s.id, runId, trigger: run.trigger, reason },
        });
      }
      void this.d.schedules().publish(s.id);
    };

    const [srv] = await this.d.db.select({ state: servers.state }).from(servers).where(eq(servers.id, s.serverId)).limit(1);
    if (s.onlyWhenOnline && srv?.state !== "running" && srv?.state !== "degraded") {
      for (const t of tasks) t.status = "skipped";
      return finish("skipped", "server offline");
    }

    const actor: AuditActor = { actorType: "system", actorId: null, actorName: `schedule ${s.name}`.slice(0, 120), userId: s.updatedBy };
    let failed = false;
    let stopAfterFailure = false;
    for (let i = 0; i < s.tasks.length; i++) {
      const task = s.tasks[i]!;
      const t = tasks[i]!;
      if (stopAfterFailure) {
        t.status = "skipped";
        t.message = "skipped after an earlier task failed";
        continue;
      }
      if (task.offsetSeconds > 0) await (this.d.sleep ?? defaultSleep)(task.offsetSeconds * 1000, this.abort.signal);
      if (this.abort.signal.aborted) {
        t.status = "failed";
        t.message = "interrupted (control plane stopping)";
        failed = true;
        stopAfterFailure = true;
        continue;
      }
      t.status = "running";
      t.startedAt = this.d.clock.now();
      await save();
      const r = await this.runTask(s.serverId, s.updatedBy, task, s.id, actor).catch((err: unknown): TaskResult => ({ status: "failed", message: errorText(err), jobId: null }));
      t.status = r.status;
      t.message = r.message;
      t.jobId = r.jobId;
      t.finishedAt = this.d.clock.now();
      await save();
      if (r.status === "failed") {
        failed = true;
        if (!task.continueOnFailure) stopAfterFailure = true;
      }
    }
    return finish(failed ? "failed" : "succeeded", failed ? (tasks.find((t) => t.status === "failed")?.message ?? "a task failed") : null);
  }

  /** One task with the last editor's current permissions on the server (re-checked at run time). */
  private async runTask(serverId: string, editorId: string | null, task: ScheduleTask, scheduleId: string, actor: AuditActor): Promise<TaskResult> {
    const principal = editorId ? await this.d.rbac.loadPrincipal(editorId) : null;
    const access = principal ? await this.d.access.load(serverId, principal) : null;
    const needed = TASK_PERMISSION[task.action];
    if (!access || !access.permissions.has(needed)) {
      return { status: "failed", message: `FORBIDDEN: the schedule's last editor no longer holds ${needed}${access?.server.suspended ? " (server suspended)" : ""}`, jobId: null };
    }
    const state = access.server.state;
    switch (task.action) {
      case "command": {
        await this.d.servers.sendConsole(access, task.command, actor);
        return { status: "succeeded", message: null, jobId: null };
      }
      case "power": {
        const up = state === "running" || state === "degraded" || state === "starting";
        const down = state === "stopped" || state === "crashed";
        let op: "start" | "stop" | "restart" | "kill" = task.power;
        if (op === "start" && up) return { status: "succeeded", message: "already running", jobId: null };
        if ((op === "stop" || op === "kill") && down) return { status: "succeeded", message: "already stopped", jobId: null };
        if (op === "restart" && down) op = "start";
        const input = op === "stop" || op === "restart" ? { timeoutMs: 60_000 } : {};
        const { jobId } = await this.d.servers.startOperation(access, op, input, actor);
        return this.awaitJob(jobId);
      }
      case "backup": {
        const { jobId } = await this.d.backups.create(access, { ignore: task.ignore, rotate: task.rotate, locked: false, stopServer: false, scheduleId }, actor);
        return this.awaitJob(jobId);
      }
    }
  }

  private async awaitJob(jobId: string): Promise<TaskResult> {
    const row = await this.d.jobs.waitForCompletion(jobId, JOB_WAIT_MS);
    if (row.status === "succeeded") return { status: "succeeded", message: null, jobId };
    return { status: "failed", message: row.error ? `${row.error.code}: ${row.error.message}` : row.status, jobId };
  }

  /** Retention: 30 days and the last 100 runs per schedule. */
  async prune(): Promise<void> {
    const cutoff = new Date(this.d.clock.now() - RUN_RETENTION_MS);
    await this.d.db.execute(sql`
      DELETE FROM schedule_runs WHERE status <> 'running' AND (started_at < ${cutoff} OR id IN (
        SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY schedule_id ORDER BY started_at DESC) AS rn FROM schedule_runs) x
         WHERE x.rn > ${RUNS_KEPT_PER_SCHEDULE}))`);
  }
}

function errorText(err: unknown): string {
  if (err instanceof AppError) return `${err.code}: ${err.message}`;
  return (err as Error).message ?? String(err);
}
