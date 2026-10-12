import { randomBytes, randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { ALL_PERMISSIONS, API_KEY_FORBIDDEN_PERMISSIONS, API_KEY_PATTERN, SERVER_OWNER_PERMISSIONS, type ApiKey, type Permission } from "@blockforge/contracts";
import { and, asc, count, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { SlidingWindowLimiter } from "../auth/throttle.js";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { apiTokens, servers, serverSubusers, users } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import { safeEqual, sha256Hex } from "../lib/crypto.js";
import { AppError, badRequest, conflict, notFound, rateLimited, unauthenticated, validationDetails } from "../lib/errors.js";
import { capPrincipal, type Principal } from "../rbac/authorize.js";
import type { RbacService } from "../rbac/service.js";

const FORBIDDEN = new Set<string>(API_KEY_FORBIDDEN_PERMISSIONS);
const MAX_KEYS_PER_USER = 50;
/** `lastUsedAt/Ip` are written at most this often per key (unless the IP changes). */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

type Row = typeof apiTokens.$inferSelect;

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is matched as IPv4. */
function normaliseIp(ip: string): { address: string; family: "ipv4" | "ipv6" } | null {
  const v = ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const fam = isIP(v);
  return fam === 4 ? { address: v, family: "ipv4" } : fam === 6 ? { address: v, family: "ipv6" } : null;
}

/** Parses `ip` or `ip/prefix` into a BlockList entry; null if malformed. */
function addCidr(list: BlockList, entry: string): boolean {
  const [addr = "", bits] = entry.split("/");
  const n = normaliseIp(addr);
  if (!n) return false;
  const max = n.family === "ipv4" ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return false;
  list.addSubnet(n.address, prefix, n.family);
  return true;
}

export function ipAllowed(ip: string, allowed: readonly string[]): boolean {
  if (!allowed.length) return true;
  const n = normaliseIp(ip);
  if (!n) return false;
  const list = new BlockList();
  for (const a of allowed) addCidr(list, a);
  return list.check(n.address, n.family);
}

/**
 * Personal API keys: `bfk_<16 hex id>_<43 char secret>`. Only sha256(secret) is stored; lookup by the
 * public prefix, constant-time comparison. Each request re-evaluates the owner's current permissions
 * (∩ the key's permissions − API_KEY_FORBIDDEN_PERMISSIONS), the expiry and the IP allowlist, and is
 * rate-limited per key.
 */
export class ApiKeysService {
  private readonly limiter: SlidingWindowLimiter;
  private readonly lastWrite = new Map<string, { at: number; ip: string }>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    rateLimitPerMin: number,
  ) {
    this.limiter = new SlidingWindowLimiter(rateLimitPerMin, 60_000);
  }

  private dto(r: Row): ApiKey {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      permissions: (r.permissions as Permission[] | null) ?? null,
      allowedIps: r.allowedIps,
      expiresAt: r.expiresAt?.getTime() ?? null,
      lastUsedAt: r.lastUsedAt?.getTime() ?? null,
      lastUsedIp: r.lastUsedIp,
      createdAt: r.createdAt.getTime(),
    };
  }

  async list(userId: string): Promise<ApiKey[]> {
    const rows = await this.db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(asc(apiTokens.createdAt));
    return rows.map((r) => this.dto(r));
  }

  async create(
    userId: string,
    input: { name: string; permissions: Permission[] | null; allowedIps: string[]; expiresInDays: number | null },
    actor: AuditActor,
  ): Promise<{ key: ApiKey; secret: string }> {
    const forbidden = (input.permissions ?? []).filter((p) => FORBIDDEN.has(p));
    if (forbidden.length) throw badRequest(`API keys cannot hold ${forbidden.join(", ")}`, validationDetails("not allowed for API keys", "permissions"));
    if (input.permissions) {
      const held = await this.heldAnywhere(userId);
      const notHeld = input.permissions.filter((p) => !held.has(p));
      if (notHeld.length) throw badRequest(`Your account does not hold ${notHeld.join(", ")}`, validationDetails("not held by the account", "permissions"));
    }
    const badIps = input.allowedIps.filter((a) => !addCidr(new BlockList(), a));
    if (badIps.length) throw badRequest("Invalid IP or CIDR", validationDetails(`invalid: ${badIps.join(", ")}`, "allowedIps"));
    const [n] = await this.db.select({ n: count() }).from(apiTokens).where(eq(apiTokens.userId, userId));
    if (Number(n?.n ?? 0) >= MAX_KEYS_PER_USER) throw conflict(`At most ${MAX_KEYS_PER_USER} API keys per account`);
    const publicId = randomBytes(8).toString("hex");
    const secretPart = randomBytes(32).toString("base64url");
    const secret = `bfk_${publicId}_${secretPart}`;
    const now = this.clock.now();
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        id: randomUUID(),
        userId,
        name: input.name,
        tokenHash: sha256Hex(secretPart),
        prefix: `bfk_${publicId}`,
        permissions: input.permissions ? [...new Set(input.permissions)].sort() : null,
        allowedIps: input.allowedIps,
        expiresAt: input.expiresInDays ? new Date(now + input.expiresInDays * 86_400_000) : null,
        createdAt: new Date(now),
      })
      .returning();
    const key = this.dto(row!);
    await this.audit.record({
      ...actor,
      action: "account.api_key.create",
      targetType: "api_token",
      targetId: key.id,
      outcome: "success",
      details: { name: key.name, prefix: key.prefix, permissions: key.permissions, allowedIps: key.allowedIps, expiresAt: key.expiresAt },
    });
    return { key, secret };
  }

  /**
   * Permissions the user holds anywhere: role grants at any scope, the owner set when they own a
   * server, and every subuser grant (identity.ts: what a key may list at creation).
   */
  private async heldAnywhere(userId: string): Promise<Set<string>> {
    const principal = await this.rbac.loadPrincipal(userId);
    const held = new Set<string>();
    for (const g of principal?.grants ?? []) for (const p of g.permissions) held.add(p);
    const [owned] = await this.db.select({ n: count() }).from(servers).where(eq(servers.ownerId, userId));
    if (Number(owned?.n ?? 0) > 0) for (const p of SERVER_OWNER_PERMISSIONS) held.add(p);
    for (const s of await this.db.select({ permissions: serverSubusers.permissions }).from(serverSubusers).where(eq(serverSubusers.userId, userId))) {
      for (const p of s.permissions) held.add(p);
    }
    return held;
  }

  async remove(userId: string, id: string, actor: AuditActor): Promise<void> {
    const deleted = await this.db.delete(apiTokens).where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId))).returning({ prefix: apiTokens.prefix });
    if (!deleted.length) throw notFound("API key");
    this.lastWrite.delete(id);
    await this.audit.record({ ...actor, action: "account.api_key.revoke", targetType: "api_token", targetId: id, outcome: "success", details: { prefix: deleted[0]!.prefix } });
  }

  /** Resolves `Authorization: Bearer bfk_…` to the capped principal of the key owner. */
  async authenticate(header: string, ip: string): Promise<Principal> {
    const token = header.replace(/^Bearer\s+/i, "").trim();
    const m = API_KEY_PATTERN.exec(token);
    if (!m) throw unauthenticated("Invalid API key");
    const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.prefix, `bfk_${m[1]}`)).limit(1);
    // Constant-time comparison of the secret hash (also computed for unknown prefixes).
    const presented = sha256Hex(m[2]!);
    const ok = safeEqual(presented, row?.tokenHash ?? "0".repeat(64));
    if (!row || !ok) throw unauthenticated("Invalid API key");
    const now = this.clock.now();
    if (row.expiresAt && row.expiresAt.getTime() <= now) throw unauthenticated("The API key has expired");
    if (!ipAllowed(ip, row.allowedIps)) throw new AppError(403, "FORBIDDEN", "The API key is not allowed from this address");
    const wait = this.limiter.hit(row.id, now);
    if (wait > 0) throw rateLimited(wait / 1000);
    const [owner] = await this.db.select({ status: users.status }).from(users).where(eq(users.id, row.userId)).limit(1);
    if (!owner || owner.status !== "active") throw unauthenticated("Invalid API key");
    const principal = await this.rbac.loadPrincipal(row.userId);
    if (!principal) throw unauthenticated("Invalid API key");
    const allowed = (row.permissions as Permission[] | null) ?? ALL_PERMISSIONS;
    const cap = new Set<Permission>(allowed.filter((p) => !FORBIDDEN.has(p)));
    void this.touch(row.id, ip, now);
    return capPrincipal(principal, { id: row.id, prefix: row.prefix }, cap);
  }

  private async touch(id: string, ip: string, now: number): Promise<void> {
    const last = this.lastWrite.get(id);
    if (last && last.ip === ip && now - last.at < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastWrite.set(id, { at: now, ip });
    if (this.lastWrite.size > 10_000) {
      const oldest = this.lastWrite.keys().next().value;
      if (oldest !== undefined) this.lastWrite.delete(oldest);
    }
    await this.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(now), lastUsedIp: ip })
      .where(eq(apiTokens.id, id))
      .catch((err: unknown) => this.logger.warn({ err }, "api key last-used update failed"));
  }
}
