import { PRIVILEGED_ROLES, permissionAllowsScope, type Permission, type ScopeType } from "@blockforge/contracts";

export interface Grant {
  bindingId: string;
  roleKey: string;
  scopeType: ScopeType;
  scopeId: string | null;
  permissions: ReadonlySet<Permission>;
}

export interface Principal {
  userId: string;
  email: string;
  displayName: string;
  grants: readonly Grant[];
}

/**
 * The target of an authorisation check. Servers must be resolved to their node and network first
 * (`ScopeResolver.server`), because grants on the node or network also cover the server.
 */
export type Resource =
  | { type: "global" }
  | { type: "node"; id: string }
  | { type: "network"; id: string }
  | { type: "server"; id: string; nodeId: string; networkId: string | null };

export const GLOBAL: Resource = { type: "global" };

/** Whether a grant's scope contains the resource (global ⊇ node ⊇ server, global ⊇ network ⊇ server). */
export function scopeCovers(grant: Pick<Grant, "scopeType" | "scopeId">, resource: Resource): boolean {
  switch (grant.scopeType) {
    case "global":
      return true;
    case "node":
      return (
        (resource.type === "node" && resource.id === grant.scopeId) ||
        (resource.type === "server" && resource.nodeId === grant.scopeId)
      );
    case "network":
      return (
        (resource.type === "network" && resource.id === grant.scopeId) ||
        (resource.type === "server" && resource.networkId !== null && resource.networkId === grant.scopeId)
      );
    case "server":
      return resource.type === "server" && resource.id === grant.scopeId;
  }
}

/** A grant only confers a permission at scope types where that permission may be granted. */
function grantGives(grant: Grant, permission: Permission): boolean {
  return grant.permissions.has(permission) && permissionAllowsScope(permission, grant.scopeType);
}

export function authorize(principal: Principal, permission: Permission, resource: Resource): boolean {
  return principal.grants.some((g) => grantGives(g, permission) && scopeCovers(g, resource));
}

/** True if the principal holds the permission at any scope (used for topic/list gating). */
export function hasPermissionAnywhere(principal: Principal, permission: Permission): boolean {
  return principal.grants.some((g) => grantGives(g, permission));
}

export interface ScopeSet {
  all: boolean;
  nodeIds: Set<string>;
  networkIds: Set<string>;
  serverIds: Set<string>;
}

/** The scopes in which the principal holds `permission`; used to filter lists in SQL. */
export function permittedScopes(principal: Principal, permission: Permission): ScopeSet {
  const out: ScopeSet = { all: false, nodeIds: new Set(), networkIds: new Set(), serverIds: new Set() };
  for (const g of principal.grants) {
    if (!grantGives(g, permission)) continue;
    if (g.scopeType === "global") out.all = true;
    else if (g.scopeType === "node" && g.scopeId) out.nodeIds.add(g.scopeId);
    else if (g.scopeType === "network" && g.scopeId) out.networkIds.add(g.scopeId);
    else if (g.scopeType === "server" && g.scopeId) out.serverIds.add(g.scopeId);
  }
  return out;
}

export function isOwner(principal: Principal): boolean {
  return principal.grants.some((g) => g.roleKey === "owner" && g.scopeType === "global");
}

export function isPrivilegedRole(roleKey: string): boolean {
  return (PRIVILEGED_ROLES as readonly string[]).includes(roleKey);
}

export function holdsPrivilegedRole(grants: readonly Pick<Grant, "roleKey">[]): boolean {
  return grants.some((g) => isPrivilegedRole(g.roleKey));
}

/** Global permissions and per-scope permissions, as reported by `GET /auth/me`. */
export function summarizePermissions(principal: Principal): {
  globalPermissions: Permission[];
  scopedPermissions: { scopeType: ScopeType; scopeId: string; permissions: Permission[] }[];
} {
  const global = new Set<Permission>();
  const scoped = new Map<string, { scopeType: ScopeType; scopeId: string; permissions: Set<Permission> }>();
  for (const g of principal.grants) {
    for (const p of g.permissions) {
      if (!permissionAllowsScope(p, g.scopeType)) continue;
      if (g.scopeType === "global") global.add(p);
      else if (g.scopeId) {
        const key = `${g.scopeType}:${g.scopeId}`;
        const entry = scoped.get(key) ?? { scopeType: g.scopeType, scopeId: g.scopeId, permissions: new Set() };
        entry.permissions.add(p);
        scoped.set(key, entry);
      }
    }
  }
  return {
    globalPermissions: [...global].sort(),
    scopedPermissions: [...scoped.values()].map((s) => ({ ...s, permissions: [...s.permissions].sort() })),
  };
}
