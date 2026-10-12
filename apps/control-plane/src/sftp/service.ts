import { SFTP_USERNAME_PATTERN, type SftpActivityEvent, type SftpAuthRequest, type SftpAuthResponse } from "@blockforge/contracts";
import type { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { parseAuthorizedKey } from "../account/ssh-keys.js";
import type { AuditService } from "../audit/service.js";
import { burnPasswordCheck, verifyPassword } from "../auth/passwords.js";
import { normalizeLoginKey, SlidingWindowLimiter } from "../auth/throttle.js";
import type { Db } from "../db/client.js";
import { networkMembers, servers, serverSubusers, templates, users, userSshKeys } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import { safeEqual } from "../lib/crypto.js";
import { AppError, rateLimited } from "../lib/errors.js";
import type { RbacService } from "../rbac/service.js";
import { effectiveServerPermissions } from "../servers/permissions.js";

/** SFTP sessions re-authenticate after this long. */
export const SFTP_SESSION_TTL_MS = 15 * 60_000;

const deny = () => new AppError(401, "UNAUTHENTICATED", "SFTP authentication failed");

/**
 * `POST /agent/v1/sftp/auth`: the agent's SFTP server has no local credential store; every login
 * (`<username>.<serverShortId>` + password or public key) is decided here. The server must live on
 * the calling node; the user must be active and hold `servers.files.sftp` plus read and/or write
 * file permissions; suspended servers refuse everyone; users with MFA may only use SSH keys.
 * Failed attempts are rate-limited per (client IP, username) and all attempts per node; every
 * outcome is audited.
 */
export class SftpService {
  private readonly perLogin = new SlidingWindowLimiter(10, 5 * 60_000);
  private readonly perNode = new SlidingWindowLimiter(300, 60_000);

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async authenticate(nodeId: string, req: SftpAuthRequest): Promise<SftpAuthResponse> {
    const now = this.clock.now();
    // Failures count per (client IP, username) — clients open parallel sessions and re-authenticate,
    // so successful logins must not use up the budget; every attempt counts against the node.
    const loginKey = `${req.clientIp}|${normalizeLoginKey(req.username)}`;
    const wait = Math.max(this.perLogin.wait(loginKey, now), this.perNode.hit(nodeId, now));
    if (wait > 0) {
      await this.fail(req, null, null, "rate limited");
      throw rateLimited(wait / 1000);
    }
    // Shape check before any database lookup.
    const wellFormed = SFTP_USERNAME_PATTERN.test(req.username);
    const dot = req.username.lastIndexOf(".");
    const username = wellFormed ? req.username.slice(0, dot) : "";
    const short = wellFormed ? req.username.slice(dot + 1) : "";
    const [user] = wellFormed ? await this.db.select().from(users).where(eq(users.username, username)).limit(1) : [];
    const candidates = user
      ? await this.db
          .select({ server: servers, networkId: networkMembers.networkId, subPerms: serverSubusers.permissions, denylist: templates.fileDenylist })
          .from(servers)
          .innerJoin(templates, eq(templates.id, servers.templateId))
          .leftJoin(networkMembers, eq(networkMembers.serverId, servers.id))
          .leftJoin(serverSubusers, and(eq(serverSubusers.serverId, servers.id), eq(serverSubusers.userId, user.id)))
          .where(and(eq(servers.nodeId, nodeId), sql`substring(replace(${servers.id}::text, '-', ''), 1, 8) = ${short}`))
          .limit(2)
      : [];
    const target = candidates.length === 1 ? candidates[0]! : null;

    // Credentials are checked before policy so timing does not reveal which part failed.
    const credentialsOk = await this.checkCredentials(req, user ?? null);
    if (!user || !target) return this.reject(req, user?.id ?? null, null, "unknown user or server");
    if (!credentialsOk.ok) return this.reject(req, user.id, target.server.id, credentialsOk.reason);
    if (user.status !== "active") return this.reject(req, user.id, target.server.id, "account disabled");
    if (target.server.suspended) return this.reject(req, user.id, target.server.id, "server suspended");
    const principal = await this.rbac.loadPrincipal(user.id);
    if (!principal) return this.reject(req, user.id, target.server.id, "unknown user");
    const perms = effectiveServerPermissions(principal, {
      resource: { type: "server", id: target.server.id, nodeId: target.server.nodeId, networkId: target.networkId ?? null },
      ownerId: target.server.ownerId,
      suspended: target.server.suspended,
      subuserPermissions: target.subPerms ?? null,
    });
    const granted: ("read" | "write")[] = [];
    if (perms.has("servers.files.read")) granted.push("read");
    if (perms.has("servers.files.write")) granted.push("write");
    if (!perms.has("servers.files.sftp") || granted.length === 0) return this.reject(req, user.id, target.server.id, "missing SFTP permission");
    if (credentialsOk.keyId) await this.db.update(userSshKeys).set({ lastUsedAt: new Date(now) }).where(eq(userSshKeys.id, credentialsOk.keyId));
    await this.audit.record({
      actorType: "user",
      actorId: user.id,
      actorName: user.username,
      ip: req.clientIp,
      action: "server.sftp.login",
      targetType: "server",
      targetId: target.server.id,
      outcome: "success",
      details: { method: req.method, sessionId: req.sessionId, nodeId, permissions: granted },
    });
    return {
      workloadId: target.server.id,
      userId: user.id,
      permissions: granted,
      denylist: perms.has("servers.admin") ? [] : target.denylist,
      expiresAt: now + SFTP_SESSION_TTL_MS,
    };
  }

  private async checkCredentials(req: SftpAuthRequest, user: typeof users.$inferSelect | null): Promise<{ ok: boolean; reason: string; keyId?: string }> {
    if (req.method === "password") {
      if (!user) {
        await burnPasswordCheck(req.password);
        return { ok: false, reason: "unknown user" };
      }
      if (user.mfaEnabled) {
        await burnPasswordCheck(req.password);
        return { ok: false, reason: "password login refused for an MFA account (use an SSH key)" };
      }
      return (await verifyPassword(user.passwordHash, req.password)) ? { ok: true, reason: "" } : { ok: false, reason: "wrong password" };
    }
    let parsed;
    try {
      parsed = parseAuthorizedKey(req.publicKey);
    } catch {
      return { ok: false, reason: "unsupported or malformed key" };
    }
    if (!user) return { ok: false, reason: "unknown user" };
    const [key] = await this.db
      .select()
      .from(userSshKeys)
      .where(and(eq(userSshKeys.userId, user.id), eq(userSshKeys.fingerprint, parsed.fingerprint)))
      .limit(1);
    if (!key || !safeEqual(key.publicKey, parsed.publicKey)) return { ok: false, reason: "unknown key" };
    return { ok: true, reason: "", keyId: key.id };
  }

  private async fail(req: SftpAuthRequest, userId: string | null, serverId: string | null, reason: string): Promise<void> {
    await this.audit.record({
      actorType: "user",
      actorId: userId,
      actorName: req.username.slice(0, 128),
      ip: req.clientIp,
      action: "server.sftp.login",
      targetType: serverId ? "server" : null,
      targetId: serverId,
      outcome: "failed",
      details: { method: req.method, reason, sessionId: req.sessionId },
    });
  }

  private async reject(req: SftpAuthRequest, userId: string | null, serverId: string | null, reason: string): Promise<never> {
    this.perLogin.hit(`${req.clientIp}|${normalizeLoginKey(req.username)}`, this.clock.now());
    await this.fail(req, userId, serverId, reason);
    throw deny();
  }

  /** `sftp.activity` from the agent → per-action audit records on the server's activity log. */
  async recordActivity(nodeId: string, ev: z.infer<typeof SftpActivityEvent>): Promise<void> {
    const [user] = await this.db.select({ username: users.username }).from(users).where(eq(users.id, ev.userId)).limit(1);
    for (const a of ev.actions) {
      await this.audit.record({
        actorType: "user",
        actorId: ev.userId,
        actorName: user?.username ?? null,
        ip: ev.clientIp,
        action: `server.sftp.${a.action}`,
        targetType: "server",
        targetId: ev.workloadId,
        outcome: "success",
        details: { path: a.path, ...(a.to ? { to: a.to } : {}), sessionId: ev.sessionId, nodeId, at: a.ts },
      });
    }
    this.logger.debug({ nodeId, n: ev.actions.length }, "sftp activity recorded");
  }
}
