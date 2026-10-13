import { z } from "zod";
import { CatalogError } from "../errors.js";
import { getText, parseJson, type CatalogContext } from "../http.js";
import { assertPlayerName, normalizeUuid, offlinePlayerUuid } from "./uuid.js";

/** Mojang profile API (verified live 2026-10-12: 200 `{id, name}`, 404 `{path, errorMessage}`, names case-insensitive). */
export const MOJANG_PROFILE_API = "https://api.mojang.com/users/profiles/minecraft/";
export const MOJANG_PROFILE_HOSTS: readonly string[] = ["api.mojang.com"];

const ProfileSchema = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), name: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) });

export interface PlayerProfile {
  /** Dashed lowercase UUID. */
  uuid: string;
  /** Name with Mojang's capitalisation. */
  name: string;
  source: "mojang" | "offline";
}

/** Back-off after a 429 without a usable `Retry-After`. */
export const MOJANG_DEFAULT_RETRY_AFTER_MS = 60_000;
/** Longest back-off a `Retry-After` may impose (larger values are clamped). */
export const MOJANG_MAX_RETRY_AFTER_MS = 15 * 60_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * An RFC 9110 HTTP-date (IMF-fixdate, obsolete RFC 850 or asctime form, all UTC) as epoch ms, or
 * null. Parsed by hand: `Date.parse` reads the asctime form as local time. A two-digit RFC 850
 * year more than 50 years in the future means the previous century (RFC 9110 §5.6.7).
 */
export function parseHttpDate(value: string, nowMs: number): number | null {
  let day: string, mon: string, year: number, hh: string, mm: string, ss: string;
  let m = IMF_FIXDATE.exec(value);
  if (m) [day, mon, year, hh, mm, ss] = [m[1]!, m[2]!, Number(m[3]), m[4]!, m[5]!, m[6]!];
  else if ((m = RFC850_DATE.exec(value))) {
    [day, mon, hh, mm, ss] = [m[1]!, m[2]!, m[4]!, m[5]!, m[6]!];
    const thisYear = new Date(nowMs).getUTCFullYear();
    year = 2000 + Number(m[3]);
    while (year > thisYear + 50) year -= 100;
  } else if ((m = ASCTIME_DATE.exec(value))) [mon, day, hh, mm, ss, year] = [m[1]!, m[2]!.trim(), m[3]!, m[4]!, m[5]!, Number(m[6])];
  else return null;
  const month = MONTHS.indexOf(mon);
  const [d, h, mi, s] = [Number(day), Number(hh), Number(mm), Number(ss)];
  if (month < 0 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const at = Date.UTC(year, month, d, h, mi, Math.min(s, 59));
  // Reject dates that roll over (31 Feb → 3 Mar).
  return new Date(at).getUTCDate() === d ? at : null;
}

const DAY_NAME = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i;

function retryAfterElement(v: string, nowMs: number, maxMs: number): number | null {
  let ms: number;
  const secs = /^(\d+)(?:\.\d{1,9})?$/.exec(v);
  if (secs) ms = secs[1]!.length > 10 ? maxMs : Math.ceil(Number(v)) * 1000;
  else {
    const at = parseHttpDate(v, nowMs);
    if (at === null) return null;
    ms = at - nowMs;
  }
  return Math.min(Math.max(ms, 1000), maxMs);
}

/**
 * Parses a `Retry-After` header (RFC 9110 §10.2.3: delay-seconds or an HTTP-date) into milliseconds
 * from `nowMs`, clamped to `[1 s, maxMs]`. Non-negative decimal seconds are accepted leniently and
 * rounded up; more than 10 digits clamp to `maxMs`. A signed value (`+120`, `-5`) is not
 * delay-seconds and is rejected. Repeated headers joined with commas (`120, 30`; HTTP-dates contain a
 * comma themselves) yield the longest valid element. Absent or malformed values → null (callers fall
 * back to `MOJANG_DEFAULT_RETRY_AFTER_MS`); a date in the past → 1 s.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number, maxMs = MOJANG_MAX_RETRY_AFTER_MS): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === "") return null;
  const whole = retryAfterElement(v, nowMs, maxMs);
  if (whole !== null || !v.includes(",")) return whole;
  // Re-join "<weekday>, <rest>" of HTTP-dates while splitting the list: only after a day name, and only
  // when the joined text is a valid date; otherwise every piece is evaluated on its own.
  const parts = v.split(",").map((p) => p.trim());
  let best: number | null = null;
  for (let i = 0; i < parts.length; i++) {
    let ms: number | null = null;
    if (DAY_NAME.test(parts[i]!) && i + 1 < parts.length) {
      ms = retryAfterElement(`${parts[i]!}, ${parts[i + 1]!}`, nowMs, maxMs);
      if (ms !== null) i++;
    }
    if (ms === null && parts[i] !== "") ms = retryAfterElement(parts[i]!, nowMs, maxMs);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best;
}

export interface MojangRateLimiterOptions {
  /** Requests allowed per `windowMs` (Mojang allows roughly 600 per 10 minutes per IP). Default 600. */
  maxRequests?: number;
  /** Default 10 minutes. */
  windowMs?: number;
  /** Longest wait `acquire` performs; a longer one throws `RATE_LIMITED` instead. Default 2 000 ms. */
  maxWaitMs?: number;
  /** Upper bound for a `Retry-After` back-off. Default 15 minutes. */
  maxRetryAfterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Client-side limiter for the Mojang profile API, shared by every caller in a process (the limit is
 * per IP). Callers are serialised: `acquire` counts each request in a sliding window of
 * `maxRequests` per `windowMs` and, after a 429, refuses until the server's `Retry-After` has
 * passed. While quota remains a request is always sent (at most `maxWaitMs` later); `RATE_LIMITED`
 * with `retryAfterMs` is thrown only when the next slot is further away than `maxWaitMs`.
 */
export class MojangRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Send times inside the current window (oldest first). */
  private readonly sent: number[] = [];
  private blockedUntil = 0;
  /** Serialises `acquire`: one caller at a time holds the permit, including across its sleep. */
  private gate: Promise<void> = Promise.resolve();

  constructor(opts: MojangRateLimiterOptions = {}) {
    this.maxRequests = Math.max(1, opts.maxRequests ?? 600);
    this.windowMs = Math.max(1, opts.windowMs ?? 10 * 60_000);
    this.maxWaitMs = Math.max(0, opts.maxWaitMs ?? 2_000);
    this.maxRetryAfterMs = Math.max(1000, opts.maxRetryAfterMs ?? MOJANG_MAX_RETRY_AFTER_MS);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Milliseconds until requests are allowed again after a 429 (0 = not blocked). */
  get blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  private prune(t: number): void {
    while (this.sent.length > 0 && this.sent[0]! <= t - this.windowMs) this.sent.shift();
  }

  /** Waits for a permit (see the class comment). */
  async acquire(url: string): Promise<void> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      // Re-check after every sleep: a 429 recorded meanwhile (another caller's response, `rateLimited`)
      // extends the block, and the window may not have advanced as far as planned.
      for (;;) {
        const t = this.now();
        const blocked = this.blockedUntil - t;
        if (blocked > 0) {
          if (blocked > this.maxWaitMs) throw new CatalogError("RATE_LIMITED", "Mojang profile API rate limit reached", { url, status: 429, retryAfterMs: blocked });
          await this.sleep(blocked);
          continue;
        }
        this.prune(t);
        if (this.sent.length >= this.maxRequests) {
          const wait = this.sent[0]! + this.windowMs - t;
          if (wait > this.maxWaitMs) throw new CatalogError("RATE_LIMITED", "Mojang profile API request budget used up", { url, retryAfterMs: wait });
          await this.sleep(wait);
          continue;
        }
        this.sent.push(t);
        return;
      }
    } finally {
      release();
    }
  }

  /**
   * Records a 429: no request is sent until `Retry-After` (seconds or HTTP-date, clamped to
   * `maxRetryAfterMs`; 60 s when absent or invalid) has passed. Returns the effective remaining
   * block in ms (an earlier, longer block is kept).
   */
  rateLimited(retryAfter: string | null): number {
    const now = this.now();
    const ms = parseRetryAfter(retryAfter, now, this.maxRetryAfterMs) ?? MOJANG_DEFAULT_RETRY_AFTER_MS;
    this.blockedUntil = Math.max(this.blockedUntil, now + ms);
    return this.blockedUntil - now;
  }
}

export interface MojangLookupOptions {
  /** Shared limiter (one per process). Without one, 429s still honour `Retry-After`. */
  limiter?: MojangRateLimiter;
  /** Clock for `Retry-After` HTTP-dates when no limiter is given (default `Date.now`). */
  now?: () => number;
}

/**
 * Looks up an online-mode (Mojang/Microsoft account) player by name. Returns null when no account
 * has that name. Requests only go to `api.mojang.com` (overridable via `ctx.metadataHosts`), with
 * the usual redirect/size checks; every request that reaches the network (cache hits do not) takes
 * a permit from `opts.limiter`. HTTP 429 becomes `RATE_LIMITED` with `retryAfterMs` from the
 * response's `Retry-After` (clamped; 60 s when absent or invalid). Cache results via `ctx.cache`.
 */
export async function lookupMojangProfile(ctx: CatalogContext, name: string, opts: MojangLookupOptions = {}): Promise<PlayerProfile | null> {
  const url = MOJANG_PROFILE_API + encodeURIComponent(assertPlayerName(name));
  let retryAfter: string | null = null;
  const fetch: CatalogContext["fetch"] = async (input, init) => {
    if (opts.limiter) await opts.limiter.acquire(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const res = await ctx.fetch(input, init);
    if (res.status === 429) retryAfter = res.headers.get("retry-after");
    return res;
  };
  const scoped: CatalogContext = { ...ctx, fetch, metadataHosts: ctx.metadataHosts ?? MOJANG_PROFILE_HOSTS };
  let text: string;
  try {
    text = await getText(scoped, url);
  } catch (err) {
    if (err instanceof CatalogError && err.code === "NOT_FOUND") return null;
    // Refused by the limiter (getText wraps errors thrown by fetch as UPSTREAM_ERROR with the cause).
    if (err instanceof CatalogError && err.cause instanceof CatalogError && err.cause.code === "RATE_LIMITED") throw err.cause;
    if (err instanceof CatalogError && err.status === 429) {
      const retryAfterMs = opts.limiter ? opts.limiter.rateLimited(retryAfter) : (parseRetryAfter(retryAfter, (opts.now ?? Date.now)()) ?? MOJANG_DEFAULT_RETRY_AFTER_MS);
      throw new CatalogError("RATE_LIMITED", "Mojang profile API rate limit reached", { url, status: 429, retryAfterMs, cause: err });
    }
    throw err;
  }
  // Older API versions answered 204 No Content for unknown names.
  if (text.trim() === "") return null;
  const p = parseJson(text, ProfileSchema, url);
  // The API matches names case-insensitively; anything else is not the player we asked for.
  if (p.name.toLowerCase() !== name.toLowerCase()) throw new CatalogError("INVALID_UPSTREAM_RESPONSE", "Mojang returned a different player than requested", { url });
  return { uuid: normalizeUuid(p.id)!, name: p.name, source: "mojang" };
}

/**
 * Resolves the UUID the server will use for `name`: the Mojang account UUID when the server runs
 * in online mode (or behind a proxy that forwards online-mode identities), otherwise the
 * offline-mode name UUID.
 */
export async function resolvePlayerProfile(ctx: CatalogContext, name: string, opts: { onlineMode: boolean } & MojangLookupOptions): Promise<PlayerProfile | null> {
  if (opts.onlineMode) return lookupMojangProfile(ctx, name, opts);
  return { uuid: offlinePlayerUuid(assertPlayerName(name)), name, source: "offline" };
}
