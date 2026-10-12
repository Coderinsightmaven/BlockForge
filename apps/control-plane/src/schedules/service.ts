import { randomUUID } from "node:crypto";
import type { Permission, Schedule, ScheduleCron, ScheduleRun, ScheduleTask } from "@blockforge/contracts";
import { and, count, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { scheduleRuns, schedules } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import { badRequest, conflict, forbidden, notFound, validationDetails } from "../lib/errors.js";
import { decodeCursor, encodeCursor, TimeIdCursor } from "../lib/pagination.js";
import type { RealtimeHub } from "../realtime/hub.js";
import type { ServerAccess, ServerAccessService } from "../servers/access.js";
import { cronError, nextRun, nextRuns, validTimezone } from "./cron.js";

type Row = typeof schedules.$inferSelect;
type RunRow = typeof scheduleRuns.$inferSelect;

/** Permission each task needs (checked at write time and again at run time against the last editor). */
export const TASK_PERMISSION: Record<ScheduleTask["action"], Permission> = {
  command: "servers.console.send",
  power: "servers.control",
  backup: "servers.backups.create",
};

export interface UpsertInput {
  name: string;
  cron: ScheduleCron;
  timezone?: string | undefined;
  enabled: boolean;
  onlyWhenOnline: boolean;
  tasks: ScheduleTask[];
}

export interface SchedulesDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  audit: AuditService;
  hub: RealtimeHub;
  access: ServerAccessService;
  /** Starts a claimed run (the scheduler executes it asynchronously). */
  execute(runId: string): void;
  /** Lease of a run claimed by this process. */
  lease(): { runnerId: string; leaseExpiresAt: Date };
}

/** At most this many schedules per server. */
export const MAX_SCHEDULES_PER_SERVER = 50;

export function runDto(r: RunRow): ScheduleRun {
  return {
    id: r.id,
    scheduleId: r.scheduleId,
    trigger: r.trigger as ScheduleRun["trigger"],
    status: r.status as ScheduleRun["status"],
    reason: r.reason,
    startedAt: r.startedAt.getTime(),
    finishedAt: r.finishedAt?.getTime() ?? null,
    tasks: r.tasks,
  };
}

export function pendingTasks(tasks: ScheduleTask[]): ScheduleRun["tasks"] {
  return tasks.map((t, index) => ({ index, action: t.action, status: "pending", message: null, jobId: null, startedAt: null, finishedAt: null }));
}

/** Schedules (api.md "Schedules"): CRUD, cron preview, run-now and run history. */
export class SchedulesService {
  constructor(private readonly d: SchedulesDeps) {}

  dto(r: Row): Schedule {
    return {
      id: r.id,
      serverId: r.serverId,
      name: r.name,
      cron: r.cron,
      timezone: r.timezone,
      enabled: r.enabled,
      onlyWhenOnline: r.onlyWhenOnline,
      tasks: r.tasks,
      nextRunAt: r.nextRunAt?.getTime() ?? null,
      lastRunAt: r.lastRunAt?.getTime() ?? null,
      lastRunStatus: (r.lastRunStatus as Schedule["lastRunStatus"]) ?? null,
      running: r.runningRunId !== null,
      createdAt: r.createdAt.getTime(),
    };
  }

  private async rowOf(serverId: string, id: string): Promise<Row> {
    const [r] = await this.d.db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.serverId, serverId))).limit(1);
    if (!r) throw notFound("Schedule");
    return r;
  }

  /** `schedule.updated` on `server:<id>` for subscribers with schedules.view. */
  async publish(scheduleId: string): Promise<void> {
    const [r] = await this.d.db.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1);
    if (!r) return;
    const topic = `server:${r.serverId}`;
    const clients = this.d.hub.subscribers(topic);
    if (!clients.length) return;
    const dto = this.dto(r);
    for (const c of clients) {
      const a = await this.d.access.load(r.serverId, c.principal).catch(() => null);
      if (a?.permissions.has("schedules.view")) this.d.hub.sendTo(c, topic, "schedule.updated", dto);
    }
  }

  /** `schedule.deleted` on `server:<id>` for subscribers with schedules.view. */
  async publishDeleted(serverId: string, scheduleId: string): Promise<void> {
    const topic = `server:${serverId}`;
    for (const c of this.d.hub.subscribers(topic)) {
      const a = await this.d.access.load(serverId, c.principal).catch(() => null);
      if (a?.permissions.has("schedules.view")) this.d.hub.sendTo(c, topic, "schedule.deleted", { serverId, scheduleId });
    }
  }

  async list(access: ServerAccess): Promise<Schedule[]> {
    const rows = await this.d.db.select().from(schedules).where(eq(schedules.serverId, access.server.id)).orderBy(schedules.createdAt);
    return rows.map((r) => this.dto(r));
  }

  async get(access: ServerAccess, id: string): Promise<Schedule> {
    return this.dto(await this.rowOf(access.server.id, id));
  }

  /** Validates the trigger and that the editor may run every task (no escalation through schedules). */
  private validate(access: ServerAccess, input: UpsertInput): { timezone: string } {
    const timezone = input.timezone ?? access.server.timezone;
    if (!validTimezone(timezone)) throw badRequest("Unknown time zone", validationDetails("not an IANA time zone", "timezone"));
    const err = cronError(input.cron, timezone);
    if (err) throw badRequest(`Invalid cron expression: ${err}`, validationDetails(err, "cron"));
    const missing = [...new Set(input.tasks.map((t) => TASK_PERMISSION[t.action]))].filter((p) => !access.permissions.has(p));
    if (missing.length) throw forbidden(`Scheduling these tasks needs ${missing.join(", ")}`);
    return { timezone };
  }

  private nextFrom(input: { cron: ScheduleCron; enabled: boolean }, timezone: string): Date | null {
    return input.enabled ? nextRun(input.cron, timezone, new Date(this.d.clock.now())) : null;
  }

  async create(access: ServerAccess, input: UpsertInput, actor: AuditActor): Promise<Schedule> {
    const { timezone } = this.validate(access, input);
    const [n] = await this.d.db.select({ n: count() }).from(schedules).where(eq(schedules.serverId, access.server.id));
    if (Number(n?.n ?? 0) >= MAX_SCHEDULES_PER_SERVER) throw conflict(`A server can have at most ${MAX_SCHEDULES_PER_SERVER} schedules`);
    const now = new Date(this.d.clock.now());
    const [row] = await this.d.db
      .insert(schedules)
      .values({
        id: randomUUID(),
        serverId: access.server.id,
        name: input.name,
        cron: input.cron,
        timezone,
        enabled: input.enabled,
        onlyWhenOnline: input.onlyWhenOnline,
        tasks: input.tasks,
        nextRunAt: this.nextFrom(input, timezone),
        updatedBy: access.principal.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await this.d.audit.record({ ...actor, action: "server.schedule.create", targetType: "server", targetId: access.server.id, outcome: "success", details: { scheduleId: row!.id, name: input.name, tasks: input.tasks.map((t) => t.action) } });
    void this.publish(row!.id);
    return this.dto(row!);
  }

  async update(access: ServerAccess, id: string, input: UpsertInput, actor: AuditActor): Promise<Schedule> {
    await this.rowOf(access.server.id, id);
    const { timezone } = this.validate(access, input);
    const [row] = await this.d.db
      .update(schedules)
      .set({
        name: input.name,
        cron: input.cron,
        timezone,
        enabled: input.enabled,
        onlyWhenOnline: input.onlyWhenOnline,
        tasks: input.tasks,
        nextRunAt: this.nextFrom(input, timezone),
        updatedBy: access.principal.userId,
        updatedAt: new Date(this.d.clock.now()),
      })
      .where(eq(schedules.id, id))
      .returning();
    await this.d.audit.record({ ...actor, action: "server.schedule.update", targetType: "server", targetId: access.server.id, outcome: "success", details: { scheduleId: id, name: input.name, enabled: input.enabled } });
    void this.publish(id);
    return this.dto(row!);
  }

  async remove(access: ServerAccess, id: string, actor: AuditActor): Promise<void> {
    const r = await this.rowOf(access.server.id, id);
    await this.d.db.delete(schedules).where(eq(schedules.id, id));
    void this.publishDeleted(access.server.id, id);
    await this.d.audit.record({ ...actor, action: "server.schedule.delete", targetType: "server", targetId: access.server.id, outcome: "success", details: { scheduleId: id, name: r.name } });
  }

  /** Manual trigger; refused while a run is in progress (at most one per schedule). */
  async runNow(access: ServerAccess, id: string, actor: AuditActor): Promise<ScheduleRun> {
    const r = await this.rowOf(access.server.id, id);
    // Running a schedule by hand needs every task's permission (no delegation through the last editor);
    // the manual run then executes as the caller.
    const missing = [...new Set(r.tasks.map((t) => TASK_PERMISSION[t.action]))].filter((p) => !access.permissions.has(p));
    if (missing.length) throw forbidden(`Running this schedule needs ${missing.join(", ")}`);
    const runId = randomUUID();
    const now = new Date(this.d.clock.now());
    const definition = { name: r.name, tasks: r.tasks, updatedBy: access.principal.userId, onlyWhenOnline: r.onlyWhenOnline };
    const claimed = await this.d.db.transaction(async (tx) => {
      const [locked] = await tx.update(schedules).set({ runningRunId: runId, lastRunAt: now }).where(and(eq(schedules.id, id), isNull(schedules.runningRunId))).returning({ id: schedules.id });
      if (!locked) return null;
      const [run] = await tx
        .insert(scheduleRuns)
        .values({ id: runId, scheduleId: id, trigger: "manual", status: "running", tasks: pendingTasks(r.tasks), definition, ...this.d.lease(), startedAt: now })
        .returning();
      return run!;
    });
    if (!claimed) throw conflict("The schedule is already running");
    await this.d.audit.record({ ...actor, action: "server.schedule.run", targetType: "server", targetId: access.server.id, outcome: "success", details: { scheduleId: id, runId } });
    void this.publish(id);
    this.d.execute(runId);
    return runDto(claimed);
  }

  async runs(access: ServerAccess, id: string, q: { limit: number; cursor?: string | undefined }): Promise<{ items: ScheduleRun[]; nextCursor: string | null }> {
    await this.rowOf(access.server.id, id);
    const cursor = decodeCursor(TimeIdCursor, q.cursor);
    const conds = [eq(scheduleRuns.scheduleId, id)];
    if (cursor) {
      const t = new Date(cursor.t);
      conds.push(or(lt(scheduleRuns.startedAt, t), and(eq(scheduleRuns.startedAt, t), lt(scheduleRuns.id, cursor.id)))!);
    }
    const rows = await this.d.db.select().from(scheduleRuns).where(and(...conds)).orderBy(desc(scheduleRuns.startedAt), desc(scheduleRuns.id)).limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(runDto), nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.startedAt.getTime(), id: last.id }) : null };
  }

  preview(cron: ScheduleCron, timezone: string, count: number): { valid: boolean; error: string | null; next: number[]; description: string | null } {
    if (!validTimezone(timezone)) return { valid: false, error: `unknown time zone ${timezone}`, next: [], description: null };
    const err = cronError(cron, timezone);
    if (err) return { valid: false, error: err, next: [], description: null };
    return { valid: true, error: null, next: nextRuns(cron, timezone, count, new Date(this.d.clock.now())).map((d) => d.getTime()), description: null };
  }
}
