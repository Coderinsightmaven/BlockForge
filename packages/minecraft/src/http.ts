import type { z } from "zod";
import type { TtlCache } from "./cache.js";
import { CATALOG_HOSTS } from "./catalog/hosts.js";
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
  /** Hosts metadata may be fetched from (every request and redirect hop). Default CATALOG_HOSTS.metadata. */
  metadataHosts?: readonly string[];
  /** Hosts download URLs found in upstream metadata may point to. Default CATALOG_HOSTS.artifacts. */
  artifactHosts?: readonly string[];
}

export const DEFAULT_USER_AGENT = "BlockForge-catalogue/0.1 (+self-hosted Minecraft server manager)";
const MAX_REDIRECTS = 5;

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

/**
 * HTTPS URL on one of `hosts` (exact host match, default port only). IP literals (private,
 * loopback, link-local or public) never match because the allowlists only contain DNS names.
 */
export function assertAllowedUrl(url: string, hosts: readonly string[], kind: "metadata" | "artifact" = "metadata"): URL {
  const u = assertHttpsUrl(url);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.port !== "" && u.port !== "443") throw new CatalogError("INVALID_ARGUMENT", `refusing ${kind} URL with a non-default port: ${url}`, { url });
  if (!hosts.includes(host)) throw new CatalogError("INVALID_ARGUMENT", `refusing ${kind} URL on a host outside the catalogue allowlist: ${u.host}`, { url });
  return u;
}

/** Validates a download URL taken from upstream metadata against the artifact host allowlist. */
export function assertArtifactUrl(ctx: Pick<CatalogContext, "artifactHosts">, url: string): string {
  try {
    assertAllowedUrl(url, ctx.artifactHosts ?? CATALOG_HOSTS.artifacts, "artifact");
  } catch (cause) {
    throw new CatalogError("INVALID_UPSTREAM_RESPONSE", `upstream metadata points to a download outside the allowlist: ${url}`, { url, cause });
  }
  return url;
}

/** Fetches a URL as text (with caching). 404 → NOT_FOUND, other non-2xx → UPSTREAM_ERROR. */
export async function getText(ctx: CatalogContext, url: string, accept = "application/json"): Promise<string> {
  const hosts = ctx.metadataHosts ?? CATALOG_HOSTS.metadata;
  assertAllowedUrl(url, hosts);
  const cached = ctx.cache?.get(url);
  if (cached !== undefined) return cached;
  const load = async (): Promise<string> => {
    let res: Response;
    let current = url;
    for (let hop = 0; ; hop++) {
      try {
        const init: RequestInit = {
          method: "GET",
          redirect: "manual",
          headers: { accept, "user-agent": ctx.userAgent ?? DEFAULT_USER_AGENT },
        };
        if (ctx.signal) init.signal = ctx.signal;
        res = await ctx.fetch(current, init);
      } catch (cause) {
        throw new CatalogError("UPSTREAM_ERROR", `request failed: ${current}`, { url: current, cause });
      }
      if (res.type === "opaqueredirect") {
        throw new CatalogError("UPSTREAM_ERROR", `upstream redirected and the target cannot be inspected: ${current}`, { url: current });
      }
      if (res.status < 300 || res.status >= 400 || res.status === 304) break;
      const location = res.headers.get("location");
      if (!location) throw new CatalogError("UPSTREAM_ERROR", `redirect without Location from ${current}`, { url: current, status: res.status });
      if (hop + 1 > MAX_REDIRECTS) throw new CatalogError("UPSTREAM_ERROR", `too many redirects from ${url}`, { url });
      let next: string;
      try {
        next = new URL(location, current).href;
      } catch (cause) {
        throw new CatalogError("UPSTREAM_ERROR", `invalid redirect target from ${current}`, { url: current, cause });
      }
      try {
        assertAllowedUrl(next, hosts);
      } catch (cause) {
        throw new CatalogError("UPSTREAM_ERROR", `refusing redirect from ${current} to ${next}`, { url: current, status: res.status, cause });
      }
      await res.body?.cancel().catch(() => undefined);
      current = next;
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
