import { randomUUID } from "node:crypto";
import { BUILTIN_ROLES, type Permission, type ScopeType } from "@blockforge/contracts";
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db, DbOrTx } from "../db/client.js";
import {
  networkMembers,
  networks,
  nodes,
  roleBindings,
  rolePermissions,
  roles,
  servers,
  users,
} from "../db/schema/index.js";
import { notFound } from "../lib/errors.js";
import type { Grant, Principal, Resource, ScopeSet } from "./authorize.js";

/** Loads principals and resolves resources to their enclosing scopes. */
export class RbacService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  async loadPrincipal(userId: string, tx: DbOrTx = this.db): Promise<Principal | null> {
    const [user] = await tx
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return null;
    return { userId: user.id, email: user.email, displayName: user.displayName, grants: await this.loadGrants(userId, tx) };
  }

  async loadGrants(userId: string, tx: DbOrTx = this.db): Promise<Grant[]> {
    const rows = await tx
      .select({
        bindingId: roleBindings.id,
        roleKey: roles.key,
        scopeType: roleBindings.scopeType,
        scopeId: roleBindings.scopeId,
        permission: rolePermissions.permission,
      })
      .from(roleBindings)
      .innerJoin(roles, eq(roles.id, roleBindings.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(eq(roleBindings.userId, userId));
    const byBinding = new Map<string, Grant & { permissions: Set<Permission> }>();
    for (const r of rows) {
      let g = byBinding.get(r.bindingId);
      if (!g) {
        g = {
          bindingId: r.bindingId,
          roleKey: r.roleKey,
          scopeType: r.scopeType as ScopeType,
          scopeId: r.scopeId,
          permissions: new Set<Permission>(),
        };
        byBinding.set(r.bindingId, g);
      }
      if (r.permission) g.permissions.add(r.permission as Permission);
    }
    return [...byBinding.values()];
  }

  /** Resolves a server to its node and network (server → node / network → global). */
  async server(serverId: string, tx: DbOrTx = this.db): Promise<Extract<Resource, { type: "server" }> | null> {
    const [row] = await tx
      .select({ id: servers.id, nodeId: servers.nodeId, networkId: networkMembers.networkId })
      .from(servers)
      .leftJoin(networkMembers, eq(networkMembers.serverId, servers.id))
      .where(eq(servers.id, serverId))
      .limit(1);
    return row ? { type: "server", id: row.id, nodeId: row.nodeId, networkId: row.networkId ?? null } : null;
  }

  async serverOrThrow(serverId: string): Promise<Extract<Resource, { type: "server" }>> {
    const r = await this.server(serverId);
    if (!r) throw notFound("Server");
    return r;
  }

  /** Resolves a resource reference (type + id) as used by jobs, alert subjects, bindings. */
  async resolve(type: string | null, id: string | null): Promise<Resource | null> {
    if (!type || !id || type === "global") return { type: "global" };
    if (type === "node") return { type: "node", id };
    if (type === "network") return { type: "network", id };
    if (type === "server") return this.server(id);
    return null;
  }

  /** Node ids covered by a scope set: explicit node grants (network/server grants do not expose nodes). */
  async visibleNodeIds(scopes: ScopeSet): Promise<"all" | string[]> {
    if (scopes.all) return "all";
    return [...scopes.nodeIds];
  }

  /** Server ids covered by a scope set (servers on granted nodes, in granted networks, or granted directly). */
  async visibleServerIds(scopes: ScopeSet): Promise<"all" | string[]> {
    if (scopes.all) return "all";
    const ids = new Set(scopes.serverIds);
    const nodeIds = [...scopes.nodeIds];
    const networkIds = [...scopes.networkIds];
    if (nodeIds.length || networkIds.length) {
      const rows = await this.db
        .selectDistinct({ id: servers.id })
        .from(servers)
        .leftJoin(networkMembers, eq(networkMembers.serverId, servers.id))
        .where(
          or(
            nodeIds.length ? inArray(servers.nodeId, nodeIds) : sql`false`,
            networkIds.length ? inArray(networkMembers.networkId, networkIds) : sql`false`,
          ),
        );
      for (const r of rows) ids.add(r.id);
    }
    return [...ids];
  }

  /** Human-readable scope name for role binding DTOs. */
  async scopeNames(refs: { scopeType: string; scopeId: string | null }[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = (t: string) => [...new Set(refs.filter((r) => r.scopeType === t && r.scopeId).map((r) => r.scopeId as string))];
    const [nodeIds, networkIds, serverIds] = [ids("node"), ids("network"), ids("server")];
    if (nodeIds.length) {
      for (const r of await this.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, nodeIds)))
        out.set(`node:${r.id}`, r.name);
    }
    if (networkIds.length) {
      for (const r of await this.db
        .select({ id: networks.id, name: networks.name })
        .from(networks)
        .where(inArray(networks.id, networkIds)))
        out.set(`network:${r.id}`, r.name);
    }
    if (serverIds.length) {
      for (const r of await this.db
        .select({ id: servers.id, name: servers.name })
        .from(servers)
        .where(inArray(servers.id, serverIds)))
        out.set(`server:${r.id}`, r.name);
    }
    return out;
  }

  /** Checks that a scope target exists (role binding / alert rule creation). */
  async scopeExists(scopeType: ScopeType, scopeId: string | null): Promise<boolean> {
    if (scopeType === "global") return scopeId === null;
    if (!scopeId) return false;
    const table = scopeType === "node" ? nodes : scopeType === "network" ? networks : servers;
    const [row] = await this.db.select({ id: table.id }).from(table).where(eq(table.id, scopeId)).limit(1);
    return Boolean(row);
  }

  /**
   * Idempotently seeds built-in roles. Permission sets are reconciled exactly with the contracts,
   * so upgrades that remove a permission from a built-in role (e.g. Moderator losing
   * `servers.console.send`) take effect on existing installs.
   */
  async seedBuiltinRoles(): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [key, def] of Object.entries(BUILTIN_ROLES)) {
        const [existing] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).limit(1);
        const roleId = existing?.id ?? randomUUID();
        if (existing) {
          await tx
            .update(roles)
            .set({ name: def.name, description: def.description, builtin: true, updatedAt: new Date() })
            .where(eq(roles.id, roleId));
        } else {
          await tx.insert(roles).values({ id: roleId, key, name: def.name, description: def.description, builtin: true });
        }
        const wanted = [...new Set<string>(def.permissions)];
        await tx
          .delete(rolePermissions)
          .where(and(eq(rolePermissions.roleId, roleId), notInArray(rolePermissions.permission, wanted)));
        if (wanted.length) {
          await tx
            .insert(rolePermissions)
            .values(wanted.map((permission) => ({ roleId, permission })))
            .onConflictDoNothing();
        }
      }
    });
    this.logger.debug("built-in roles reconciled");
  }
}
