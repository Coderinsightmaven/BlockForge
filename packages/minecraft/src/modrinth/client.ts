import { z } from "zod";
import type { TtlCache } from "../cache.js";
import { CatalogError } from "../errors.js";
import { assertAllowedUrl, parseJson, type Fetch } from "../http.js";
import {
  ModrinthHashMapSchema,
  ModrinthProjectSchema,
  ModrinthSearchResponseSchema,
  ModrinthVersionSchema,
  type ModrinthProjectRaw,
  type ModrinthVersionRaw,
} from "./schemas.js";

/** Modrinth API v2 (https://docs.modrinth.com/api/). */
export const MODRINTH_API_BASE = "https://api.modrinth.com/v2";
/** Hosts the Modrinth client talks to / accepts download URLs from (exact match). */
export const MODRINTH_HOSTS = {
  api: ["api.modrinth.com"],
  cdn: ["cdn.modrinth.com"],
} as const;

export type HashAlgorithm = "sha1" | "sha512";
export type VersionType = "release" | "beta" | "alpha";

/** Filters for the `/update` endpoints (`version_types` verified live 2026-10-12). */
export interface UpdateFilter {
  loaders: readonly string[];
  gameVersions?: readonly string[];
  /** Omit for any type. */
  versionTypes?: readonly VersionType[];
}

function updateBody(filter: UpdateFilter): Record<string, unknown> {
  const body: Record<string, unknown> = { loaders: filter.loaders };
  if (filter.gameVersions && filter.gameVersions.length > 0) body["game_versions"] = filter.gameVersions;
  if (filter.versionTypes && filter.versionTypes.length > 0) body["version_types"] = filter.versionTypes;
  return body;
}

export interface ModrinthClientOptions {
  fetch: Fetch;
  /**
   * Required by Modrinth's API rules: a User-Agent that uniquely identifies the application and
   * gives a contact, e.g. `modrinthUserAgent("0.4.0", "ops@example.com")` →
   * `BlockForge/0.4.0 (ops@example.com)`.
   */
  userAgent: string;
  /** Response cache (key → body text). GET keys are URLs, POST keys `POST <url>\n<body>`. */
  cache?: TtlCache<string, string>;
  /** Default 10 minutes. */
  ttlMs?: number;
  /** Default 16 MiB. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  /** Override the API hosts (tests / mirrors). Default `MODRINTH_HOSTS.api`. */
  apiHosts?: readonly string[];
  /** Hosts file URLs must be on. Default `MODRINTH_HOSTS.cdn`. */
  cdnHosts?: readonly string[];
  /** Default `MODRINTH_API_BASE`; must be HTTPS on `apiHosts`. */
  apiBase?: string;
  /**
   * When `X-Ratelimit-Remaining` drops to this value or below, `rateLimit.backoffMs` asks callers
   * to wait until the window resets. Default 10 (the public limit is 300 requests/minute per IP).
   */
  lowWatermark?: number;
  /** Clock for the rate-limit window (default `Date.now`). */
  now?: () => number;
}

/** Last observed `X-Ratelimit-*` headers plus a back-off hint. */
export interface ModrinthRateLimit {
  limit: number | null;
  remaining: number | null;
  /** Seconds until the window resets. */
  resetSeconds: number | null;
  /** 0 = go ahead; otherwise wait this long before the next request. */
  backoffMs: number;
}

const USER_AGENT_RE = /^[\x20-\x7e]{1,256}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const CONTACT_RE = /^[\x20-\x27\x2a-\x7e]{1,128}$/;

/** `BlockForge/<version> (<contact>)` per Modrinth's User-Agent rules. */
export function modrinthUserAgent(version: string, contact: string): string {
  if (!VERSION_RE.test(version)) throw new CatalogError("INVALID_ARGUMENT", "invalid BlockForge version for the User-Agent");
  const c = contact.trim();
  if (!CONTACT_RE.test(c)) throw new CatalogError("INVALID_ARGUMENT", "the User-Agent contact must be printable ASCII without parentheses");
  return `BlockForge/${version} (${c})`;
}

const SLUG_RE = /^[\w!@$()+,'.-]{1,64}$/;

/** Validates a project id or slug before it goes into a URL path. */
export function assertProjectRef(ref: string): string {
  if (!SLUG_RE.test(ref) || /^\.+$/.test(ref)) throw new CatalogError("INVALID_ARGUMENT", "invalid Modrinth project id or slug");
  return ref;
}

const ID_RE = /^[A-Za-z0-9]{1,16}$/;
export function assertModrinthId(id: string, what = "id"): string {
  if (!ID_RE.test(id)) throw new CatalogError("INVALID_ARGUMENT", `invalid Modrinth ${what}`);
  return id;
}

export function assertHash(hash: string, algorithm: HashAlgorithm): string {
  const h = hash.toLowerCase();
  const len = algorithm === "sha1" ? 40 : 128;
  if (h.length !== len || !/^[a-f0-9]+$/.test(h)) throw new CatalogError("INVALID_ARGUMENT", `invalid ${algorithm} hash`);
  return h;
}

/** Parses the rate-limit headers of a response (missing/invalid values → null). */
export function parseRateLimit(headers: Headers, status: number, lowWatermark = 10): ModrinthRateLimit {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || !/^\d{1,9}$/.test(raw.trim())) return null;
    return Number(raw.trim());
  };
  const limit = num("x-ratelimit-limit");
  const remaining = num("x-ratelimit-remaining");
  const resetSeconds = num("x-ratelimit-reset");
  const retryAfter = num("retry-after");
  let backoffMs = 0;
  if (status === 429) backoffMs = Math.max(1, retryAfter ?? resetSeconds ?? 60) * 1000;
  else if (remaining !== null && remaining <= lowWatermark) backoffMs = Math.max(1, resetSeconds ?? 60) * 1000;
  return { limit, remaining, resetSeconds, backoffMs };
}

const MAX_REDIRECTS = 5;
const MAX_BATCH = 100;

/**
 * Minimal Modrinth API v2 client. Every request and redirect hop must be HTTPS on `apiHosts`;
 * file URLs inside responses are checked against `cdnHosts` by the plan helpers. Responses are
 * validated with zod. No authentication: only public endpoints are used.
 */
export class ModrinthClient {
  private readonly opts: ModrinthClientOptions;
  private readonly base: string;
  private last: ModrinthRateLimit | null = null;
  private lastAt = 0;

  constructor(opts: ModrinthClientOptions) {
    if (!USER_AGENT_RE.test(opts.userAgent)) throw new CatalogError("INVALID_ARGUMENT", "a printable ASCII User-Agent is required by Modrinth");
    this.opts = opts;
    this.base = (opts.apiBase ?? MODRINTH_API_BASE).replace(/\/+$/, "");
    assertAllowedUrl(this.base, this.apiHosts);
  }

  get apiHosts(): readonly string[] {
    return this.opts.apiHosts ?? MODRINTH_HOSTS.api;
  }

  get cdnHosts(): readonly string[] {
    return this.opts.cdnHosts ?? MODRINTH_HOSTS.cdn;
  }

  /** Rate-limit state of the most recent response (null before the first request). */
  get rateLimit(): ModrinthRateLimit | null {
    return this.last;
  }

  url(path: string, query: Record<string, string | undefined> = {}): string {
    const u = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    return u.href;
  }

  /**
   * Refuses to send while the last response said the window is exhausted (`remaining: 0`) and
   * its reset time has not passed — the caller gets `RATE_LIMITED` with the remaining wait.
   */
  private checkWindow(url: string): void {
    const last = this.last;
    if (!last || last.remaining !== 0) return;
    const until = this.lastAt + Math.max(1, last.resetSeconds ?? 60) * 1000;
    const wait = until - (this.opts.now ?? Date.now)();
    if (wait > 0) throw new CatalogError("RATE_LIMITED", "Modrinth rate limit window exhausted", { url, retryAfterMs: wait });
  }

  private async request(method: "GET" | "POST", url: string, body: unknown, notFoundAsNull: boolean): Promise<string | null> {
    assertAllowedUrl(url, this.apiHosts);
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    const key = method === "GET" ? url : `POST ${url}\n${bodyText ?? ""}`;
    const cache = this.opts.cache;
    const NOT_FOUND = "\u0000404";
    const load = async (): Promise<string> => {
      this.checkWindow(url);
      let current = url;
      let res: Response;
      for (let hop = 0; ; hop++) {
        const headers: Record<string, string> = { accept: "application/json", "user-agent": this.opts.userAgent };
        const init: RequestInit = { method, redirect: "manual", headers };
        if (bodyText !== undefined) {
          headers["content-type"] = "application/json";
          init.body = bodyText;
        }
        if (this.opts.signal) init.signal = this.opts.signal;
        try {
          res = await this.opts.fetch(current, init);
        } catch (cause) {
          throw new CatalogError("UPSTREAM_ERROR", `request failed: ${current}`, { url: current, cause });
        }
        this.last = parseRateLimit(res.headers, res.status, this.opts.lowWatermark);
        this.lastAt = (this.opts.now ?? Date.now)();
        if (res.type === "opaqueredirect") throw new CatalogError("UPSTREAM_ERROR", `upstream redirected and the target cannot be inspected: ${current}`, { url: current });
        if (res.status < 300 || res.status >= 400 || res.status === 304) break;
        // Only follow redirects for GET; a redirected POST would change semantics.
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (method !== "GET" || !location || hop + 1 > MAX_REDIRECTS) {
          throw new CatalogError("UPSTREAM_ERROR", `unexpected redirect from ${current}`, { url: current, status: res.status });
        }
        let next: string;
        try {
          next = new URL(location, current).href;
          assertAllowedUrl(next, this.apiHosts);
        } catch (cause) {
          throw new CatalogError("UPSTREAM_ERROR", `refusing redirect from ${current}`, { url: current, status: res.status, cause });
        }
        current = next;
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        throw new CatalogError("RATE_LIMITED", "Modrinth rate limit reached", { url, status: 429, retryAfterMs: this.last?.backoffMs ?? 60_000 });
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        if (notFoundAsNull) return NOT_FOUND;
        throw new CatalogError("NOT_FOUND", `not found on Modrinth: ${url}`, { url, status: 404 });
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new CatalogError("UPSTREAM_ERROR", `Modrinth returned HTTP ${res.status}: ${url}`, { url, status: res.status });
      }
      const max = this.opts.maxResponseBytes ?? 16 * 1024 * 1024;
      const declared = Number(res.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(declared) && declared > max) throw new CatalogError("UPSTREAM_ERROR", `Modrinth response too large: ${url}`, { url });
      const text = await res.text();
      if (text.length > max) throw new CatalogError("UPSTREAM_ERROR", `Modrinth response too large: ${url}`, { url });
      return text;
    };
    const text = cache ? await cache.getOrLoad(key, load, this.opts.ttlMs) : await load();
    return text === NOT_FOUND ? null : text;
  }

  async getJson<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const text = (await this.request("GET", url, undefined, false))!;
    return parseJson(text, schema, url);
  }

  private async getJsonOrNull<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S> | null> {
    const text = await this.request("GET", url, undefined, true);
    return text === null ? null : parseJson(text, schema, url);
  }

  private async postJson<S extends z.ZodType>(url: string, body: unknown, schema: S): Promise<z.infer<S>> {
    const text = (await this.request("POST", url, body, false))!;
    return parseJson(text, schema, url);
  }

  private async postJsonOrNull<S extends z.ZodType>(url: string, body: unknown, schema: S): Promise<z.infer<S> | null> {
    const text = await this.request("POST", url, body, true);
    return text === null ? null : parseJson(text, schema, url);
  }

  /** `GET /search` with pre-built facets (see `buildModrinthSearch`). */
  async search(params: { query?: string; facets: string[][]; index?: string; offset?: number; limit?: number }) {
    const url = this.url("/search", {
      query: params.query === undefined || params.query === "" ? undefined : params.query,
      facets: JSON.stringify(params.facets),
      index: params.index,
      offset: params.offset === undefined ? undefined : String(params.offset),
      limit: params.limit === undefined ? undefined : String(params.limit),
    });
    return this.getJson(url, ModrinthSearchResponseSchema);
  }

  async getProject(ref: string): Promise<ModrinthProjectRaw> {
    return this.getJson(this.url(`/project/${encodeURIComponent(assertProjectRef(ref))}`), ModrinthProjectSchema);
  }

  /** `GET /projects?ids=[…]` (batched by 100; unknown ids are silently omitted upstream). */
  async getProjects(ids: readonly string[]): Promise<ModrinthProjectRaw[]> {
    const out: ModrinthProjectRaw[] = [];
    const unique = [...new Set(ids.map((id) => assertModrinthId(id, "project id")))].sort();
    for (let i = 0; i < unique.length; i += MAX_BATCH) {
      const chunk = unique.slice(i, i + MAX_BATCH);
      out.push(...(await this.getJson(this.url("/projects", { ids: JSON.stringify(chunk) }), z.array(ModrinthProjectSchema).max(MAX_BATCH))));
    }
    return out;
  }

  /** `GET /project/{ref}/version` filtered upstream by loaders / game versions (re-checked locally by callers). */
  async listVersions(ref: string, filter: { loaders?: readonly string[]; gameVersions?: readonly string[] } = {}): Promise<ModrinthVersionRaw[]> {
    const url = this.url(`/project/${encodeURIComponent(assertProjectRef(ref))}/version`, {
      loaders: filter.loaders && filter.loaders.length > 0 ? JSON.stringify(filter.loaders) : undefined,
      game_versions: filter.gameVersions && filter.gameVersions.length > 0 ? JSON.stringify(filter.gameVersions) : undefined,
    });
    return this.getJson(url, z.array(ModrinthVersionSchema).max(65_536));
  }

  async getVersion(id: string): Promise<ModrinthVersionRaw> {
    return this.getJson(this.url(`/version/${assertModrinthId(id, "version id")}`), ModrinthVersionSchema);
  }

  /** `GET /versions?ids=[…]` (batched by 100). */
  async getVersions(ids: readonly string[]): Promise<ModrinthVersionRaw[]> {
    const out: ModrinthVersionRaw[] = [];
    const unique = [...new Set(ids.map((id) => assertModrinthId(id, "version id")))].sort();
    for (let i = 0; i < unique.length; i += MAX_BATCH) {
      const chunk = unique.slice(i, i + MAX_BATCH);
      out.push(...(await this.getJson(this.url("/versions", { ids: JSON.stringify(chunk) }), z.array(ModrinthVersionSchema).max(MAX_BATCH))));
    }
    return out;
  }

  /** `GET /version_file/{hash}` → the version containing the file, or null when unknown (404). */
  async versionFromHash(hash: string, algorithm: HashAlgorithm): Promise<ModrinthVersionRaw | null> {
    const h = assertHash(hash, algorithm);
    return this.getJsonOrNull(this.url(`/version_file/${h}`, { algorithm }), ModrinthVersionSchema);
  }

  /** `POST /version_files` → hash → version for the hashes Modrinth knows (batched by 100). */
  async versionsFromHashes(hashes: readonly string[], algorithm: HashAlgorithm): Promise<Map<string, ModrinthVersionRaw>> {
    const out = new Map<string, ModrinthVersionRaw>();
    const unique = [...new Set(hashes.map((h) => assertHash(h, algorithm)))].sort();
    for (let i = 0; i < unique.length; i += MAX_BATCH) {
      const chunk = unique.slice(i, i + MAX_BATCH);
      const map = await this.postJson(this.url("/version_files"), { hashes: chunk, algorithm }, ModrinthHashMapSchema);
      for (const h of chunk) {
        const v = Object.hasOwn(map, h) ? map[h] : undefined;
        if (v) out.set(h, v);
      }
    }
    return out;
  }

  /** `POST /version_file/{hash}/update` → newest version matching the filters, or null. */
  async latestVersionFromHash(hash: string, algorithm: HashAlgorithm, filter: UpdateFilter): Promise<ModrinthVersionRaw | null> {
    const h = assertHash(hash, algorithm);
    return this.postJsonOrNull(this.url(`/version_file/${h}/update`, { algorithm }), updateBody(filter), ModrinthVersionSchema);
  }

  /** `POST /version_files/update` → hash → newest version matching the filters (batched by 100). */
  async latestVersionsFromHashes(
    hashes: readonly string[],
    algorithm: HashAlgorithm,
    filter: UpdateFilter,
  ): Promise<Map<string, ModrinthVersionRaw>> {
    const out = new Map<string, ModrinthVersionRaw>();
    const unique = [...new Set(hashes.map((h) => assertHash(h, algorithm)))].sort();
    for (let i = 0; i < unique.length; i += MAX_BATCH) {
      const chunk = unique.slice(i, i + MAX_BATCH);
      const body: Record<string, unknown> = { hashes: chunk, algorithm, ...updateBody(filter) };
      const map = await this.postJson(this.url("/version_files/update"), body, ModrinthHashMapSchema);
      for (const h of chunk) {
        const v = Object.hasOwn(map, h) ? map[h] : undefined;
        if (v) out.set(h, v);
      }
    }
    return out;
  }
}
