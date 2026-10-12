import { and, inArray, lt, ne } from "drizzle-orm";
import type { ConsoleBuffers } from "../agents/console-buffer.js";
import type { Db } from "../db/client.js";
import { agentCommands, events, jobs, notificationDeliveries, servers } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import type { LatestCache } from "../metrics/latest.js";

const DAY_MS = 24 * 60 * 60_000;

/** Retention periods (data-model.md): events 90 d, agent commands 30 d, finished jobs + deliveries 30 d. */
export const RETENTION = {
  eventsMs: 90 * DAY_MS,
  agentCommandsMs: 30 * DAY_MS,
  finishedJobsMs: 30 * DAY_MS,
  deliveriesMs: 30 * DAY_MS,
  /** In-memory: latest samples kept this long after the last receipt (only fresh ones are served anyway). */
  latestSamplesMs: 60 * 60_000,
  /** In-memory: console ring buffers of servers silent for this long are freed. */
  idleConsoleMs: 6 * 60 * 60_000,
} as const;

export interface RetentionDeps {
  db: Db;
  clock: Clock;
  latest: LatestCache;
  consoles: ConsoleBuffers;
}

export interface RetentionResult {
  events: number;
  agentCommands: number;
  jobs: number;
  deliveries: number;
  latest: number;
  consoles: number;
}

/** Deletes expired rows (job logs/steps cascade with their job) and prunes in-memory maps. */
export async function runRetention(d: RetentionDeps): Promise<RetentionResult> {
  const now = d.clock.now();
  const ev = await d.db.delete(events).where(lt(events.occurredAt, new Date(now - RETENTION.eventsMs))).returning({ id: events.id });
  const cmds = await d.db
    .delete(agentCommands)
    .where(lt(agentCommands.issuedAt, new Date(now - RETENTION.agentCommandsMs)))
    .returning({ id: agentCommands.id });
  const finished = await d.db
    .delete(jobs)
    .where(and(inArray(jobs.status, ["succeeded", "failed", "cancelled"]), lt(jobs.finishedAt, new Date(now - RETENTION.finishedJobsMs))))
    .returning({ id: jobs.id });
  const deliveries = await d.db
    .delete(notificationDeliveries)
    .where(and(ne(notificationDeliveries.status, "pending"), lt(notificationDeliveries.createdAt, new Date(now - RETENTION.deliveriesMs))))
    .returning({ id: notificationDeliveries.id });
  const latest = d.latest.prune(RETENTION.latestSamplesMs);
  let consoles = 0;
  if (d.consoles.size > 0) {
    const existing = new Set((await d.db.select({ id: servers.id }).from(servers)).map((r) => r.id));
    consoles = d.consoles.prune(RETENTION.idleConsoleMs, (id) => existing.has(id));
  }
  return { events: ev.length, agentCommands: cmds.length, jobs: finished.length, deliveries: deliveries.length, latest, consoles };
}
