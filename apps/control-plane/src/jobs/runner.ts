import { randomUUID } from "node:crypto";
import type { Job, JobLogLine } from "@blockforge/contracts";
import { and, asc, count, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import type { Logger } from "pino";
import type { Db, DbOrTx, Tx } from "../db/client.js";
import { jobLogs, jobs, jobSteps } from "../db/schema/index.js";
import { withTransaction, type AfterCommit } from "../db/tx.js";
import type { EventBus } from "../events/bus.js";
import { toJsonSafe } from "../lib/canonical-json.js";
import type { Clock } from "../lib/clock.js";
import { conflict, errorMessage, invalidState, notFound } from "../lib/errors.js";
import type { TimeIdCursor } from "../lib/pagination.js";
import { redactDeep, redactString } from "../lib/redact.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { JobError, SKIP_STEP, type EnqueueOptions, type JobDefinition, type JobLogLevel, type StepContext } from "./types.js";

export const MAX_LOG_LINES_PER_JOB = 2000;
const QUEUE_PREFIX = "bf.";

type JobRow = typeof jobs.$inferSelect;
type StepRow = typeof jobSteps.$inferSelect;

export interface JobRunnerOptions {
  databaseUrl: string;
  schema: string;
  concurrency?: number;
  pollingIntervalSeconds?: number;
}

/**
 * Durable jobs: pg-boss (own schema) provides queueing, retries with exponential backoff and expiry;
 * the `jobs`/`job_steps`/`job_logs` tables are the user-visible record. Steps are persisted and
 * completed steps are skipped on retry, so an attempt interrupted by a crash or restart resumes where
 * it stopped. Exactly one runner claims a job attempt (`queued → running` compare-and-set).
 */
export class JobRunner {
  private boss: PgBoss | null = null;
  private readonly definitions = new Map<string, JobDefinition<unknown>>();
  private readonly running = new Map<string, AbortController>();
  private readonly logCounts = new Map<string, number>();
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly bus: EventBus,
    private readonly hub: RealtimeHub,
    private readonly logger: Logger,
    private readonly opts: JobRunnerOptions,
  ) {}

  define<I>(def: JobDefinition<I>): void {
    if (this.definitions.has(def.type)) throw new Error(`job type ${def.type} already defined`);
    this.definitions.set(def.type, def as JobDefinition<unknown>);
  }

  definition(type: string): JobDefinition<unknown> | undefined {
    return this.definitions.get(type);
  }

  private queueName(type: string): string {
    return `${QUEUE_PREFIX}${type}`;
  }

  async start(): Promise<void> {
    this.stopping = false;
    const boss = new PgBoss({
      connectionString: this.opts.databaseUrl,
      schema: this.opts.schema,
      application_name: "blockforge-jobs",
      max: 4,
      registerInstance: false,
    });
    boss.on("error", (err) => this.logger.error({ err }, "pg-boss error"));
    await boss.start();
    this.boss = boss;
    for (const def of this.definitions.values()) {
      const name = this.queueName(def.type);
      const queueOpts = {
        retryLimit: def.retryLimit ?? 3,
        retryDelay: def.retryDelaySeconds ?? 5,
        retryBackoff: true,
        retryDelayMax: 300,
        expireInSeconds: def.expireInSeconds ?? 900,
      };
      await boss.createQueue(name, queueOpts);
      await boss.updateQueue(name, queueOpts);
      await boss.work<{ jobId: string }>(
        name,
        { localConcurrency: this.opts.concurrency ?? 2, pollingIntervalSeconds: this.opts.pollingIntervalSeconds ?? 1 },
        async (batch) => {
          for (const j of batch) await this.execute(j.data.jobId);
        },
      );
    }
    await this.recover();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const ctrl of this.running.values()) ctrl.abort(new JobError("SHUTDOWN", "control plane shutting down", true));
    if (this.boss) await this.boss.stop({ graceful: true, timeout: 10_000 });
    this.boss = null;
  }

  // --- Enqueue -------------------------------------------------------------------

  /**
   * Creates the job record and queues it. With `tx`, both happen inside the caller's transaction
   * (so a rolled-back request never leaves a job behind). Returns the existing job for a repeated
   * idempotency key.
   */
  async enqueue<I>(type: string, input: I, opts: EnqueueOptions = {}, tx?: Tx, after?: AfterCommit): Promise<string> {
    const def = this.definitions.get(type);
    if (!def) throw new Error(`unknown job type ${type}`);
    if (!this.boss) throw new Error("job runner not started");
    const validated = def.input.parse(input);
    const run = async (t: Tx, a: AfterCommit) => {
      if (opts.idempotencyKey) {
        const [existing] = await t.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, opts.idempotencyKey)).limit(1);
        if (existing) return existing.id;
      }
      const id = randomUUID();
      const now = new Date(this.clock.now());
      await t.insert(jobs).values({
        id,
        type,
        status: "queued",
        targetType: opts.targetType ?? null,
        targetId: opts.targetId ?? null,
        requestedBy: opts.requestedBy ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        input: toJsonSafe(redactDeep(validated)) ?? {},
        inputData: toJsonSafe(validated) ?? {},
        maxAttempts: (def.retryLimit ?? 3) + 1,
        createdAt: now,
        updatedAt: now,
      });
      await t.insert(jobSteps).values(def.steps.map((s, i) => ({ id: randomUUID(), jobId: id, ordinal: i, key: s.key, label: s.label })));
      const bossId = await this.boss!.send(this.queueName(type), { jobId: id }, { db: fromDrizzle(t, sql) });
      await t.update(jobs).set({ bossJobId: bossId }).where(eq(jobs.id, id));
      a.add(() => this.publishJob(id));
      return id;
    };
    if (tx && after) return run(tx, after);
    return withTransaction(this.db, run, (err) => this.logger.error({ err }, "job after-commit hook failed"));
  }

  // --- Execution -------------------------------------------------------------------

  /** Runs (or resumes) one attempt. Throws only to ask pg-boss for a retry. */
  async execute(jobId: string): Promise<void> {
    const [claimed] = await this.db
      .update(jobs)
      .set({
        status: "running",
        attempts: sql`${jobs.attempts} + 1`,
        startedAt: sql`coalesce(${jobs.startedAt}, ${new Date(this.clock.now()).toISOString()}::timestamptz)`,
        updatedAt: new Date(this.clock.now()),
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued"), eq(jobs.cancelRequested, false)))
      .returning();
    if (!claimed) {
      // Already finished, cancelled, or claimed elsewhere: nothing to do for this pg-boss job.
      const [row] = await this.db.select({ status: jobs.status, cancel: jobs.cancelRequested }).from(jobs).where(eq(jobs.id, jobId));
      if (row?.status === "queued" && row.cancel) await this.finishCancelled(jobId);
      return;
    }
    const def = this.definitions.get(claimed.type);
    if (!def) {
      await this.finish(claimed, "failed", { code: "UNKNOWN_JOB_TYPE", message: `no handler for ${claimed.type}` });
      return;
    }
    const ctrl = new AbortController();
    this.running.set(jobId, ctrl);
    await this.publishJob(jobId);
    const input = def.input.parse(claimed.inputData);
    const state = { ...(claimed.state as Record<string, unknown>) };
    const steps = await this.db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId)).orderBy(asc(jobSteps.ordinal));
    try {
      if (claimed.attempts > 1) await this.log(jobId, "info", `Attempt ${claimed.attempts} of ${claimed.maxAttempts}`);
      for (const stepDef of def.steps) {
        const row = steps.find((s) => s.key === stepDef.key);
        if (!row || row.status === "succeeded" || row.status === "skipped") continue;
        if (ctrl.signal.aborted) throw ctrl.signal.reason;
        await this.updateStep(row.id, { status: "running", message: null, startedAt: new Date(this.clock.now()), finishedAt: null });
        await this.publishJob(jobId);
        const ctx: StepContext<unknown> = {
          jobId,
          input,
          attempt: claimed.attempts,
          targetType: claimed.targetType,
          targetId: claimed.targetId,
          requestedBy: claimed.requestedBy,
          signal: ctrl.signal,
          state,
          log: (level, message) => this.log(jobId, level, message),
          setMessage: async (message) => {
            await this.updateStep(row.id, { message: redactString(message).slice(0, 1000) });
            await this.publishJob(jobId);
          },
          checkpoint: async (fn, o = {}) => {
            await withTransaction(this.db, async (tx) => {
              if (fn) await fn(tx);
              await tx.update(jobs).set({ state: toJsonSafe(state) ?? {} }).where(eq(jobs.id, jobId));
              if (o.completeStep) await tx.update(jobSteps).set({ status: "succeeded", finishedAt: new Date(this.clock.now()) }).where(eq(jobSteps.id, row.id));
            });
          },
        };
        let outcome: void | typeof SKIP_STEP;
        try {
          outcome = await stepDef.run(ctx);
        } catch (err) {
          await this.updateStep(row.id, { status: "failed", message: redactString(errorMessage(err)).slice(0, 1000), finishedAt: new Date(this.clock.now()) });
          throw err;
        } finally {
          await this.db.update(jobs).set({ state: toJsonSafe(state) ?? {} }).where(eq(jobs.id, jobId));
        }
        await this.updateStep(row.id, { status: outcome === SKIP_STEP ? "skipped" : "succeeded", finishedAt: new Date(this.clock.now()) });
        await this.publishJob(jobId);
      }
      const latest = await this.reload(jobId);
      await this.finish(latest ?? claimed, "succeeded", null, def.result ? toJsonSafe(def.result(state)) : null);
    } catch (err) {
      await this.handleFailure(jobId, err);
    } finally {
      this.running.delete(jobId);
    }
  }

  private async handleFailure(jobId: string, err: unknown): Promise<void> {
    const row = await this.reload(jobId);
    if (!row) return;
    if (row.cancelRequested) {
      await this.finishCancelled(jobId);
      return;
    }
    const jobErr = toJobError(err);
    if (jobErr.code === "SHUTDOWN" || (jobErr.retryable && row.attempts < row.maxAttempts && !this.stopping)) {
      await this.db.update(jobs).set({ status: "queued", error: { code: jobErr.code, message: jobErr.message }, updatedAt: new Date(this.clock.now()) }).where(eq(jobs.id, jobId));
      await this.log(jobId, "warn", `Attempt ${row.attempts} failed (${jobErr.code}): ${jobErr.message} — will retry`);
      await this.publishJob(jobId);
      // Throwing hands the retry (with exponential backoff) to pg-boss.
      throw jobErr;
    }
    await this.log(jobId, "error", `Job failed (${jobErr.code}): ${jobErr.message}`);
    await this.finish(row, "failed", { code: jobErr.code, message: jobErr.message });
  }

  private async finishCancelled(jobId: string): Promise<void> {
    const now = new Date(this.clock.now());
    await this.db
      .update(jobSteps)
      .set({ status: "skipped", finishedAt: now })
      .where(and(eq(jobSteps.jobId, jobId), inArray(jobSteps.status, ["pending", "running"])));
    const row = await this.reload(jobId);
    if (row) await this.finish(row, "cancelled", { code: "CANCELLED", message: "Cancelled by user" });
  }

  private async finish(row: JobRow, status: "succeeded" | "failed" | "cancelled", error: { code: string; message: string } | null, result: unknown = null): Promise<void> {
    // Finalize first: when a job is observed terminal, its target has already been settled (and an
    // operation lock is never left behind by a crash between the two).
    await this.runFinalize(row, status, error);
    const now = new Date(this.clock.now());
    await withTransaction(this.db, async (tx, after) => {
      await tx
        .update(jobs)
        .set({ status, error: error ? { code: error.code, message: redactString(error.message).slice(0, 2000) } : null, result: result ?? null, finishedAt: now, updatedAt: now })
        .where(eq(jobs.id, row.id));
      if (status !== "succeeded") {
        await tx
          .update(jobSteps)
          .set({ status: "skipped", finishedAt: now })
          .where(and(eq(jobSteps.jobId, row.id), eq(jobSteps.status, "pending")));
      }
      await this.bus.publish(
        {
          type: "job.updated",
          subjectType: "job",
          subjectId: row.id,
          data: { jobId: row.id, type: row.type, status, targetType: row.targetType, targetId: row.targetId, error },
        },
        { tx, after },
      );
    });
    this.logCounts.delete(row.id);
    await this.publishJob(row.id);
  }

  private async runFinalize(row: JobRow, status: "succeeded" | "failed" | "cancelled", error: { code: string; message: string } | null): Promise<void> {
    const def = this.definitions.get(row.type);
    if (!def?.finalize) return;
    try {
      const fresh = await this.reload(row.id);
      await def.finalize({
        jobId: row.id,
        input: def.input.parse((fresh ?? row).inputData),
        state: ((fresh ?? row).state ?? {}) as Record<string, unknown>,
        status,
        error,
        log: (level, message) => this.log(row.id, level, message),
      });
    } catch (err) {
      this.logger.error({ err, jobId: row.id, type: row.type }, "job finalize hook failed");
    }
  }

  private async reload(jobId: string): Promise<JobRow | null> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    return row ?? null;
  }

  private async updateStep(id: string, set: Partial<StepRow>): Promise<void> {
    await this.db.update(jobSteps).set(set).where(eq(jobSteps.id, id));
  }

  /** Appends a log line (bounded to 2000 per job) and streams it to `job:<id>` subscribers. */
  async log(jobId: string, level: JobLogLevel, message: string): Promise<void> {
    let n = this.logCounts.get(jobId);
    if (n === undefined) {
      const [row] = await this.db.select({ n: count() }).from(jobLogs).where(eq(jobLogs.jobId, jobId));
      n = Number(row?.n ?? 0);
    }
    if (n >= MAX_LOG_LINES_PER_JOB) return;
    let text = redactString(message).slice(0, 4000);
    let lvl = level;
    if (n === MAX_LOG_LINES_PER_JOB - 1) {
      text = `Log limit of ${MAX_LOG_LINES_PER_JOB} lines reached; further output is dropped`;
      lvl = "warn";
    }
    this.logCounts.set(jobId, n + 1);
    const ts = this.clock.now();
    const [row] = await this.db.insert(jobLogs).values({ jobId, ts: new Date(ts), level: lvl, message: text }).returning({ id: jobLogs.id });
    if (row) {
      const line: JobLogLine = { id: row.id, ts, level: lvl, message: text };
      this.hub.publish(`job:${jobId}`, "job.log", { jobId, ...line });
    }
  }

  // --- Cancellation & recovery -----------------------------------------------------

  async cancel(jobId: string): Promise<void> {
    const row = await this.reload(jobId);
    if (!row) throw notFound("Job");
    if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") {
      throw invalidState(`Job is already ${row.status}`);
    }
    if (row.cancelRequested) throw conflict("Cancellation already requested");
    await this.db.update(jobs).set({ cancelRequested: true, updatedAt: new Date(this.clock.now()) }).where(eq(jobs.id, jobId));
    await this.log(jobId, "warn", "Cancellation requested");
    if (row.status === "queued") {
      if (this.boss && row.bossJobId) await this.boss.cancel(this.queueName(row.type), row.bossJobId).catch(() => undefined);
      await this.finishCancelled(jobId);
      return;
    }
    this.running.get(jobId)?.abort(new JobError("CANCELLED", "Cancelled by user"));
    await this.publishJob(jobId);
  }

  /**
   * After a restart, jobs left `running` belonged to this (single) control-plane process: their
   * running steps are reset and a fresh pg-boss job is queued, so completed steps are skipped and
   * the interrupted step re-runs. Queued jobs whose pg-boss job vanished are re-queued too.
   */
  private async recover(): Promise<void> {
    const boss = this.boss;
    if (!boss) return;
    const orphans = await this.db.select().from(jobs).where(inArray(jobs.status, ["running", "queued"]));
    for (const row of orphans) {
      const name = this.queueName(row.type);
      if (!this.definitions.has(row.type)) continue;
      if (row.status === "queued" && row.bossJobId) {
        const found = await boss.findJobs(name, { id: row.bossJobId }).catch(() => []);
        if (found.some((j) => ["created", "retry", "active"].includes(j.state))) continue;
      }
      if (row.bossJobId) await boss.cancel(name, row.bossJobId).catch(() => undefined);
      await this.db
        .update(jobSteps)
        .set({ status: "pending", startedAt: null })
        .where(and(eq(jobSteps.jobId, row.id), eq(jobSteps.status, "running")));
      const bossId = await boss.send(name, { jobId: row.id });
      await this.db.update(jobs).set({ status: "queued", bossJobId: bossId, updatedAt: new Date(this.clock.now()) }).where(eq(jobs.id, row.id));
      await this.log(row.id, "warn", "Control plane restarted; resuming job");
      this.logger.info({ jobId: row.id, type: row.type }, "recovered interrupted job");
    }
  }

  // --- Queries ---------------------------------------------------------------------

  async getRow(jobId: string): Promise<JobRow | null> {
    return this.reload(jobId);
  }

  async toDtos(rows: JobRow[]): Promise<Job[]> {
    if (rows.length === 0) return [];
    const steps = await this.db
      .select()
      .from(jobSteps)
      .where(
        inArray(
          jobSteps.jobId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(jobSteps.ordinal));
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status as Job["status"],
      targetType: r.targetType,
      targetId: r.targetId,
      requestedBy: r.requestedBy,
      attempts: r.attempts,
      error: r.error ?? null,
      result: r.result ?? null,
      createdAt: r.createdAt.getTime(),
      startedAt: r.startedAt?.getTime() ?? null,
      finishedAt: r.finishedAt?.getTime() ?? null,
      steps: steps
        .filter((s) => s.jobId === r.id)
        .map((s) => ({
          key: s.key,
          label: s.label,
          status: s.status as Job["steps"][number]["status"],
          message: s.message,
          startedAt: s.startedAt?.getTime() ?? null,
          finishedAt: s.finishedAt?.getTime() ?? null,
        })),
    }));
  }

  async getDto(jobId: string): Promise<Job | null> {
    const row = await this.reload(jobId);
    if (!row) return null;
    const [dto] = await this.toDtos([row]);
    return dto ?? null;
  }

  async list(filter: {
    limit: number;
    cursor: TimeIdCursor | null;
    targetType?: string | undefined;
    targetId?: string | undefined;
    status?: string | undefined;
    /** Visibility restriction for users without global jobs.view. */
    visible?: { nodeIds: string[]; serverIds: string[] } | undefined;
  }): Promise<{ items: Job[]; next: TimeIdCursor | null }> {
    const conds: (SQL | undefined)[] = [];
    if (filter.targetType) conds.push(eq(jobs.targetType, filter.targetType));
    if (filter.targetId) conds.push(eq(jobs.targetId, filter.targetId));
    if (filter.status) conds.push(eq(jobs.status, filter.status));
    if (filter.cursor) {
      const t = new Date(filter.cursor.t);
      conds.push(or(lt(jobs.createdAt, t), and(eq(jobs.createdAt, t), lt(jobs.id, filter.cursor.id))));
    }
    if (filter.visible) {
      const { nodeIds, serverIds } = filter.visible;
      conds.push(
        or(
          nodeIds.length ? and(eq(jobs.targetType, "node"), inArray(jobs.targetId, nodeIds)) : sql`false`,
          serverIds.length ? and(eq(jobs.targetType, "server"), inArray(jobs.targetId, serverIds)) : sql`false`,
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(...conds))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(filter.limit + 1);
    const page = rows.slice(0, filter.limit);
    const last = page[page.length - 1];
    return { items: await this.toDtos(page), next: rows.length > filter.limit && last ? { t: last.createdAt.getTime(), id: last.id } : null };
  }

  async logs(jobId: string, afterId: number, limit = 1000): Promise<JobLogLine[]> {
    const rows = await this.db
      .select()
      .from(jobLogs)
      .where(and(eq(jobLogs.jobId, jobId), gt(jobLogs.id, afterId)))
      .orderBy(asc(jobLogs.id))
      .limit(limit);
    return rows.map((r) => ({ id: r.id, ts: r.ts.getTime(), level: r.level as JobLogLine["level"], message: r.message }));
  }

  private async publishJob(jobId: string): Promise<void> {
    if (!this.hub.hasSubscribers(`job:${jobId}`)) return;
    const dto = await this.getDto(jobId);
    if (dto) this.hub.publish(`job:${jobId}`, "job.updated", dto);
  }

  /** Waits until the job reaches a terminal status (tests and synchronous callers). */
  async waitForCompletion(jobId: string, timeoutMs = 30_000, tx: DbOrTx = this.db): Promise<JobRow> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
      if (row && ["succeeded", "failed", "cancelled"].includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish within ${timeoutMs} ms (status ${row?.status})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function toJobError(err: unknown): JobError {
  if (err instanceof JobError) return err;
  if (err && typeof err === "object" && "code" in err && "retryable" in err) {
    const e = err as { code: unknown; message?: unknown; retryable: unknown };
    return new JobError(String(e.code), String(e.message ?? "failed"), Boolean(e.retryable));
  }
  return new JobError("INTERNAL", errorMessage(err), false);
}
