import { pinnedHttpsRequest, type PinnedTransport } from "../notifications/http.js";
import { SsrfError, validateOutboundUrl, type LookupFn, type ValidatedTarget } from "../notifications/ssrf.js";
import { APP_VERSION } from "../lib/version.js";

/** Largest request body sent upstream (Modrinth hash lookups are a few KiB per 100 hashes). */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const METHODS = new Set(["GET", "HEAD", "POST"]);
const DEFAULT_USER_AGENT = `BlockForge/${APP_VERSION}`;

/**
 * Test-only transport override: trust `ca` and open every pinned connection to `connect` (the local
 * test server) while TLS is still verified for the URL's hostname. Values are only honoured when they
 * were created by {@link testTransportOverride}, which refuses to run outside the test environment —
 * production configuration has no way to turn certificate verification off or to redirect connections.
 */
export interface TestTransportOverride {
  readonly ca: string;
  readonly connect: { readonly address: string; readonly port: number };
}
const TEST_OVERRIDES = new WeakSet<object>();

export function testTransportOverride(o: { ca: string; connect: { address: string; port: number } }): TestTransportOverride {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("testTransportOverride is only available in tests");
  const v: TestTransportOverride = Object.freeze({ ca: o.ca, connect: Object.freeze({ address: o.connect.address, port: o.connect.port }) });
  TEST_OVERRIDES.add(v);
  return v;
}

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
  transport?: PinnedTransport;
  /** See {@link TestTransportOverride} (ignored unless created by `testTransportOverride`). */
  testOverride?: TestTransportOverride;
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

/** Request headers as a lower-case record (Headers, tuple arrays and plain objects). */
function headerRecord(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h ?? {}).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

/** The request body as bytes (strings, byte arrays, URLSearchParams), bounded. */
function bodyBytes(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  let buf: Buffer;
  if (typeof body === "string") buf = Buffer.from(body, "utf8");
  else if (body instanceof URLSearchParams) buf = Buffer.from(body.toString(), "utf8");
  else if (body instanceof ArrayBuffer) buf = Buffer.from(body);
  else if (ArrayBuffer.isView(body)) buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  else throw new SafeFetchError("unsupported request body type");
  if (buf.byteLength > MAX_REQUEST_BODY_BYTES) throw new SafeFetchError(`request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
  return buf;
}

const asBody = (b: Uint8Array) => (b.byteLength ? (b as unknown as ConstructorParameters<typeof Response>[0]) : null);

/**
 * A `fetch` for upstream metadata APIs (software catalogue, Modrinth, Mojang): HTTPS only, hosts
 * restricted to an allowlist (also for every redirect hop), every resolved address must be public, the
 * connection is pinned to the validated address, bounded time, request body and response size. Method,
 * headers (User-Agent, Content-Type, Accept, …) and body are sent as given. Redirects are followed
 * (and re-validated) only for GET/HEAD; for other methods the 3xx is returned to the caller, so a POST
 * is never replayed elsewhere or silently turned into a GET. The returned `Response` is fully buffered.
 */
export function createSafeFetch(opts: SafeFetchOptions): typeof fetch {
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const override = opts.testOverride && TEST_OVERRIDES.has(opts.testOverride) ? opts.testOverride : undefined;
  const safeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    let url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) throw new SafeFetchError(`method ${method} is not allowed`);
    const headers = headerRecord(init.headers);
    headers["accept"] ??= "application/json, */*";
    headers["user-agent"] ??= DEFAULT_USER_AGENT;
    const body = bodyBytes(init.body);
    if (body && (method === "GET" || method === "HEAD")) throw new SafeFetchError(`a ${method} request cannot have a body`);
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:") throw new SafeFetchError(`refusing non-HTTPS URL ${url.origin}`);
      if (!allowed.has(url.hostname.toLowerCase())) throw new SafeFetchError(`host ${url.hostname} is not on the allowlist`);
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
        // The caller's body as given (already size-checked above).
        res = await opts.fetchImpl(url.href, { method, headers, ...(body && init.body ? { body: init.body } : {}), redirect: "manual", signal });
      } else {
        // The connection is pinned to the address that passed the check (no DNS-rebinding window).
        const r = await (opts.transport ?? pinnedHttpsRequest)(target, {
          method,
          headers,
          ...(body ? { body } : {}),
          timeoutMs,
          maxResponseBytes: maxBytes,
          signal,
          ...(override ? { testOverride: override } : {}),
        }).catch((err: unknown) => {
          throw new SafeFetchError(`request to ${url.hostname} failed: ${(err as Error).message}`);
        });
        const redirect = r.status >= 300 && r.status < 400;
        res = new Response(redirect || method === "HEAD" ? null : asBody(new Uint8Array(r.body)), { status: r.status, headers: r.headers });
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        // Only safe methods are followed; anything else gets the redirect back (the caller decides).
        if (method !== "GET" && method !== "HEAD") return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
        const location = res.headers.get("location");
        if (!location) throw new SafeFetchError(`redirect without location from ${url.hostname}`);
        if (hop >= maxRedirects) throw new SafeFetchError("too many redirects");
        url = new URL(location, url);
        continue;
      }
      const buf = method === "HEAD" ? new Uint8Array() : await readCapped(res, maxBytes);
      return new Response(asBody(buf), { status: res.status, statusText: res.statusText, headers: res.headers });
    }
  };
  return safeFetch as typeof fetch;
}
