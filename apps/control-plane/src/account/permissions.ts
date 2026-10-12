import type { AccountPermissions, Permission } from "@blockforge/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { servers, serverSubusers } from "../db/schema/index.js";
import type { Principal } from "../rbac/authorize.js";
import { effectiveServerPermissions, neverInstalled, permissionList } from "../servers/permissions.js";

const sorted = (s: Iterable<Permission>) => [...new Set(s)].sort();

/**
 * `GET /account/permissions` (identity.ts `AccountPermissions`): global and scoped role grants, and
 * per-server permissions from ownership and subuser grants (role-derived server permissions are in
 * `scoped`). For an API key, everything is limited to the key's permissions.
 */
export async function accountPermissions(db: Db, principal: Principal): Promise<AccountPermissions> {
  const cap = principal.apiKey?.cap ?? null;
  const keep = (perms: Iterable<Permission>) => sorted([...perms].filter((p) => !cap || cap.has(p)));
  const global = new Set<Permission>();
  const scoped = new Map<string, { scopeType: "node" | "network" | "server"; scopeId: string; permissions: Set<Permission> }>();
  for (const g of principal.grants) {
    if (g.scopeType === "global") {
      for (const p of g.permissions) global.add(p);
      continue;
    }
    if (!g.scopeId) continue;
    const key = `${g.scopeType}:${g.scopeId}`;
    let e = scoped.get(key);
    if (!e) scoped.set(key, (e = { scopeType: g.scopeType as "node" | "network" | "server", scopeId: g.scopeId, permissions: new Set() }));
    for (const p of g.permissions) e.permissions.add(p);
  }
  // Ownership / subuser grants only (no role grants): the same rules as everywhere (suspension, key cap).
  const bare: Principal = { ...principal, grants: [] };
  const out: AccountPermissions["servers"] = [];
  const owned = await db.select().from(servers).where(eq(servers.ownerId, principal.userId));
  for (const s of owned) {
    const perms = effectiveServerPermissions(bare, {
      resource: { type: "server", id: s.id, nodeId: s.nodeId, networkId: null },
      ownerId: s.ownerId,
      suspended: s.suspended,
      subuserPermissions: null,
      neverInstalled: neverInstalled(s),
    });
    out.push({ serverId: s.id, serverName: s.name, via: "owner", permissions: permissionList(perms) });
  }
  const shared = await db
    .select({ s: servers, permissions: serverSubusers.permissions })
    .from(serverSubusers)
    .innerJoin(servers, eq(servers.id, serverSubusers.serverId))
    .where(eq(serverSubusers.userId, principal.userId));
  for (const { s, permissions } of shared) {
    if (s.ownerId === principal.userId) continue;
    const perms = effectiveServerPermissions(bare, {
      resource: { type: "server", id: s.id, nodeId: s.nodeId, networkId: null },
      ownerId: s.ownerId,
      suspended: s.suspended,
      subuserPermissions: permissions,
    });
    out.push({ serverId: s.id, serverName: s.name, via: "subuser", permissions: permissionList(perms) });
  }
  return {
    global: keep(global),
    scoped: [...scoped.values()].map((e) => ({ scopeType: e.scopeType, scopeId: e.scopeId, permissions: keep(e.permissions) })).filter((e) => e.permissions.length),
    servers: out.sort((a, b) => a.serverName.localeCompare(b.serverName)),
  };
}
