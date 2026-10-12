import type { Permission } from "@blockforge/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AuditService } from "../audit/service.js";
import type { Db, DbOrTx } from "../db/client.js";
import { networkMembers, servers, serverSubusers } from "../db/schema/index.js";
import { actorOf, requirePrincipal } from "../http/auth-hooks.js";
import { AppError, forbidden, notFound } from "../lib/errors.js";
import type { Principal } from "../rbac/authorize.js";
import { effectiveServerPermissions, type ServerResource } from "./permissions.js";

export type ServerRow = typeof servers.$inferSelect;

export interface ServerAccess {
  server: ServerRow;
  resource: ServerResource;
  principal: Principal;
  permissions: Set<Permission>;
}

/** Resolves servers and the requesting user's effective permissions on them. */
export class ServerAccessService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async load(serverId: string, principal: Principal, tx: DbOrTx = this.db): Promise<ServerAccess | null> {
    const [row] = await tx
      .select({ server: servers, networkId: networkMembers.networkId, subPerms: serverSubusers.permissions })
      .from(servers)
      .leftJoin(networkMembers, eq(networkMembers.serverId, servers.id))
      .leftJoin(serverSubusers, and(eq(serverSubusers.serverId, servers.id), eq(serverSubusers.userId, principal.userId)))
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!row) return null;
    const resource: ServerResource = { type: "server", id: row.server.id, nodeId: row.server.nodeId, networkId: row.networkId ?? null };
    const permissions = effectiveServerPermissions(principal, {
      resource,
      ownerId: row.server.ownerId,
      suspended: row.server.suspended,
      subuserPermissions: row.subPerms ?? null,
    });
    return { server: row.server, resource, principal, permissions };
  }

  /** Effective permissions (roles ∪ ownership ∪ subuser) or null when the server does not exist. */
  async permissionsOf(principal: Principal, serverId: string): Promise<ReadonlySet<Permission> | null> {
    return (await this.load(serverId, principal))?.permissions ?? null;
  }

  /**
   * Servers the user reaches through ownership or a subuser grant holding `permission` (role
   * bindings are resolved separately by the RBAC scopes). Owners keep `.view` permissions on
   * suspended servers, matching {@link effectiveServerPermissions}.
   */
  async personalServerIds(userId: string, permission: Permission): Promise<string[]> {
    const viewOnly = permission.endsWith(".view");
    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT s.id FROM servers s
       WHERE (s.owner_id = ${userId} OR EXISTS (
               SELECT 1 FROM server_subusers su
                WHERE su.server_id = s.id AND su.user_id = ${userId} AND ${permission} = ANY(su.permissions)))
         AND (${viewOnly} OR NOT s.suspended)`);
    return rows.rows.map((r) => r.id);
  }

  /**
   * Loads the server and checks `permission`. A user who cannot even view the server gets 404 (its
   * existence is not revealed); a viewer lacking the permission gets an audited 403.
   */
  async require(req: FastifyRequest, serverId: string, permission: Permission): Promise<ServerAccess> {
    const principal = requirePrincipal(req);
    const access = await this.load(serverId, principal);
    if (!access || !access.permissions.has("servers.view")) {
      if (access) await this.deny(req, serverId, permission);
      throw notFound("Server");
    }
    if (!access.permissions.has(permission)) {
      await this.deny(req, serverId, permission);
      if (access.server.suspended) throw new AppError(403, "FORBIDDEN", "This server is suspended");
      throw forbidden();
    }
    return access;
  }

  private async deny(req: FastifyRequest, serverId: string, permission: Permission): Promise<void> {
    await this.audit.record({
      ...actorOf(req),
      action: "authz.denied",
      targetType: "server",
      targetId: serverId,
      outcome: "denied",
      details: { permission, method: req.method, route: req.routeOptions.url ?? req.url },
    });
  }
}
