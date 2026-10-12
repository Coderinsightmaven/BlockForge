import type { z } from "zod";
import type { TtlCache } from "./cache.js";
import { CatalogError } from "./errors.js";

/** Injected fetch: the control plane owns timeouts, proxying and SSRF policy. */
export type Fetch = typeof globalThis.fetch;

export interface CatalogContext {
  fetch: Fetch;
  /** Shared response cache (URL → body text). Optional; omit to disable caching. */
  cache?: TtlCache<string, string>;
  /** Cache TTL for upstream metadata responses. Default 10 minutes. */
  ttlMs?: number;
  /** Sent as `user-agent` (Node's fetch allows it). */
  userAgent?: string;
  /** Upper bound on a single metadata response body. Default 16 MiB. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export const DEFAULT_USER_AGENT = "BlockForge-catalogue/0.1 (+self-hosted Minecraft server manager)";

export function assertHttpsUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch (cause) {
    throw new CatalogError("INVALID_ARGUMENT", `invalid URL: ${url}`, { cause });
  }
  if (u.protocol !== "https:") throw new CatalogError("INVALID_ARGUMENT", `refusing non-HTTPS URL: ${url}`);
  if (u.username || u.password) throw new CatalogError("INVALID_ARGUMENT", "URLs with credentials are not allowed");
  return u;
}

/** Fetches a URL as text (with caching). 404 → NOT_FOUND, other non-2xx → UPSTREAM_ERROR. */
export async function getText(ctx: CatalogContext, url: string, accept = "application/json"): Promise<string> {
  assertHttpsUrl(url);
  const cached = ctx.cache?.get(url);
  if (cached !== undefined) return cached;
  const load = async (): Promise<string> => {
    let res: Response;
    try {
      const init: RequestInit = {
        method: "GET",
        headers: { accept, "user-agent": ctx.userAgent ?? DEFAULT_USER_AGENT },
      };
      if (ctx.signal) init.signal = ctx.signal;
      res = await ctx.fetch(url, init);
    } catch (cause) {
      throw new CatalogError("UPSTREAM_ERROR", `request failed: ${url}`, { url, cause });
    }
    if (res.status === 404) throw new CatalogError("NOT_FOUND", `not found upstream: ${url}`, { url, status: 404 });
    if (!res.ok) {
      throw new CatalogError("UPSTREAM_ERROR", `upstream returned HTTP ${res.status}: ${url}`, { url, status: res.status });
    }
    const max = ctx.maxResponseBytes ?? 16 * 1024 * 1024;
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > max) {
      throw new CatalogError("UPSTREAM_ERROR", `upstream response too large (${declared} bytes): ${url}`, { url });
    }
    const text = await res.text();
    if (text.length > max) throw new CatalogError("UPSTREAM_ERROR", `upstream response too large: ${url}`, { url });
    return text;
  };
  if (ctx.cache) return ctx.cache.getOrLoad(url, load, ctx.ttlMs);
  return load();
}

/** Fetches JSON and validates it with a zod schema (upstream data is a trust boundary). */
export async function getJson<S extends z.ZodType>(ctx: CatalogContext, url: string, schema: S): Promise<z.infer<S>> {
  const text = await getText(ctx, url);
  return parseJson(text, schema, url);
}

export function parseJson<S extends z.ZodType>(text: string, schema: S, url: string): z.infer<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new CatalogError("INVALID_UPSTREAM_RESPONSE", `invalid JSON from ${url}`, { url, cause });
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new CatalogError(
      "INVALID_UPSTREAM_RESPONSE",
      `unexpected response shape from ${url}: ${r.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      { url, cause: r.error },
    );
  }
  return r.data;
}

/** Extracts `<version>` entries from a Maven `maven-metadata.xml` (document order). */
export function parseMavenMetadataVersions(xml: string): string[] {
  if (!/<metadata[\s>]/.test(xml)) throw new CatalogError("INVALID_UPSTREAM_RESPONSE", "not a maven-metadata.xml document");
  const out: string[] = [];
  for (const m of xml.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Parses a Maven checksum sidecar (`<hex>` or `<hex>  filename`). */
export function parseChecksumFile(text: string, hexLength: number): string | null {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return new RegExp(`^[a-f0-9]{${hexLength}}$`).test(first) ? first : null;
}
