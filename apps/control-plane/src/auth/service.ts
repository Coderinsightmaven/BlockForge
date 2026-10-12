import { randomUUID } from "node:crypto";
import type { Me } from "@blockforge/contracts";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db, DbOrTx } from "../db/client.js";
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
import { LOCKOUT_THRESHOLD, lockoutDurationMs, normalizeLoginKey, PhantomLockouts, SlidingWindowLimiter } from "./throttle.js";
import { uniqueUsername } from "../users/username.js";
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
  /** Per-email attempt limiter (covers unknown accounts too); 10 attempts / 15 min, keyed on the normalised address. */
  private readonly emailLimiter = new SlidingWindowLimiter(10, 15 * 60_000);
  /** Lockout counters for unknown addresses, so they behave exactly like real accounts. */
  private readonly phantom = new PhantomLockouts();

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
    input: { setupToken: string; email: string; username?: string | undefined; displayName: string; password: string },
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
      const username = input.username ?? (await uniqueUsername(tx, input.email));
      await tx.insert(users).values({ id: userId, email: input.email, username, displayName: input.displayName, passwordHash });
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

  /**
   * Password login. Unknown, wrong-password and disabled accounts give the same 401; locked real
   * accounts and "locked" unknown addresses give the same 429 (see `PhantomLockouts`). Failure
   * counters are incremented atomically, and the session is only created inside a transaction that
   * re-reads the user row under a lock and confirms the verified hash is still current, so a login
   * racing a password change, reset or disable can never mint a session the revocation missed.
   */
  async login(email: string, password: string, client: ClientInfo): Promise<LoginResult> {
    const now = this.clock.now();
    const key = normalizeLoginKey(email);
    const waitMs = this.emailLimiter.hit(key, now);
    if (waitMs > 0) {
      await this.auditLogin(key, null, client, "denied", { reason: "rate limited" });
      throw rateLimited(waitMs / 1000);
    }
    const [user] = await this.db.select().from(users).where(eq(users.email, key)).limit(1);
    const lockedMs = user ? Math.max(0, (user.lockedUntil?.getTime() ?? 0) - now) : this.phantom.lockedFor(key, now);
    if (lockedMs > 0) {
      await burnPasswordCheck(password);
      await this.auditLogin(key, user?.id ?? null, client, "denied", { reason: "account locked" });
      throw rateLimited(lockedMs / 1000);
    }
    const ok = user ? await verifyPassword(user.passwordHash, password) : (await burnPasswordCheck(password), false);
    if (!user || !ok || user.status !== "active") {
      if (!user) this.phantom.fail(key, now);
      else if (!ok) await this.recordFailure(user.id, now);
      await this.auditLogin(key, user?.id ?? null, client, "failed", {
        reason: !user ? "unknown account" : !ok ? "wrong password" : "account disabled",
      });
      throw unauthenticated("Invalid email or password");
    }
    const created = await withTransaction(this.db, async (tx) => {
      const [current] = await tx
        .select({ passwordHash: users.passwordHash, status: users.status, lockedUntil: users.lockedUntil, mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(eq(users.id, user.id))
        .for("update")
        .limit(1);
      if (!current || current.status !== "active" || current.passwordHash !== user.passwordHash) return null;
      if (current.lockedUntil && current.lockedUntil.getTime() > now) return { kind: "locked", ms: current.lockedUntil.getTime() - now } as const;
      await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(now) }).where(eq(users.id, user.id));
      const session = await this.sessions.create(user.id, { mfaVerified: !current.mfaEnabled, ip: client.ip, userAgent: client.userAgent }, tx);
      return { kind: "ok", session, mfaEnabled: current.mfaEnabled } as const;
    });
    if (!created) {
      await this.auditLogin(key, user.id, client, "failed", { reason: "credentials changed during login" });
      throw unauthenticated("Invalid email or password");
    }
    if (created.kind === "locked") {
      await this.auditLogin(key, user.id, client, "denied", { reason: "account locked" });
      throw rateLimited(created.ms / 1000);
    }
    this.emailLimiter.reset(key);
    await this.auditLogin(key, user.id, client, "success", { mfaRequired: created.mfaEnabled });
    return { status: created.mfaEnabled ? "mfa_required" : "ok", created: created.session };
  }

  /** Atomic `failed_login_count + 1`; sets (never shortens) the lock once the threshold is reached. */
  private async recordFailure(userId: string, now: number): Promise<void> {
    const [row] = await this.db
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
      .where(eq(users.id, userId))
      .returning({ failed: users.failedLoginCount });
    const failed = row?.failed ?? 0;
    const lockMs = lockoutDurationMs(failed);
    if (lockMs <= 0) return;
    const until = new Date(now + lockMs);
    await this.db
      .update(users)
      .set({ lockedUntil: until })
      .where(and(eq(users.id, userId), or(isNull(users.lockedUntil), lt(users.lockedUntil, until))));
    if (failed >= LOCKOUT_THRESHOLD) this.logger.warn({ userId, failed }, "account temporarily locked after failed logins");
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
      session: { mfaVerified: session.mfaVerified, expiresAt: session.expiresAt.getTime() },
      csrfToken: this.sessions.csrfTokenFor(session.tokenHash),
    };
  }

  // --- MFA -----------------------------------------------------------------------

  /**
   * Accepts a TOTP time step for a user exactly once: the conditional UPDATE only succeeds when the
   * step is newer than the last accepted one, so concurrent requests with the same code (or an older,
   * out-of-order code) cannot both pass.
   */
  private async consumeTimeStep(tx: DbOrTx, userId: string, step: number | undefined): Promise<boolean> {
    if (step === undefined) return false;
    const rows = await tx
      .update(users)
      .set({ mfaLastTimeStep: step })
      .where(and(eq(users.id, userId), or(isNull(users.mfaLastTimeStep), lt(users.mfaLastTimeStep, step))))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /**
   * Second factor for a session created by `login`. On success the pending session is consumed and
   * replaced by a new one (fresh token + CSRF token) so a token observed before verification cannot be
   * used after. The pending session must still exist when the replacement is created (a concurrent
   * password change or MFA reset revokes it).
   */
  async verifyMfa(session: SessionInfo, code: string, client: ClientInfo): Promise<CreatedSession | null> {
    if (session.mfaVerified) return null;
    const [user] = await this.db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
    if (!user?.mfaEnabled || !user.mfaTotpSecretEnc) {
      // MFA was disabled or reset after this session was created: the pending session is unusable.
      await this.sessions.revoke(session.id);
      throw unauthenticated("Sign in again");
    }
    const secret = this.box.decryptString(user.mfaTotpSecretEnc, mfaAad(user.id));
    const check = await verifyTotp(secret, code, this.clock.now(), user.mfaLastTimeStep);
    const actor: AuditActor = { actorType: "user", actorId: user.id, actorName: user.email, ip: client.ip, requestId: client.requestId };
    const result = check.valid
      ? await withTransaction(this.db, async (tx) => {
          const [locked] = await tx
            .select({ status: users.status, mfaEnabled: users.mfaEnabled })
            .from(users)
            .where(eq(users.id, user.id))
            .for("update");
          if (locked?.status !== "active" || !locked.mfaEnabled) return "gone" as const;
          if (!(await this.consumeTimeStep(tx, user.id, check.timeStep))) return "replay" as const;
          if (!(await this.sessions.consume(session.id, tx))) return "gone" as const;
          const created = await this.sessions.create(user.id, { mfaVerified: true, ip: client.ip, userAgent: client.userAgent }, tx);
          await this.audit.record({ ...actor, action: "auth.mfa.verify", targetType: "user", targetId: user.id, outcome: "success" }, tx);
          return created;
        })
      : ("invalid" as const);
    if (result === "gone") throw unauthenticated("Sign in again");
    if (typeof result === "string") {
      const failures = await this.sessions.recordMfaFailure(session.id);
      await this.audit.record({
        ...actor,
        action: "auth.mfa.verify",
        targetType: "user",
        targetId: user.id,
        outcome: "failed",
        details: { failures, reason: result === "replay" ? "code already used" : "invalid code" },
      });
      if (failures >= MFA_MAX_FAILURES || failures === 0) {
        await this.sessions.revoke(session.id);
        throw unauthenticated("Too many invalid codes; sign in again");
      }
      throw badRequest("Invalid verification code");
    }
    return result;
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
    const pending = user.mfaPendingSecretEnc;
    await withTransaction(this.db, async (tx) => {
      const updated = await tx
        .update(users)
        .set({
          mfaEnabled: true,
          mfaTotpSecretEnc: pending,
          mfaPendingSecretEnc: null,
          mfaLastTimeStep: check.timeStep ?? null,
          updatedAt: new Date(),
          version: sql`${users.version} + 1`,
        })
        .where(and(eq(users.id, user.id), eq(users.mfaEnabled, false), eq(users.mfaPendingSecretEnc, pending)))
        .returning({ id: users.id });
      if (updated.length === 0) throw conflict("Enrollment changed concurrently; start again");
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
    const done = await withTransaction(this.db, async (tx) => {
      if (!(await this.consumeTimeStep(tx, user.id, check.timeStep))) return false;
      await tx
        .update(users)
        .set({
          mfaEnabled: false,
          mfaTotpSecretEnc: null,
          mfaPendingSecretEnc: null,
          mfaLastTimeStep: null,
          updatedAt: new Date(),
          version: sql`${users.version} + 1`,
        })
        .where(eq(users.id, user.id));
      // Sessions still waiting for a second factor must not become fully authenticated now.
      await this.sessions.revokeUnverified(user.id, tx);
      await this.audit.record({ ...actor, action: "auth.mfa.disable", targetType: "user", targetId: user.id, outcome: "success" }, tx);
      return true;
    });
    if (!done) {
      await this.audit.record({
        ...actor,
        action: "auth.mfa.disable",
        targetType: "user",
        targetId: user.id,
        outcome: "failed",
        details: { reason: "code already used" },
      });
      throw badRequest("Invalid verification code");
    }
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
      const updated = await tx
        .update(users)
        .set({ passwordHash, passwordChangedAt: new Date(this.clock.now()), updatedAt: new Date(), version: sql`${users.version} + 1` })
        .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)))
        .returning({ id: users.id });
      if (updated.length === 0) throw conflict("The password was changed concurrently; try again");
      await this.sessions.revokeOthers(user.id, session.id, tx);
      await this.audit.record({ ...actor, action: "auth.password.change", targetType: "user", targetId: user.id, outcome: "success" }, tx);
    });
  }
}
