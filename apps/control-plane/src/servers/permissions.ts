import {
  ALL_PERMISSIONS,
  SERVER_OWNER_PERMISSIONS,
  SERVER_SCOPED_PERMISSIONS,
  SUBUSER_ASSIGNABLE_PERMISSIONS,
  type Permission,
} from "@blockforge/contracts";
import { authorize, type Principal, type Resource } from "../rbac/authorize.js";

export type ServerResource = Extract<Resource, { type: "server" }>;

export interface ServerAccessFacts {
  resource: ServerResource;
  ownerId: string;
  suspended: boolean;
  /** The requesting user's subuser permission set on this server, if any. */
  subuserPermissions: readonly string[] | null;
  /** `provision_failed` and never installed: the owner may delete it (nothing to protect yet). */
  neverInstalled?: boolean;
}

/** Facts helper: a server whose initial provisioning failed and that never reached a successful install. */
export function neverInstalled(row: { state: string; installedAt: Date | null }): boolean {
  return row.state === "provision_failed" && row.installedAt === null;
}

/** Permissions that matter on a single server (what `Server.myPermissions` reports). */
export const SERVER_RELEVANT_PERMISSIONS: readonly Permission[] = [...new Set<Permission>([...SERVER_SCOPED_PERMISSIONS, "servers.admin"])];

const OWNER_SET = new Set<Permission>(SERVER_OWNER_PERMISSIONS);
const ASSIGNABLE = new Set<Permission>(SUBUSER_ASSIGNABLE_PERMISSIONS);
const KNOWN = new Set<string>(ALL_PERMISSIONS);

/** Permissions granted by role bindings alone (global / node / network / server grants). */
export function roleServerPermissions(principal: Principal, resource: ServerResource): Set<Permission> {
  const out = new Set<Permission>();
  for (const p of SERVER_RELEVANT_PERMISSIONS) if (authorize(principal, p, resource)) out.add(p);
  return out;
}

/**
 * Effective permissions of a user on a server (api.md "Authorisation on servers"):
 * role bindings ∪ `SERVER_OWNER_PERMISSIONS` (owner) ∪ subuser set (∩ assignable). On a suspended
 * server only holders of `servers.admin` (from role bindings) keep anything beyond viewing.
 */
export function effectiveServerPermissions(principal: Principal, facts: ServerAccessFacts): Set<Permission> {
  const role = roleServerPermissions(principal, facts.resource);
  const out = new Set<Permission>(role);
  if (facts.ownerId === principal.userId) {
    for (const p of OWNER_SET) out.add(p);
    if (facts.neverInstalled) out.add("servers.delete");
  }
  for (const p of facts.subuserPermissions ?? []) {
    if (KNOWN.has(p) && ASSIGNABLE.has(p as Permission)) out.add(p as Permission);
  }
  if (facts.suspended && !role.has("servers.admin")) {
    for (const p of [...out]) if (!p.endsWith(".view")) out.delete(p);
  }
  // API keys never exceed their permission set (ownership and subuser grants included).
  if (principal.apiKey) for (const p of [...out]) if (!principal.apiKey.cap.has(p)) out.delete(p);
  return out;
}

/** Sorted list for DTOs. */
export function permissionList(set: ReadonlySet<Permission>): Permission[] {
  return [...set].filter((p) => SERVER_RELEVANT_PERMISSIONS.includes(p)).sort();
}

/**
 * Subuser updates are relative to the granter (contracts `ServerSubuser`): permissions the granter
 * does not hold are kept as they are; `requested` decides only over what the granter holds.
 * effective = (old ∖ granterHeld) ∪ (requested ∩ granterHeld).
 */
export function mergeSubuserPermissions(old: readonly string[], requested: readonly string[], granterEffective: ReadonlySet<Permission>): string[] {
  const held = (p: string) => granterEffective.has(p as Permission);
  const out = new Set<string>(old.filter((p) => !held(p)));
  for (const p of requested) if (held(p)) out.add(p);
  return [...out].sort();
}

/**
 * No-escalation rule for subusers: a granter may only grant assignable permissions it holds itself
 * on that server. Returns the offending permissions (empty = allowed).
 */
export function escalation(requested: readonly string[], granterEffective: ReadonlySet<Permission>): string[] {
  return requested.filter((p) => !KNOWN.has(p) || !ASSIGNABLE.has(p as Permission) || !granterEffective.has(p as Permission));
}
