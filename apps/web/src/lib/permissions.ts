import type { Me, Permission, ScopeType } from "@blockforge/contracts";

/**
 * UI-side permission checks. These only decide what to show/enable; the API enforces every
 * permission independently, so a stale `Me` can at worst show a control that then fails.
 */
export interface ScopeRef {
  type: Exclude<ScopeType, "global">;
  id: string;
}

export function hasGlobal(me: Me | null | undefined, permission: Permission): boolean {
  return !!me && me.globalPermissions.includes(permission);
}

/** Global grant, or a grant on exactly this scope. */
export function can(me: Me | null | undefined, permission: Permission, scope?: ScopeRef): boolean {
  if (!me) return false;
  if (me.globalPermissions.includes(permission)) return true;
  if (!scope) return false;
  return me.scopedPermissions.some(
    (s) => s.scopeType === scope.type && s.scopeId === scope.id && s.permissions.includes(permission),
  );
}

/** Held anywhere (global or any scope): used to decide whether a section is reachable at all. */
export function canAny(me: Me | null | undefined, permission: Permission): boolean {
  if (!me) return false;
  return (
    me.globalPermissions.includes(permission) ||
    me.scopedPermissions.some((s) => s.permissions.includes(permission))
  );
}

export function isOwner(me: Me | null | undefined): boolean {
  return !!me && me.user.roles.some((r) => r.roleKey === "owner" && r.scopeType === "global");
}
