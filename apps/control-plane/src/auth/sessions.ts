import { randomUUID } from "node:crypto";
import { and, eq, lt, ne, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db, DbOrTx } from "../db/client.js";
import { sessions, users } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import { b64url, hmacSha256, randomToken, safeEqual, sha256Hex } from "../lib/crypto.js";
import type { SessionInfo } from "../http/types.js";

export const SESSION_IDLE_MS = 12 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
/** last_seen_at is only rewritten when older than this, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60_000;

export interface CreatedSession {
  token: string;
  csrfToken: string;
  session: SessionInfo;
}

/**
 * Opaque server-side sessions. The cookie carries a random token; the database stores only its
 * sha256. The CSRF token is HMAC(csrfKey, tokenHash), so it is bound to the session, can be
 * re-derived for `/auth/me` without being stored in plaintext, and is useless without the cookie.
 */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly csrfKey: Buffer,
    private readonly logger: Logger,
  ) {}

  csrfTokenFor(tokenHash: string): string {
    return b64url(hmacSha256(this.csrfKey, `csrf:${tokenHash}`));
  }

  async create(
    userId: string,
    opts: { mfaVerified: boolean; ip: string | null; userAgent: string | null },
    tx: DbOrTx = this.db,
  ): Promise<CreatedSession> {
    const token = randomToken(32);
    const tokenHash = sha256Hex(token);
    const csrfToken = this.csrfTokenFor(tokenHash);
    const now = new Date(this.clock.now());
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
    const id = randomUUID();
    await tx.insert(sessions).values({
      id,
      userId,
      tokenHash,
      csrfTokenHash: sha256Hex(csrfToken),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      ip: opts.ip,
      userAgent: opts.userAgent?.slice(0, 512) ?? null,
      mfaVerified: opts.mfaVerified,
    });
    const [user] = await tx
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
        mfaEnabled: users.mfaEnabled,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new Error("session user vanished");
    return {
      token,
      csrfToken,
      session: { id, tokenHash, csrfTokenHash: sha256Hex(csrfToken), createdAt: now, lastSeenAt: now, expiresAt, mfaVerified: opts.mfaVerified, user },
    };
  }

  /** Resolves a cookie token to a live session (absolute + idle expiry, active user), touching last_seen_at. */
  async lookup(token: string): Promise<SessionInfo | null> {
    if (!token || token.length > 128) return null;
    const tokenHash = sha256Hex(token);
    const [row] = await this.db
      .select({
        id: sessions.id,
        tokenHash: sessions.tokenHash,
        csrfTokenHash: sessions.csrfTokenHash,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        mfaVerified: sessions.mfaVerified,
        user: {
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          status: users.status,
          mfaEnabled: users.mfaEnabled,
        },
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    const now = this.clock.now();
    if (row.expiresAt.getTime() <= now || row.lastSeenAt.getTime() + SESSION_IDLE_MS <= now || row.user.status !== "active") {
      await this.db.delete(sessions).where(eq(sessions.id, row.id));
      return null;
    }
    if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const seen = new Date(now);
      row.lastSeenAt = seen;
      await this.db.update(sessions).set({ lastSeenAt: seen }).where(eq(sessions.id, row.id));
    }
    return row;
  }

  /** Constant-time check of the `x-blockforge-csrf` header against the token hash stored on the session. */
  verifyCsrf(session: SessionInfo, header: string | undefined): boolean {
    if (!header || header.length > 256) return false;
    return safeEqual(sha256Hex(header), session.csrfTokenHash);
  }

  async markMfaVerified(sessionId: string, tx: DbOrTx = this.db): Promise<void> {
    await tx.update(sessions).set({ mfaVerified: true, mfaFailedAttempts: 0 }).where(eq(sessions.id, sessionId));
  }

  /** Increments failed MFA attempts; returns the new count. */
  async recordMfaFailure(sessionId: string): Promise<number> {
    const [row] = await this.db.select({ n: sessions.mfaFailedAttempts }).from(sessions).where(eq(sessions.id, sessionId));
    const n = (row?.n ?? 0) + 1;
    await this.db.update(sessions).set({ mfaFailedAttempts: n }).where(eq(sessions.id, sessionId));
    return n;
  }

  async revoke(sessionId: string, tx: DbOrTx = this.db): Promise<void> {
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async revokeAllForUser(userId: string, tx: DbOrTx = this.db): Promise<void> {
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  }

  async revokeOthers(userId: string, keepSessionId: string, tx: DbOrTx = this.db): Promise<void> {
    await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
  }

  /** Other sessions of a user must re-verify MFA (after MFA was enabled). */
  async requireMfaOnOthers(userId: string, keepSessionId: string, tx: DbOrTx = this.db): Promise<void> {
    await tx
      .update(sessions)
      .set({ mfaVerified: false })
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
  }

  async pruneExpired(): Promise<void> {
    const now = this.clock.now();
    await this.db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, new Date(now)), lt(sessions.lastSeenAt, new Date(now - SESSION_IDLE_MS))));
    this.logger.debug("expired sessions pruned");
  }
}
