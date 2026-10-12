/**
 * In-memory sliding-window limiter keyed by an arbitrary string (e.g. the login email), used in
 * addition to the per-IP route rate limit so distributed guessing against one account is slowed
 * even for accounts that do not exist. Bounded: the oldest keys are evicted beyond `maxKeys`.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Records an attempt; returns 0 if allowed, otherwise the milliseconds until the next slot frees. */
  hit(key: string, now: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return (list[0] ?? now) + this.windowMs - now;
    }
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return 0;
  }

  /** Milliseconds until `key` may try again (0 = allowed), without recording an attempt. */
  wait(key: string, now: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    return list.length >= this.max ? (list[0] ?? now) + this.windowMs - now : 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

/** Progressive account lockout: after `LOCKOUT_THRESHOLD` consecutive failures, 1 min doubling to 1 h. */
export const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 60_000;
const LOCKOUT_MAX_MS = 60 * 60_000;

export function lockoutDurationMs(failedCount: number): number {
  if (failedCount < LOCKOUT_THRESHOLD) return 0;
  return Math.min(LOCKOUT_MAX_MS, LOCKOUT_BASE_MS * 2 ** (failedCount - LOCKOUT_THRESHOLD));
}

/** Canonical form of a login identifier for limiter/lockout keys (Unicode-normalised, trimmed, lowercase). */
export function normalizeLoginKey(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

/**
 * Lockout bookkeeping for login attempts against accounts that do not exist. It mirrors the
 * database counters of real accounts, so a locked real account and a "locked" unknown address
 * produce the same response and nobody can probe which addresses are registered. Bounded LRU.
 */
export class PhantomLockouts {
  private readonly entries = new Map<string, { failed: number; lockedUntil: number }>();

  constructor(private readonly maxKeys = 50_000) {}

  /** Remaining lock time for the key (0 when not locked). */
  lockedFor(key: string, now: number): number {
    const e = this.entries.get(key);
    return e && e.lockedUntil > now ? e.lockedUntil - now : 0;
  }

  /** Counts a failure; returns the new failure count. */
  fail(key: string, now: number): number {
    const e = this.entries.get(key) ?? { failed: 0, lockedUntil: 0 };
    e.failed++;
    const lockMs = lockoutDurationMs(e.failed);
    if (lockMs > 0) e.lockedUntil = Math.max(e.lockedUntil, now + lockMs);
    this.entries.delete(key);
    this.entries.set(key, e);
    if (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return e.failed;
  }
}
