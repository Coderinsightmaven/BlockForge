import { randomUUID } from "node:crypto";
import { detectLogEvents, isValidPlayerName } from "@blockforge/minecraft";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { ConsoleLine } from "../agents/console-buffer.js";
import type { AgentGateway } from "../agents/gateway.js";
import type { Db } from "../db/client.js";
import { playerSessions } from "../db/schema/index.js";
import type { EventBus } from "../events/bus.js";
import type { Clock } from "../lib/clock.js";
import type { ServerEventPublisher } from "../realtime/server-events.js";

export const SESSION_RETENTION_MS = 90 * 86_400_000;
/** Server states that end every open session (the server is no longer running). */
const ENDED_STATES = new Set(["stopped", "crashed", "unreachable", "provisioning", "restoring", "deleting", "provision_failed"]);
const MAX_PENDING_PER_SERVER = 512;

export interface SessionDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  events: ServerEventPublisher;
}

/**
 * Play sessions from the live console (api.md "Players → Sessions"): join/leave lines recognised by
 * `@blockforge/minecraft` `detectLogEvents`, which only trusts the server's own logger (a mod logging
 * `[EvilMod]: Steve joined the game` or player chat never opens a session). UUIDs come from the
 * preceding `UUID of player …` line, leave reasons from `… lost connection: …`. Sessions are closed
 * when the server stops/crashes/becomes unreachable and when a player is missing from `list`.
 * Work per server is serialised (console order); `player.joined`/`player.left` go only to subscribers
 * holding `servers.players.view`.
 */
export class PlayerSessionTracker {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly uuids = new Map<string, Map<string, string>>();
  private readonly reasons = new Map<string, Map<string, string>>();

  constructor(private readonly d: SessionDeps) {}

  attach(gateway: AgentGateway, bus: EventBus): void {
    gateway.on("consoleLines", (serverId: string, lines: ConsoleLine[]) => void this.enqueue(serverId, () => this.onLines(serverId, lines)));
    bus.subscribe("server.state.changed", async (ev) => {
      const to = (ev.data as { to?: string }).to;
      if (ev.subjectId && to && ENDED_STATES.has(to)) await this.enqueue(ev.subjectId, () => this.closeAll(ev.subjectId!));
    });
  }

  /** Runs `fn` after everything queued for the server (idle() in tests). */
  enqueue(serverId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(serverId) ?? Promise.resolve()).then(fn).catch((err: unknown) => this.d.logger.warn({ err, serverId }, "player session tracking failed"));
    this.chains.set(serverId, next);
    void next.finally(() => {
      if (this.chains.get(serverId) === next) this.chains.delete(serverId);
    });
    return next;
  }

  async idle(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  private remember(map: Map<string, Map<string, string>>, serverId: string, name: string, value: string): void {
    let m = map.get(serverId);
    if (!m) map.set(serverId, (m = new Map()));
    m.delete(name.toLowerCase());
    m.set(name.toLowerCase(), value);
    while (m.size > MAX_PENDING_PER_SERVER) m.delete(m.keys().next().value!);
  }

  private take(map: Map<string, Map<string, string>>, serverId: string, name: string): string | null {
    const m = map.get(serverId);
    const v = m?.get(name.toLowerCase()) ?? null;
    m?.delete(name.toLowerCase());
    return v;
  }

  private async onLines(serverId: string, lines: readonly ConsoleLine[]): Promise<void> {
    for (const l of lines) {
      if (l.stream === "system") continue;
      for (const ev of detectLogEvents(l.line)) {
        switch (ev.type) {
          case "player_uuid":
            if (isValidPlayerName(ev.name)) this.remember(this.uuids, serverId, ev.name, ev.uuid);
            break;
          case "player_disconnect":
            if (isValidPlayerName(ev.name)) this.remember(this.reasons, serverId, ev.name, ev.reason.slice(0, 256));
            break;
          case "player_join":
          case "proxy_connect":
            if (isValidPlayerName(ev.name)) await this.join(serverId, ev.name);
            break;
          case "player_leave":
            if (isValidPlayerName(ev.name)) await this.leave(serverId, ev.name, this.take(this.reasons, serverId, ev.name));
            break;
          case "proxy_disconnect":
            if (isValidPlayerName(ev.name)) await this.leave(serverId, ev.name, ev.reason?.slice(0, 256) ?? null);
            break;
          default:
            break;
        }
      }
    }
  }

  private async join(serverId: string, name: string): Promise<void> {
    const now = new Date(this.d.clock.now());
    // A session left open (missed leave line) ends where the new one starts.
    await this.close(serverId, { name, reason: null, at: now });
    const uuid = this.take(this.uuids, serverId, name);
    const id = randomUUID();
    await this.d.db.insert(playerSessions).values({ id, serverId, name, uuid, joinedAt: now });
    void this.d.events.publish(serverId, "player.joined", { serverId, name, uuid, at: now.getTime(), sessionId: id }, "servers.players.view");
  }

  private async leave(serverId: string, name: string, reason: string | null): Promise<void> {
    const closed = await this.close(serverId, { name, reason, at: new Date(this.d.clock.now()) });
    if (!closed.length) {
      // No open session (e.g. it started before a control-plane restart): still tell the UI.
      void this.d.events.publish(serverId, "player.left", { serverId, name, uuid: null, at: this.d.clock.now(), sessionId: null, reason }, "servers.players.view");
    }
  }

  /** Closes open sessions (one name, or all); publishes `player.left` for each. */
  private async close(serverId: string, o: { name?: string; reason: string | null; at: Date; keep?: ReadonlySet<string> }): Promise<string[]> {
    const conds = [eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)];
    if (o.name) conds.push(sql`lower(${playerSessions.name}) = ${o.name.toLowerCase()}`);
    const open = await this.d.db.select().from(playerSessions).where(and(...conds));
    const targets = open.filter((s) => !o.keep?.has(s.name.toLowerCase()));
    for (const s of targets) {
      await this.d.db.update(playerSessions).set({ leftAt: o.at, leaveReason: o.reason }).where(and(eq(playerSessions.id, s.id), isNull(playerSessions.leftAt)));
      void this.d.events.publish(serverId, "player.left", { serverId, name: s.name, uuid: s.uuid, at: o.at.getTime(), sessionId: s.id, reason: o.reason }, "servers.players.view");
    }
    return targets.map((s) => s.id);
  }

  /** The server stopped/crashed/became unreachable: every open session ends now (`leaveReason: null`). */
  async closeAll(serverId: string): Promise<void> {
    await this.close(serverId, { reason: null, at: new Date(this.d.clock.now()) });
    this.uuids.delete(serverId);
    this.reasons.delete(serverId);
  }

  /** A complete `list` output: open sessions of players not in it are closed. */
  reconcile(serverId: string, online: readonly string[]): Promise<void> {
    const keep = new Set(online.map((n) => n.toLowerCase()));
    return this.enqueue(serverId, async () => void (await this.close(serverId, { reason: null, at: new Date(this.d.clock.now()), keep })));
  }

  /** Retention: 90 days. */
  async prune(): Promise<void> {
    await this.d.db.delete(playerSessions).where(lt(playerSessions.joinedAt, new Date(this.d.clock.now() - SESSION_RETENTION_MS)));
  }
}
