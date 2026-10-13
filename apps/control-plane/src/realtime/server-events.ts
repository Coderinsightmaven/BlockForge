import type { Permission, RealtimeEventType } from "@blockforge/contracts";
import type { Logger } from "pino";
import { capPrincipal, type Principal } from "../rbac/authorize.js";
import type { ServerAccessService } from "../servers/access.js";
import type { RealtimeClient, RealtimeHub } from "./hub.js";

/** How long a principal re-read for delivery is reused (bursts of events, many sockets of one user). */
export const DELIVERY_PRINCIPAL_TTL_MS = 1_000;
const MAX_CACHED_PRINCIPALS = 1_000;

export interface DeliveryPrincipals {
  /** Current principal of a user (role bindings from the database); null when the user is gone. */
  load(userId: string): Promise<Principal | null>;
  now(): number;
  /** Default `DELIVERY_PRINCIPAL_TTL_MS`. */
  ttlMs?: number;
}

/**
 * Per-event permission filtering on `server:<id>` (api.md "Realtime"): the topic needs
 * `servers.view`, but some events (`player.*` → `servers.players.view`, `extensions.updated` →
 * `servers.extensions.view`) go only to subscribers whose *effective* server permissions (roles ∪
 * ownership ∪ subuser grants, suspension, API key caps) include a further permission. Events of a
 * topic are delivered in publish order even though the permission checks are asynchronous.
 *
 * The socket's own principal is refreshed only every 30 s (realtime/gateway.ts), so with
 * `principals` the role bindings are re-read at delivery time (cached for about a second per user):
 * a revoked role stops these events within that second instead of up to 30 s. Role changes publish
 * no event to invalidate on, and a per-user read per event is cheap for these low-rate events.
 */
export class ServerEventPublisher {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, { at: number; principal: Promise<Principal | null> }>();

  constructor(
    private readonly hub: RealtimeHub,
    private readonly access: ServerAccessService,
    private readonly logger: Logger,
    private readonly principals?: DeliveryPrincipals,
  ) {}

  private async principalOf(client: RealtimeClient): Promise<Principal | null> {
    const p = this.principals;
    if (!p) return client.principal;
    const now = p.now();
    const ttl = p.ttlMs ?? DELIVERY_PRINCIPAL_TTL_MS;
    const hit = this.cache.get(client.userId);
    if (hit && now - hit.at < ttl) return hit.principal;
    if (this.cache.size >= MAX_CACHED_PRINCIPALS) {
      for (const [k, v] of this.cache) if (now - v.at >= ttl) this.cache.delete(k);
      if (this.cache.size >= MAX_CACHED_PRINCIPALS) this.cache.clear();
    }
    const principal = p.load(client.userId).catch(() => null);
    this.cache.set(client.userId, { at: now, principal });
    return principal;
  }

  publish(serverId: string, type: RealtimeEventType, data: unknown, permission: Permission): Promise<void> {
    const topic = `server:${serverId}`;
    if (!this.hub.hasSubscribers(topic) && !this.chains.has(topic)) return Promise.resolve();
    const prev = this.chains.get(topic) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const client of this.hub.subscribers(topic)) {
        const fresh = await this.principalOf(client);
        // An API-key socket keeps its key's cap on top of the re-read grants.
        const key = client.principal.apiKey;
        const principal = fresh && key ? capPrincipal(fresh, key, key.cap) : fresh;
        const perms = principal ? await this.access.permissionsOf(principal, serverId).catch(() => null) : null;
        if (!perms?.has(permission) || !client.subscriptions.has(topic)) continue;
        try {
          this.hub.sendTo(client, topic, type, data);
        } catch (err) {
          this.logger.debug({ err, clientId: client.id }, "realtime send failed");
        }
      }
    });
    const settled = next.catch((err: unknown) => this.logger.warn({ err, topic, type }, "realtime fan-out failed"));
    this.chains.set(topic, settled);
    void settled.finally(() => {
      if (this.chains.get(topic) === settled) this.chains.delete(topic);
    });
    return settled;
  }
}
