import { randomUUID } from "node:crypto";
import {
  BUILTIN_ROLES,
  permissionAllowsScope,
  type Permission,
  type Role,
  type RoleBinding,
  type ScopeType,
  type User,
} from "@blockforge/contracts";
import { and, asc, count, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "../db/client.js";
import { roleBindings, rolePermissions, roles, users } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { AuditActor, AuditService } from "../audit/service.js";
import { hashPassword } from "../auth/passwords.js";
import type { SessionService } from "../auth/sessions.js";
import { badRequest, conflict, forbidden, notFound, validationDetails } from "../lib/errors.js";
import type { TimeIdCursor } from "../lib/pagination.js";
import { isOwner, isPrivilegedRole, type Principal } from "../rbac/authorize.js";
import type { RbacService } from "../rbac/service.js";

export interface RoleBindingInput {
  roleKey: string;
  scopeType: ScopeType;
  scopeId: string | null;
}

type UserRow = typeof users.$inferSelect;

/**
 * User & role administration. Privileged-role rules:
 *  - Owner/Administrator roles can only be granted or revoked by an Owner, and only at global scope.
 *  - Accounts holding a privileged role can only be disabled / reset by an Owner.
 *  - The last active Owner cannot be disabled or lose the Owner role; users cannot disable themselves.
 */
export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async toDtos(rows: UserRow[]): Promise<User[]> {
    if (rows.length === 0) return [];
    const bindings = await this.db
      .select({
        id: roleBindings.id,
        userId: roleBindings.userId,
        roleKey: roles.key,
        roleName: roles.name,
        scopeType: roleBindings.scopeType,
        scopeId: roleBindings.scopeId,
      })
      .from(roleBindings)
      .innerJoin(roles, eq(roles.id, roleBindings.roleId))
      .where(
        inArray(
          roleBindings.userId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(roleBindings.createdAt));
    const names = await this.rbac.scopeNames(bindings);
    const byUser = new Map<string, RoleBinding[]>();
    for (const b of bindings) {
      const list = byUser.get(b.userId) ?? [];
      list.push({
        id: b.id,
        roleKey: b.roleKey,
        roleName: b.roleName,
        scopeType: b.scopeType as ScopeType,
        scopeId: b.scopeId,
        scopeName: b.scopeId ? (names.get(`${b.scopeType}:${b.scopeId}`) ?? null) : null,
      });
      byUser.set(b.userId, list);
    }
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      username: r.username,
      displayName: r.displayName,
      status: r.status as User["status"],
      mfaEnabled: r.mfaEnabled,
      lastLoginAt: r.lastLoginAt?.getTime() ?? null,
      createdAt: r.createdAt.getTime(),
      roles: byUser.get(r.id) ?? [],
    }));
  }

  async getDto(userId: string): Promise<User> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) throw notFound("User");
    const [dto] = await this.toDtos([row]);
    if (!dto) throw notFound("User");
    return dto;
  }

  async list(limit: number, cursor: TimeIdCursor | null): Promise<{ items: User[]; next: TimeIdCursor | null }> {
    const where = cursor
      ? or(lt(users.createdAt, new Date(cursor.t)), and(eq(users.createdAt, new Date(cursor.t)), lt(users.id, cursor.id)))
      : undefined;
    const rows = await this.db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.toDtos(page),
      next: rows.length > limit && last ? { t: last.createdAt.getTime(), id: last.id } : null,
    };
  }

  async listRoles(): Promise<Role[]> {
    const rows = await this.db
      .select({ role: roles, permission: rolePermissions.permission })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .orderBy(asc(roles.createdAt));
    const map = new Map<string, Role>();
    for (const r of rows) {
      let role = map.get(r.role.id);
      if (!role) {
        role = {
          id: r.role.id,
          key: r.role.key,
          name: r.role.name,
          description: r.role.description,
          builtin: r.role.builtin,
          permissions: [],
        };
        map.set(r.role.id, role);
      }
      if (r.permission) role.permissions.push(r.permission as Permission);
    }
    const order = Object.keys(BUILTIN_ROLES);
    return [...map.values()]
      .map((r) => ({ ...r, permissions: [...r.permissions].sort() }))
      .sort((a, b) => {
        const ia = order.indexOf(a.key);
        const ib = order.indexOf(b.key);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.name.localeCompare(b.name);
      });
  }

  private async findRole(roleKey: string, tx: DbOrTx) {
    const rows = await tx
      .select({ id: roles.id, key: roles.key, permission: rolePermissions.permission })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(eq(roles.key, roleKey));
    const first = rows[0];
    if (!first) return null;
    return { id: first.id, key: first.key, permissions: rows.flatMap((r) => (r.permission ? [r.permission as Permission] : [])) };
  }

  /** Validates that `actor` may create this binding (privileged-role and scope rules). */
  private async checkGrant(actor: Principal, input: RoleBindingInput, tx: DbOrTx) {
    const role = await this.findRole(input.roleKey, tx);
    if (!role) throw badRequest(`Unknown role "${input.roleKey}"`);
    if ((input.scopeType === "global") !== (input.scopeId === null)) {
      throw badRequest("scopeId must be null for global scope and set otherwise");
    }
    if (isPrivilegedRole(role.key)) {
      if (!isOwner(actor)) throw forbidden("Only an Owner can grant or revoke the Owner and Administrator roles");
      if (input.scopeType !== "global") throw badRequest("Owner and Administrator roles can only be granted globally");
    }
    if (!role.permissions.some((p) => permissionAllowsScope(p, input.scopeType))) {
      throw badRequest(`Role "${role.key}" grants nothing at ${input.scopeType} scope`);
    }
    if (!(await this.rbac.scopeExists(input.scopeType, input.scopeId))) throw badRequest("Scope target does not exist");
    return role;
  }

  private async userGrants(userId: string, tx: DbOrTx) {
    return tx
      .select({ id: roleBindings.id, roleKey: roles.key, scopeType: roleBindings.scopeType })
      .from(roleBindings)
      .innerJoin(roles, eq(roles.id, roleBindings.roleId))
      .where(eq(roleBindings.userId, userId));
  }

  /** Owners can manage anyone; others cannot manage accounts that hold a privileged role. */
  private async checkCanManage(actor: Principal, targetUserId: string, tx: DbOrTx): Promise<void> {
    if (isOwner(actor)) return;
    const grants = await this.userGrants(targetUserId, tx);
    if (grants.some((g) => isPrivilegedRole(g.roleKey))) {
      throw forbidden("Only an Owner can manage accounts that hold the Owner or Administrator role");
    }
  }

  /** Active users holding the global Owner role, optionally ignoring one binding or one user. */
  private async activeOwnerCount(tx: Tx, exclude: { bindingId?: string; userId?: string } = {}): Promise<number> {
    const conds = [eq(roles.key, "owner"), eq(roleBindings.scopeType, "global"), eq(users.status, "active")];
    if (exclude.bindingId) conds.push(ne(roleBindings.id, exclude.bindingId));
    if (exclude.userId) conds.push(ne(users.id, exclude.userId));
    const [row] = await tx
      .select({ n: count() })
      .from(roleBindings)
      .innerJoin(roles, eq(roles.id, roleBindings.roleId))
      .innerJoin(users, eq(users.id, roleBindings.userId))
      .where(and(...conds));
    return Number(row?.n ?? 0);
  }

  async create(
    actor: Principal,
    audit: AuditActor,
    input: { email: string; username: string; displayName: string; password: string; roles: RoleBindingInput[] },
  ): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    await withTransaction(this.db, async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
      if (existing) throw conflict("A user with this email already exists");
      const [sameName] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username)).limit(1);
      if (sameName) throw conflict("A user with this username already exists", validationDetails("already taken", "username"));
      const checked = [];
      for (const r of input.roles) checked.push({ role: await this.checkGrant(actor, r, tx), input: r });
      await tx.insert(users).values({ id, email: input.email, username: input.username, displayName: input.displayName, passwordHash });
      for (const c of checked) {
        await tx
          .insert(roleBindings)
          .values({ id: randomUUID(), userId: id, roleId: c.role.id, scopeType: c.input.scopeType, scopeId: c.input.scopeId, createdBy: actor.userId })
          .onConflictDoNothing();
      }
      await this.audit.record(
        { ...audit, action: "user.create", targetType: "user", targetId: id, outcome: "success", details: { email: input.email, username: input.username, roles: input.roles } },
        tx,
      );
    });
    return this.getDto(id);
  }

  async update(
    actor: Principal,
    audit: AuditActor,
    userId: string,
    input: { displayName?: string | undefined; username?: string | undefined; status?: "active" | "disabled" | undefined },
  ): Promise<User> {
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.id, userId)).for("update").limit(1);
      if (!row) throw notFound("User");
      if (input.username !== undefined && input.username !== row.username) {
        const [sameName] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username)).limit(1);
        if (sameName) throw conflict("A user with this username already exists", validationDetails("already taken", "username"));
      }
      if (input.status && input.status !== row.status) {
        await this.checkCanManage(actor, userId, tx);
        if (input.status === "disabled") {
          if (userId === actor.userId) throw badRequest("You cannot disable your own account");
          await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, "owner")).for("update");
          if ((await this.activeOwnerCount(tx, { userId })) === 0 && (await this.isActiveOwner(userId, tx))) {
            throw conflict("Cannot disable the last active Owner");
          }
          await this.sessions.revokeAllForUser(userId, tx);
        }
      }
      await tx
        .update(users)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.username !== undefined ? { username: input.username } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: new Date(),
          version: row.version + 1,
        })
        .where(eq(users.id, userId));
      await this.audit.record(
        { ...audit, action: "user.update", targetType: "user", targetId: userId, outcome: "success", details: { ...input } },
        tx,
      );
    });
    return this.getDto(userId);
  }

  private async isActiveOwner(userId: string, tx: DbOrTx): Promise<boolean> {
    const grants = await this.userGrants(userId, tx);
    const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId));
    return u?.status === "active" && grants.some((g) => g.roleKey === "owner" && g.scopeType === "global");
  }

  async resetPassword(actor: Principal, audit: AuditActor, userId: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.select({ id: users.id, version: users.version }).from(users).where(eq(users.id, userId));
      if (!row) throw notFound("User");
      await this.checkCanManage(actor, userId, tx);
      await tx
        .update(users)
        .set({ passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, updatedAt: new Date(), version: row.version + 1 })
        .where(eq(users.id, userId));
      await this.sessions.revokeAllForUser(userId, tx);
      await this.audit.record({ ...audit, action: "user.password.reset", targetType: "user", targetId: userId, outcome: "success" }, tx);
    });
  }

  async resetMfa(actor: Principal, audit: AuditActor, userId: string): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.select({ id: users.id, version: users.version }).from(users).where(eq(users.id, userId));
      if (!row) throw notFound("User");
      await this.checkCanManage(actor, userId, tx);
      await tx
        .update(users)
        .set({ mfaEnabled: false, mfaTotpSecretEnc: null, mfaPendingSecretEnc: null, mfaLastTimeStep: null, updatedAt: new Date(), version: row.version + 1 })
        .where(eq(users.id, userId));
      await this.sessions.revokeAllForUser(userId, tx);
      await this.audit.record({ ...audit, action: "user.mfa.reset", targetType: "user", targetId: userId, outcome: "success" }, tx);
    });
  }

  async addRole(actor: Principal, audit: AuditActor, userId: string, input: RoleBindingInput): Promise<User> {
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
      if (!row) throw notFound("User");
      const role = await this.checkGrant(actor, input, tx);
      const inserted = await tx
        .insert(roleBindings)
        .values({ id: randomUUID(), userId, roleId: role.id, scopeType: input.scopeType, scopeId: input.scopeId, createdBy: actor.userId })
        .onConflictDoNothing()
        .returning({ id: roleBindings.id });
      if (inserted.length === 0) throw conflict("The user already has this role at this scope");
      await this.audit.record(
        { ...audit, action: "user.role.add", targetType: "user", targetId: userId, outcome: "success", details: { ...input } },
        tx,
      );
    });
    return this.getDto(userId);
  }

  async removeRole(actor: Principal, audit: AuditActor, userId: string, bindingId: string): Promise<User> {
    await withTransaction(this.db, async (tx) => {
      const [binding] = await tx
        .select({ id: roleBindings.id, roleKey: roles.key, scopeType: roleBindings.scopeType, scopeId: roleBindings.scopeId })
        .from(roleBindings)
        .innerJoin(roles, eq(roles.id, roleBindings.roleId))
        .where(and(eq(roleBindings.id, bindingId), eq(roleBindings.userId, userId)))
        .limit(1);
      if (!binding) throw notFound("Role binding");
      if (isPrivilegedRole(binding.roleKey) && !isOwner(actor)) {
        throw forbidden("Only an Owner can grant or revoke the Owner and Administrator roles");
      }
      if (binding.roleKey === "owner" && binding.scopeType === "global") {
        // Serialise concurrent owner removals so two requests cannot both pass the check.
        await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, "owner")).for("update");
        if ((await this.activeOwnerCount(tx, { bindingId })) === 0) throw conflict("Cannot remove the last Owner");
      }
      await tx.delete(roleBindings).where(eq(roleBindings.id, bindingId));
      await this.audit.record(
        {
          ...audit,
          action: "user.role.remove",
          targetType: "user",
          targetId: userId,
          outcome: "success",
          details: { roleKey: binding.roleKey, scopeType: binding.scopeType, scopeId: binding.scopeId },
        },
        tx,
      );
    });
    return this.getDto(userId);
  }
}
