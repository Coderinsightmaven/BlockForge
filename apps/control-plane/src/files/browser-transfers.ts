import type { Clock } from "../lib/clock.js";
import { randomToken } from "../lib/crypto.js";

export const BROWSER_TRANSFER_TTL_MS = 5 * 60_000;
const MAX_PENDING = 10_000;

export interface BrowserTransfer {
  direction: "upload" | "download";
  sessionId: string;
  userId: string;
  serverId: string;
  nodeId: string;
  path: string;
  /** Upload: declared size (also the byte limit). Download: the file size limit. */
  maxBytes: number;
  /** Set for backup downloads (`backup.transfer.push` instead of a file). */
  backupId?: string;
  expiresAt: number;
}

/**
 * Single-use, 5-minute, session-bound tokens for `PUT|GET /api/v1/transfers/:token`. Tokens are
 * random (256 bit) and only valid for the session that requested them. In memory: a control-plane
 * restart invalidates outstanding URLs (they are short-lived by design).
 */
export class BrowserTransfers {
  private readonly pending = new Map<string, BrowserTransfer>();

  constructor(private readonly clock: Clock) {}

  issue(t: Omit<BrowserTransfer, "expiresAt">): { token: string; expiresAt: number } {
    this.prune();
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const token = randomToken(32);
    const expiresAt = this.clock.now() + BROWSER_TRANSFER_TTL_MS;
    this.pending.set(token, { ...t, expiresAt });
    return { token, expiresAt };
  }

  /** Consumes a token (single use). Returns null when unknown, expired, of the wrong direction or session. */
  consume(token: string, sessionId: string, direction: BrowserTransfer["direction"]): BrowserTransfer | null {
    const t = this.pending.get(token);
    if (!t) return null;
    if (t.sessionId !== sessionId || t.direction !== direction) return null;
    this.pending.delete(token);
    return t.expiresAt > this.clock.now() ? t : null;
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [k, t] of this.pending) if (t.expiresAt <= now) this.pending.delete(k);
  }
}
