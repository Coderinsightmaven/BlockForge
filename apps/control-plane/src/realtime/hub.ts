import type { Permission, RealtimeEventType, ServerFrame } from "@blockforge/contracts";
import type { Logger } from "pino";
import type { Clock } from "../lib/clock.js";
import { authorize, type Principal, type Resource } from "../rbac/authorize.js";

export interface RealtimeClient {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  principal: Principal;
  readonly subscriptions: Set<string>;
  /** Enqueues a frame; implementations enforce the per-client buffer limit. */
  send(frame: ServerFrame): void;
  close(code: number, reason: string): void;
}

/** Per-event scope filter: only subscribers holding `permission` on `resource` receive the event. */
export interface EventAudience {
  permission: Permission;
  resource: Resource;
}

/**
 * Topic-based fan-out for UI clients. Subscription authorisation happens at subscribe time
 * (realtime/topics.ts); events on aggregate topics (`nodes`, `servers`, `alerts`, …) are filtered
 * again per event with an `EventAudience`, so a user only sees resources in their scope.
 */
export class RealtimeHub {
  private readonly clients = new Map<string, RealtimeClient>();
  private readonly topics = new Map<string, Set<string>>();

  constructor(
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  register(client: RealtimeClient): void {
    this.clients.set(client.id, client);
  }

  unregister(client: RealtimeClient): void {
    for (const topic of client.subscriptions) this.topics.get(topic)?.delete(client.id);
    client.subscriptions.clear();
    this.clients.delete(client.id);
  }

  subscribe(client: RealtimeClient, topic: string): void {
    client.subscriptions.add(topic);
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(client.id);
  }

  unsubscribe(client: RealtimeClient, topic: string): void {
    client.subscriptions.delete(topic);
    const set = this.topics.get(topic);
    set?.delete(client.id);
    if (set && set.size === 0) this.topics.delete(topic);
  }

  hasSubscribers(topic: string): boolean {
    return (this.topics.get(topic)?.size ?? 0) > 0;
  }

  subscribers(topic: string): RealtimeClient[] {
    const ids = this.topics.get(topic);
    if (!ids) return [];
    const out: RealtimeClient[] = [];
    for (const id of ids) {
      const c = this.clients.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  allClients(): RealtimeClient[] {
    return [...this.clients.values()];
  }

  /** Closes matching connections (e.g. all sockets of a session on logout). */
  disconnectWhere(pred: (c: RealtimeClient) => boolean, code: number, reason: string): void {
    for (const c of this.clients.values()) if (pred(c)) c.close(code, reason);
  }

  publish(topic: string, type: RealtimeEventType, data: unknown, audience?: EventAudience): void {
    const ids = this.topics.get(topic);
    if (!ids || ids.size === 0) return;
    const frame: ServerFrame = { op: "event", topic, type, ts: this.clock.now(), data };
    for (const id of ids) {
      const client = this.clients.get(id);
      if (!client) continue;
      if (audience && !authorize(client.principal, audience.permission, audience.resource)) continue;
      try {
        client.send(frame);
      } catch (err) {
        this.logger.debug({ err, clientId: id }, "realtime send failed");
      }
    }
  }

  /** Sends to one client (e.g. per-user overview summaries). */
  sendTo(client: RealtimeClient, topic: string, type: RealtimeEventType, data: unknown): void {
    client.send({ op: "event", topic, type, ts: this.clock.now(), data });
  }
}
