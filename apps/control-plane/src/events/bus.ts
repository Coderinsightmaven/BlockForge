import { EPHEMERAL_EVENTS, type DomainEventType } from "@blockforge/contracts";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db, DbOrTx } from "../db/client.js";
import { events } from "../db/schema/index.js";
import type { AfterCommit } from "../db/tx.js";
import { toJsonSafe } from "../lib/canonical-json.js";
import type { Clock } from "../lib/clock.js";

export interface DomainEvent<T = Record<string, unknown>> {
  /** Outbox row id; null for ephemeral events. */
  id: number | null;
  type: DomainEventType;
  subjectType: string | null;
  subjectId: string | null;
  data: T;
  occurredAt: number;
}

export interface PublishInput<T = Record<string, unknown>> {
  type: DomainEventType;
  subjectType?: string | null;
  subjectId?: string | null;
  data?: T;
}

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

const HANDLER_ATTEMPTS = 3;
/** Undispatched events older than this are re-dispatched by the outbox sweep. */
const REDISPATCH_AFTER_MS = 10_000;
/** Events that still fail after this long are abandoned (logged) instead of retried forever. */
const GIVE_UP_AFTER_MS = 60 * 60_000;

/**
 * In-process domain event bus backed by the `events` outbox table.
 * Durable events are persisted (optionally inside the caller's transaction) and then dispatched;
 * an event is marked `dispatched_at` only after every subscriber handled it, and a periodic sweep
 * re-dispatches stragglers — so delivery is at-least-once and subscribers must be idempotent.
 * Ephemeral events (heartbeats) are dispatched in memory only.
 */
export class EventBus {
  private readonly handlers = new Map<DomainEventType | "*", Set<EventHandler>>();
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  subscribe(type: DomainEventType | "*", handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /**
   * Persists (unless ephemeral) and dispatches an event. With `tx` + `after`, the row is written in
   * the caller's transaction and dispatch waits for the commit.
   */
  async publish<T extends Record<string, unknown>>(
    input: PublishInput<T>,
    opts: { tx?: DbOrTx; after?: AfterCommit } = {},
  ): Promise<DomainEvent<T>> {
    const occurredAt = this.clock.now();
    const data = (toJsonSafe(input.data ?? {}) ?? {}) as T;
    const base = {
      type: input.type,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      data,
      occurredAt,
    };
    if (EPHEMERAL_EVENTS.includes(input.type)) {
      const event: DomainEvent<T> = { id: null, ...base };
      void this.dispatch(event as DomainEvent);
      return event;
    }
    const [row] = await (opts.tx ?? this.db)
      .insert(events)
      .values({ ...base, occurredAt: new Date(occurredAt) })
      .returning({ id: events.id });
    const event: DomainEvent<T> = { id: row?.id ?? null, ...base };
    if (opts.after) opts.after.add(() => this.dispatch(event as DomainEvent));
    else void this.dispatch(event as DomainEvent);
    return event;
  }

  /** Runs all handlers (with retries) and marks the outbox row dispatched when every handler succeeded. */
  async dispatch(event: DomainEvent): Promise<boolean> {
    if (event.id !== null) {
      if (this.inFlight.has(event.id)) return false;
      this.inFlight.add(event.id);
    }
    try {
      const handlers = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])];
      let allOk = true;
      for (const handler of handlers) {
        let ok = false;
        for (let attempt = 1; attempt <= HANDLER_ATTEMPTS && !ok; attempt++) {
          try {
            await handler(event);
            ok = true;
          } catch (err) {
            this.logger.warn({ err, eventType: event.type, eventId: event.id, attempt }, "event handler failed");
            if (attempt < HANDLER_ATTEMPTS) await new Promise((r) => setTimeout(r, 50 * 4 ** attempt));
          }
        }
        if (!ok) allOk = false;
      }
      if (event.id !== null && allOk) {
        await this.db.update(events).set({ dispatchedAt: new Date(this.clock.now()) }).where(eq(events.id, event.id));
      }
      return allOk;
    } catch (err) {
      this.logger.error({ err, eventType: event.type }, "event dispatch failed");
      return false;
    } finally {
      if (event.id !== null) this.inFlight.delete(event.id);
    }
  }

  /** Outbox sweep: re-dispatches events whose dispatch did not complete (crash, handler failure). */
  async redispatchPending(limit = 200): Promise<number> {
    const now = this.clock.now();
    const rows = await this.db
      .select()
      .from(events)
      .where(and(isNull(events.dispatchedAt), lt(events.occurredAt, new Date(now - REDISPATCH_AFTER_MS))))
      .orderBy(asc(events.id))
      .limit(limit);
    for (const row of rows) {
      const event: DomainEvent = {
        id: row.id,
        type: row.type as DomainEventType,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        data: row.data as Record<string, unknown>,
        occurredAt: row.occurredAt.getTime(),
      };
      const ok = await this.dispatch(event);
      if (!ok && now - event.occurredAt > GIVE_UP_AFTER_MS) {
        this.logger.error({ eventId: row.id, eventType: row.type }, "abandoning event after repeated handler failures");
        await this.db.update(events).set({ dispatchedAt: new Date(now) }).where(eq(events.id, row.id));
      }
    }
    return rows.length;
  }
}
