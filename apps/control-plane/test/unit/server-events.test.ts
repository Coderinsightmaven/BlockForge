import type { Permission, ServerFrame } from "@blockforge/contracts";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { Principal } from "../../src/rbac/authorize.js";
import { RealtimeHub, type RealtimeClient } from "../../src/realtime/hub.js";
import { ServerEventPublisher } from "../../src/realtime/server-events.js";
import type { ServerAccessService } from "../../src/servers/access.js";

const SERVER = "11111111-1111-4111-8111-111111111111";
const logger = pino({ level: "silent" });

const principal = (perms: Permission[]): Principal => ({
  userId: "u1",
  email: "bob@example.com",
  username: "bob",
  displayName: "Bob",
  grants: [{ bindingId: "b1", roleKey: "custom", scopeType: "global", scopeId: null, permissions: new Set(perms) }],
});

describe("L1 realtime per-event permissions follow role changes at delivery time", () => {
  function setup() {
    const clock = { now: 1_000_000 };
    const hub = new RealtimeHub({ now: () => clock.now } as never, logger);
    const frames: ServerFrame[] = [];
    // The socket's principal is the stale one from connect time (refreshed only every 30 s).
    const client: RealtimeClient = {
      id: "c1",
      userId: "u1",
      sessionId: "s1",
      principal: principal(["servers.view", "servers.players.view"]),
      subscriptions: new Set(),
      send: (f) => void frames.push(f),
      close: () => undefined,
    };
    hub.register(client);
    hub.subscribe(client, `server:${SERVER}`);
    // Effective server permissions = the principal's global grants (enough for this test).
    const access = { permissionsOf: async (p: Principal) => new Set(p.grants.flatMap((g) => [...g.permissions])) } as unknown as ServerAccessService;
    let current: Principal | null = principal(["servers.view", "servers.players.view"]);
    let loads = 0;
    const publisher = new ServerEventPublisher(hub, access, logger, {
      load: async () => (loads++, current),
      now: () => clock.now,
      ttlMs: 1_000,
    });
    return {
      clock,
      frames,
      publisher,
      revoke: () => (current = principal(["servers.view"])),
      deleteUser: () => (current = null),
      loads: () => loads,
    };
  }

  it("a revoked permission stops player events within the short cache TTL, not after the 30 s socket refresh", async () => {
    const s = setup();
    await s.publisher.publish(SERVER, "player.joined", { name: "Steve" }, "servers.players.view");
    expect(s.frames).toHaveLength(1);
    s.revoke();
    // Within the TTL the cached principal may still be used (bounded staleness: 1 s) …
    await s.publisher.publish(SERVER, "player.left", { name: "Steve" }, "servers.players.view");
    expect(s.loads()).toBe(1);
    // … after it, the re-read principal decides.
    s.clock.now += 1_000;
    await s.publisher.publish(SERVER, "player.joined", { name: "Alex" }, "servers.players.view");
    await s.publisher.publish(SERVER, "extensions.updated", {}, "servers.extensions.view");
    expect(s.frames).toHaveLength(2);
    expect(s.loads()).toBe(2);
    s.clock.now += 1_000;
    s.deleteUser();
    await s.publisher.publish(SERVER, "player.joined", { name: "Alex" }, "servers.players.view");
    expect(s.frames).toHaveLength(2);
  });
});
