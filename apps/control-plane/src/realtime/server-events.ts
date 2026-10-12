import type { Permission, RealtimeEventType } from "@blockforge/contracts";
import type { Logger } from "pino";
import type { ServerAccessService } from "../servers/access.js";
import type { RealtimeHub } from "./hub.js";

/**
 * Per-event permission filtering on `server:<id>` (api.md "Realtime"): the topic needs
 * `servers.view`, but some events (`player.*` → `servers.players.view`, `extensions.updated` →
 * `servers.extensions.view`) go only to subscribers whose *effective* server permissions (roles ∪
 * ownership ∪ subuser grants, suspension, API key caps) include a further permission. Events of a
 * topic are delivered in publish order even though the permission checks are asynchronous.
 */
export class ServerEventPublisher {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly hub: RealtimeHub,
    private readonly access: ServerAccessService,
    private readonly logger: Logger,
  ) {}

  publish(serverId: string, type: RealtimeEventType, data: unknown, permission: Permission): Promise<void> {
    const topic = `server:${serverId}`;
    if (!this.hub.hasSubscribers(topic) && !this.chains.has(topic)) return Promise.resolve();
    const prev = this.chains.get(topic) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const client of this.hub.subscribers(topic)) {
        const perms = await this.access.permissionsOf(client.principal, serverId).catch(() => null);
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
