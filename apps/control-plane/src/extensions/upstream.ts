import { CatalogError, ModrinthClient, ModrinthRateLimiter, MODRINTH_HOSTS, MOJANG_PROFILE_HOSTS, modrinthUserAgent, TtlCache, type CatalogContext } from "@blockforge/minecraft";
import type { Logger } from "pino";
import { createSafeFetch, SafeFetchError, type TestTransportOverride } from "../catalog/safe-fetch.js";
import { JobError } from "../jobs/types.js";
import { AppError, badRequest, notFound, rateLimited, unprocessable, upstreamError } from "../lib/errors.js";
import type { LookupFn } from "../notifications/ssrf.js";

export interface UpstreamOptions {
  logger: Logger;
  version: string;
  contact: string;
  /** Test seams (recorded fixtures). */
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  /** Test-only transport override (`testTransportOverride`): the real pinned transport against a local server. */
  testOverride?: TestTransportOverride;
  /** Rate limiter clock / waits (tests). */
  limiter?: { now?: () => number; sleep?: (ms: number) => Promise<void>; maxWaitMs?: number };
}

/** `BlockForge/<version> (<contact>)`; an unusable contact falls back to the product name. */
export function userAgentFor(version: string, contact: string): string {
  try {
    return modrinthUserAgent(version, contact);
  } catch {
    return modrinthUserAgent(version, "BlockForge control plane");
  }
}

/**
 * Third-party APIs of Phase 4b behind the SSRF-safe fetch: one Modrinth client + one
 * `ModrinthRateLimiter` per process (the Modrinth limit is per IP), and the Mojang profile API.
 * Responses are cached for 10 minutes.
 */
export class Upstreams {
  readonly modrinth: ModrinthClient;
  readonly modrinthLimiter: ModrinthRateLimiter;
  readonly mojang: CatalogContext;
  readonly userAgent: string;

  constructor(private readonly opts: UpstreamOptions) {
    this.userAgent = userAgentFor(opts.version, opts.contact);
    const fetchFor = (hosts: readonly string[]) =>
      createSafeFetch({
        allowedHosts: hosts,
        ...(opts.lookup ? { lookup: opts.lookup } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.testOverride ? { testOverride: opts.testOverride } : {}),
        timeoutMs: 15_000,
        maxBytes: 16 * 1024 * 1024,
      });
    this.modrinthLimiter = new ModrinthRateLimiter({
      maxWaitMs: opts.limiter?.maxWaitMs ?? 2_000,
      ...(opts.limiter?.now ? { now: opts.limiter.now } : {}),
      ...(opts.limiter?.sleep ? { sleep: opts.limiter.sleep } : {}),
    });
    this.modrinth = new ModrinthClient({
      fetch: fetchFor(MODRINTH_HOSTS.api),
      userAgent: this.userAgent,
      cache: new TtlCache<string, string>({ defaultTtlMs: 10 * 60_000, maxEntries: 2000 }),
      ttlMs: 10 * 60_000,
      limiter: this.modrinthLimiter,
    });
    this.mojang = {
      fetch: fetchFor(MOJANG_PROFILE_HOSTS),
      userAgent: this.userAgent,
      cache: new TtlCache<string, string>({ defaultTtlMs: 10 * 60_000, maxEntries: 2000 }),
      ttlMs: 10 * 60_000,
      metadataHosts: MOJANG_PROFILE_HOSTS,
    };
  }

  /**
   * Maps upstream failures to API errors: throttling → 429 `RATE_LIMITED` with `retryAfterMs` and the
   * upstream's name; unknown project/version/player → 404; refused/invalid/unavailable → 502. Upstream
   * text is never passed through (it is untrusted); details go to the log only.
   */
  httpError(err: unknown, upstream: "modrinth" | "mojang", what = "Project or version"): unknown {
    if (err instanceof AppError) return err;
    if (err instanceof SafeFetchError) {
      this.opts.logger.warn({ err: err.message, upstream }, "upstream request refused by the outbound policy");
      return upstreamError(`The ${upstream === "modrinth" ? "Modrinth" : "Mojang"} request was refused by the outbound policy`);
    }
    if (err instanceof CatalogError) {
      switch (err.code) {
        case "RATE_LIMITED": {
          const wait = err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : 60_000;
          return rateLimited(wait / 1000, { upstream, message: `${upstream === "modrinth" ? "Modrinth" : "Mojang"} rate limit reached; try again later` });
        }
        case "NOT_FOUND":
          return notFound(what);
        case "INVALID_ARGUMENT":
          return badRequest(err.message);
        case "UNSUPPORTED":
          return unprocessable(err.message, { reason: "unsupported_software" });
        default:
          this.opts.logger.warn({ code: err.code, upstream }, "upstream error");
          return upstreamError(`${upstream === "modrinth" ? "Modrinth" : "Mojang"} is unavailable or returned unexpected data`);
      }
    }
    return err;
  }

  /** The same mapping for jobs (`RATE_LIMITED` / `UPSTREAM_ERROR` / `NOT_FOUND` job errors). */
  jobError(err: unknown, upstream: "modrinth" | "mojang"): unknown {
    const e = this.httpError(err, upstream);
    if (e instanceof AppError) return new JobError(e.code, e.message, e.code === "RATE_LIMITED" || e.code === "UPSTREAM_ERROR");
    return e;
  }
}
