import { pinnedHttpsGet, type PinnedGetResult } from "../notifications/http.js";
import { SsrfError, validateOutboundUrl, type LookupFn, type ValidatedTarget } from "../notifications/ssrf.js";

export interface SafeFetchOptions {
  /** Exact hostnames that may be contacted (redirect targets included). */
  allowedHosts: readonly string[];
  lookup?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test seam replacing the pinned transport with a plain fetch (DNS validation still applies). */
  fetchImpl?: typeof fetch;
  /** Test seam for the pinned transport itself. */
  pinnedGet?: (target: ValidatedTarget, opts: { timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<PinnedGetResult>;
}

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) throw new SafeFetchError(`response too large (${declared} bytes)`);
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SafeFetchError(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * A `fetch` for upstream catalogue metadata: HTTPS only, hosts restricted to an allowlist (also for
 * every redirect hop — redirects are followed manually and re-validated), every resolved address
 * must be public, bounded time and body size. The returned `Response` is fully buffered (≤ maxBytes).
 */
export function createSafeFetch(opts: SafeFetchOptions): typeof fetch {
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const safeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    let url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:") throw new SafeFetchError(`refusing non-HTTPS URL ${url.origin}`);
      if (!allowed.has(url.hostname.toLowerCase())) throw new SafeFetchError(`host ${url.hostname} is not on the catalogue allowlist`);
      let target: ValidatedTarget;
      try {
        target = await validateOutboundUrl(url, opts.lookup ? { lookup: opts.lookup } : {});
      } catch (err) {
        if (err instanceof SsrfError) throw new SafeFetchError(err.message);
        throw err;
      }
      let res: Response;
      if (opts.fetchImpl) {
        // Test seam: an injected transport (the DNS check above still ran).
        res = await opts.fetchImpl(url.href, { ...init, method: init.method ?? "GET", redirect: "manual", signal });
      } else {
        // The connection is pinned to the address that passed the check (no DNS-rebinding window).
        const r = await (opts.pinnedGet ?? pinnedHttpsGet)(target, { timeoutMs, maxResponseBytes: maxBytes, signal, headers: { accept: "application/json, */*" } }).catch((err: unknown) => {
          throw new SafeFetchError(`request to ${url.hostname} failed: ${(err as Error).message}`);
        });
        res = new Response(r.body.byteLength && !(r.status >= 300 && r.status < 400) ? (new Uint8Array(r.body) as unknown as ConstructorParameters<typeof Response>[0]) : null, {
          status: r.status,
          headers: r.headers,
        });
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location) throw new SafeFetchError(`redirect without location from ${url.hostname}`);
        if (hop >= maxRedirects) throw new SafeFetchError("too many redirects");
        url = new URL(location, url);
        continue;
      }
      const body = await readCapped(res, maxBytes);
      return new Response(body.byteLength ? (body as unknown as ConstructorParameters<typeof Response>[0]) : null, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
  };
  return safeFetch as typeof fetch;
}
