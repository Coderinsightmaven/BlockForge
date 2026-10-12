import { randomUUID } from "node:crypto";
import type { Me } from "@blockforge/contracts";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { roleBindings, roles, setupState, users } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { SessionInfo } from "../http/types.js";
import type { Clock } from "../lib/clock.js";
import { randomToken, safeEqual, sha256Hex } from "../lib/crypto.js";
import { AppError, badRequest, conflict, rateLimited, unauthenticated } from "../lib/errors.js";
import { summarizePermissions } from "../rbac/authorize.js";
import type { RbacService } from "../rbac/service.js";
import type { SecretBox } from "../secrets/secret-box.js";
import type { UsersService } from "../users/service.js";
import { burnPasswordCheck, hashPassword, verifyPassword } from "./passwords.js";
import type { CreatedSession, SessionService } from "./sessions.js";
import { LOCKOUT_THRESHOLD, lockoutDurationMs, SlidingWindowLimiter } from "./throttle.js";
import { newTotpSecret, totpUri, verifyTotp } from "./totp.js";

const MFA_MAX_FAILURES = 5;
const mfaAad = (userId: string) => `user-mfa:${userId}`;

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export type LoginResult =
  | { status: "ok"; created: CreatedSession }
  | { status: "mfa_required"; created: CreatedSession };

/** Setup, login, MFA and password flows. Route handlers only translate HTTP ⇄ these calls. */
export class AuthService {
  /** Per-email attempt limiter (covers unknown accounts too); 10 attempts / 15 min. */
  private readonly emailLimiter = new SlidingWindowLimiter(10, 15 * 60_000);

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly sessions: SessionService,
    private readonly rbac: RbacService,
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
    private readonly box: SecretBox,
    private readonly logger: Logger,
  ) {}

  // --- Setup -----------------------------------------------------------------

  async isSetupRequired(): Promise<boolean> {
    const [row] = await this.db.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
    return !row?.completedAt;
  }

  /**
   * On boot, when no owner was created yet, generates a fresh one-time setup token, stores its
   * hash and hands the plaintext to `sink` (which prints it once to the log). Returns the token
   * (or null when setup is complete).
   */
  async ensureSetupToken(sink: (token: string) => void): Promise<string | null> {
    if (!(await this.isSetupRequired())) return null;
    const token = randomToken(24);
    const now = new Date(this.clock.now());
    await this.db
      .insert(setupState)
      .values({ id: 1, setupTokenHash: sha256Hex(token), tokenCreatedAt: now })
      .onConflictDoUpdate({ target: setupState.id, set: { setupTokenHash: sha256Hex(token), tokenCreatedAt: now } });
    sink(token);
    return token;
  }

  async completeSetup(
    input: { setupToken: string; email: string; displayName: string; password: string },
    client: ClientInfo,
  ): Promise<CreatedSession> {
    const passwordHash = await hashPassword(input.password);
    const userId = randomUUID();
    return withTransaction(this.db, async (tx) => {
      const [state] = await tx.select().from(setupState).where(eq(setupState.id, 1)).for("update").limit(1);
      if (state?.completedAt) throw new AppError(409, "SETUP_ALREADY_COMPLETED", "Setup has already been completed");
      if (!state?.setupTokenHash || !safeEqual(sha256Hex(input.setupToken), state.setupTokenHash)) {
        await this.audit.record({
          actorType: "user",
          actorId: null,
          actorName: input.email,
          ip: client.ip,
          requestId: client.requestId,
          action: "auth.setup",
          outcome: "denied",
          details: { reason: "invalid setup token" },
        });
        throw unauthenticated("Invalid setup token");
      }
      const [ownerRole] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, "owner")).limit(1);
      if (!ownerRole) throw new Error("built-in roles are not seeded");
      await tx.insert(users).values({ id: userId, email: input.email, displayName: input.displayName, passwordHash });
      await tx.insert(roleBindings).values({ id: randomUUID(), userId, roleId: ownerRole.id, scopeType: "global", scopeId: null });
      await tx
        .update(setupState)
        .set({ completedAt: new Date(this.clock.now()), setupTokenHash: null })
        .where(eq(setupState.id, 1));
      const created = await this.sessions.create(userId, { mfaVerified: true, ip: client.ip, userAgent: client.userAgent }, tx);
      await this.audit.record(
        {
          actorType: "user",
          actorId: userId,
          actorName: input.email,
          ip: client.ip,
          requestId: client.requestId,
          action: "auth.setup",
          targetType: "user",
          targetId: userId,
          outcome: "success",
        },
        tx,
      );
      return created;
    });
  }

  // --- Login -----------------------------------------------------------------

  async login(email: string, password: string, client: ClientInfo): Promise<LoginResult> {
    const now = this.clock.now();
    const waitMs = this.emailLimiter.hit(email, now);
    if (waitMs > 0) {
      await this.auditLogin(email, null, client, "denied", { reason: "rate limited" });
      throw rateLimited(waitMs / 1000);
    }
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (user?.lockedUntil && user.lockedUntil.getTime() > now) {
      await burnPasswordCheck(password);
      await this.auditLogin(email, user.id, client, "denied", { reason: "account locked" });
      throw rateLimited((user.lockedUntil.getTime() - now) / 1000);
    }
    const ok = user ? await verifyPassword(user.passwordHash, password) : (await burnPasswordCheck(password), false);
    if (!user || !ok || user.status !== "active") {
      if (user && !ok) {
        const failed = user.failedLoginCount + 1;
        const lockMs = lockoutDurationMs(failed);
        await this.db
          .update(users)
          .set({ failedLoginCount: failed, lockedUntil: lockMs > 0 ? new Date(now + lockMs) : user.lockedUntil })
          .where(eq(users.id, user.id));
        if (failed >= LOCKOUT_THRESHOLD) this.logger.warn({ userId: user.id, failed }, "account temporarily locked after failed logins");
      }
      await this.auditLogin(email, user?.id ?? null, client, "failed", {
        reason: !user ? "unknown account" : !ok ? "wrong password" : "account disabled",
      });
      throw unauthenticated("Invalid email or password");
    }
    await this.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(now) })
      .where(eq(users.id, user.id));
    this.emailLimiter.reset(email);
    const created = await this.sessions.create(user.id, { mfaVerified: !user.mfaEnabled, ip: client.ip, userAgent: client.userAgent });
    await this.auditLogin(email, user.id, client, "success", { mfaRequired: user.mfaEnabled });
    return { status: user.mfaEnabled ? "mfa_required" : "ok", created };
  }

  private auditLogin(
    email: string,
    userId: string | null,
    client: ClientInfo,
    outcome: "success" | "failed" | "denied",
    details: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      actorType: "user",
      actorId: userId,
      actorName: email,
      ip: client.ip,
      requestId: client.requestId,
      action: "auth.login",
      targetType: "user",
      targetId: userId,
      outcome,
      details,
    });
  }

  async logout(session: SessionInfo, actor: AuditActor): Promise<void> {
    await this.sessions.revoke(session.id);
    await this.audit.record({ ...actor, action: "auth.logout", targetType: "user", targetId: session.user.id, outcome: "success" });
  }

  // --- Me ----------------------------------------------------------------------

  async me(session: SessionInfo): Promise<Me> {
    const principal = await this.rbac.loadPrincipal(session.user.id);
    if (!principal) throw unauthenticated();
    const user = await this.usersService.getDto(session.user.id);
    return {
      user,
      ...summarizePermissions(principal),
      session: { mfaVerified: session.mfaVerified || !session.user.mfaEnabled, expiresAt: session.expiresAt.getTime() },
      csrfToken: this.sessions.csrfTokenFor(session.tokenHash),
    };
  }

  // --- MFA -----------------------------------------------------------------------

  /**
   * Second factor for a session created by `login`. On success the session is *replaced* by a new
   * one (fresh token + CSRF token) so a token observed before verification cannot be used after.
   */
  async verifyMfa(session: SessionInfo, code: string, client: ClientInfo): Promise<CreatedSession | null> {
    if (session.mfaVerified || !session.user.mfaEnabled) return null;
    const [user] = await this.db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
    if (!user?.mfaTotpSecretEnc) throw unauthenticated();
    const secret = this.box.decryptString(user.mfaTotpSecretEnc, mfaAad(user.id));
    const check = await verifyTotp(secret, code, this.clock.now(), user.mfaLastTimeStep);
    const actor: AuditActor = { actorType: "user", actorId: user.id, actorName: user.email, ip: client.ip, requestId: client.requestId };
    if (!check.valid) {
      const failures = await this.sessions.recordMfaFailure(session.id);
      await this.audit.record({ ...actor, action: "auth.mfa.verify", targetType: "user", targetId: user.id, outcome: "failed", details: { failures } });
      if (failures >= MFA_MAX_FAILURES) {
        await this.sessions.revoke(session.id);
        throw unauthenticated("Too many invalid codes; sign in again");
      }
      throw badRequest("Invalid verification code");
    }
    return withTransaction(this.db, async (tx) => {
      await tx.update(users).set({ mfaLastTimeStep: check.timeStep ?? null }).where(eq(users.id, user.id));
      await this.sessions.revoke(session.id, tx);
      const created = await this.sessions.create(user.id, { mfaVerified: true, ip: client.ip, userAgent: client.userAgent }, tx);
      await this.audit.record({ ...actor, action: "auth.mfa.verify", targetType: "user", targetId: user.id, outcome: "success" }, tx);
      return created;
    });
  }

  async startMfaEnrollment(session: SessionInfo, actor: AuditActor): Promise<{ otpauthUrl: string; secret: string }> {
    const [user] = await this.db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
    if (!user) throw unauthenticated();
    if (user.mfaEnabled) throw conflict("Multi-factor authentication is already enabled");
    const secret = newTotpSecret();
    await this.db
      .update(users)
      .set({ mfaPendingSecretEnc: this.box.encryptToString(secret, mfaAad(user.id)), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await this.audit.record({ ...actor, action: "auth.mfa.enroll.start", targetType: "user", targetId: user.id, outcome: "success" });
    return { otpauthUrl: totpUri(secret, user.email), secret };
  }

  async confirmMfaEnrollment(session: SessionInfo, code: string, actor: AuditActor): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
    if (!user) throw unauthenticated();
    if (user.mfaEnabled) throw conflict("Multi-factor authentication is already enabled");
    if (!user.mfaPendingSecretEnc) throw conflict("Start enrollment first");
    const secret = this.box.decryptString(user.mfaPendingSecretEnc, mfaAad(user.id));
    const check = await verifyTotp(secret, code, this.clock.now(), null);
    if (!check.valid) {
      await this.audit.record({ ...actor, action: "auth.mfa.enroll.confirm", targetType: "user", targetId: user.id, outcome: "failed" });
      throw badRequest("Invalid verification code");
    }
    await withTransaction(this.db, async (tx) => {
      await tx
        .update(users)
        .set({
          mfaEnabled: true,
          mfaTotpSecretEnc: user.mfaPendingSecretEnc,
          mfaPendingSecretEnc: null,
          mfaLastTimeStep: check.timeStep ?? null,
          updatedAt: new Date(),
          version: user.version + 1,
        })
        .where(eq(users.id, user.id));
      await this.sessions.markMfaVerified(session.id, tx);
      await this.sessions.requireMfaOnOthers(user.id, session.id, tx);
      await this.audit.record({ ...actor, action: "auth.mfa.enable", targetType: "user", targetId: user.id, outcome: "success" }, tx);
    });
  }

  async disableMfa(session: SessionInfo, code: string, actor: AuditActor): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
    if (!user) throw unauthenticated();
    if (!user.mfaEnabled || !user.mfaTotpSecretEnc) throw conflict("Multi-factor authentication is not enabled");
    const secret = this.box.decryptString(user.mfaTotpSecretEnc, mfaAad(user.id));
    const check = await verifyTotp(secret, code, this.clock.now(), user.mfaLastTimeStep);
    if (!check.valid) {
      await this.audit.record({ ...actor, action: "auth.mfa.disable", targetType: "user", targetId: user.id, outcome: "failed" });
      throw badRequest("Invalid verification code");
    }
    await this.db
      .update(users)
      .set({ mfaEnabled: false, mfaTotpSecretEnc: null, mfaPendingSecretEnc: null, mfaLastTimeStep: null, updatedAt: new Date(), version: user.version + 1 })
      .where(eq(users.id, user.id));
    await this.audit.record({ ...actor, action: "auth.mfa.disable", targetType: "user", targetId: user.id, outcome: "success" });
  }

  // --- Password ----------------------------------------------------------------

  async changePassword(session: SessionInfo, currentPassword: string, newPassword: string, actor: AuditActor): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
    if (!user) throw unauthenticated();
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      await this.audit.record({ ...actor, action: "auth.password.change", targetType: "user", targetId: user.id, outcome: "failed" });
      throw badRequest("Current password is incorrect");
    }
    if (currentPassword === newPassword) throw badRequest("The new password must differ from the current one");
    const passwordHash = await hashPassword(newPassword);
    await withTransaction(this.db, async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, passwordChangedAt: new Date(this.clock.now()), updatedAt: new Date(), version: user.version + 1 })
        .where(eq(users.id, user.id));
      await this.sessions.revokeOthers(user.id, session.id, tx);
      await this.audit.record({ ...actor, action: "auth.password.change", targetType: "user", targetId: user.id, outcome: "success" }, tx);
    });
  }
}
