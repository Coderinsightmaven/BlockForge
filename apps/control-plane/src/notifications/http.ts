import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { validateOutboundUrl, type LookupFn, type ValidatedTarget } from "./ssrf.js";

export interface PostResult {
  status: number;
  body: string;
}

export type RawPost = (target: ValidatedTarget, body: string, headers: Record<string, string>, timeoutMs: number, maxResponseBytes: number) => Promise<PostResult>;

/**
 * POST over HTTPS to an already validated, *pinned* address. The socket connects to
 * `target.address` (no second DNS lookup → no DNS-rebinding window) while TLS SNI and the Host
 * header still use the original hostname, so certificate validation is unaffected.
 */
export const pinnedHttpsPost: RawPost = (target, body, headers, timeoutMs, maxResponseBytes) =>
  new Promise<PostResult>((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_host, options, cb) => {
      if (typeof options === "object" && options?.all) {
        (cb as unknown as (err: null, addrs: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
      } else {
        cb(null, target.address, target.family);
      }
    };
    const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
    const opts: RequestOptions = {
      method: "POST",
      host: hostname,
      // SNI must be a DNS name (RFC 6066); IP-literal URLs are verified against the IP SAN instead.
      ...(isIP(hostname) ? {} : { servername: hostname }),
      port: target.url.port ? Number(target.url.port) : 443,
      path: `${target.url.pathname}${target.url.search}`,
      headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
      lookup: pinnedLookup,
      timeout: timeoutMs,
    };
    const req = httpsRequest(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxResponseBytes) {
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("close", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });

export interface PinnedGetResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * GET over HTTPS to an already validated, pinned address (same pinning as {@link pinnedHttpsPost}).
 * Redirects are not followed (the caller re-validates every hop). The body is bounded: exceeding
 * `maxResponseBytes` fails the request instead of truncating it.
 */
export function pinnedHttpsGet(
  target: ValidatedTarget,
  opts: { headers?: Record<string, string>; timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal },
): Promise<PinnedGetResult> {
  return new Promise<PinnedGetResult>((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_host, options, cb) => {
      if (typeof options === "object" && options?.all) {
        (cb as unknown as (err: null, addrs: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
      } else {
        cb(null, target.address, target.family);
      }
    };
    const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
    const req = httpsRequest(
      {
        method: "GET",
        host: hostname,
        ...(isIP(hostname) ? {} : { servername: hostname }),
        port: target.url.port ? Number(target.url.port) : 443,
        path: `${target.url.pathname}${target.url.search}`,
        headers: { "user-agent": "BlockForge/1", ...(opts.headers ?? {}) },
        lookup: pinnedLookup,
        timeout: opts.timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (res: IncomingMessage) => {
        const declared = Number(res.headers["content-length"] ?? "NaN");
        if (Number.isFinite(declared) && declared > opts.maxResponseBytes) {
          res.destroy();
          reject(new Error(`response too large (${declared} bytes)`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxResponseBytes) {
            res.destroy();
            reject(new Error(`response exceeds ${opts.maxResponseBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

export interface SafePostOptions {
  allowlist?: readonly string[];
  lookup?: LookupFn;
  timeoutMs?: number;
  maxResponseBytes?: number;
  transport?: RawPost;
}

/**
 * SSRF-safe JSON POST: validates scheme/host/resolved addresses, pins the connection, bounds time
 * and response size, and never follows redirects (a 3xx is reported as a failure, so a public
 * endpoint cannot bounce the request to an internal host).
 */
export async function safePostJson(url: string, payload: unknown, opts: SafePostOptions = {}): Promise<PostResult> {
  const target = await validateOutboundUrl(url, { ...(opts.allowlist ? { allowlist: opts.allowlist } : {}), ...(opts.lookup ? { lookup: opts.lookup } : {}) });
  const res = await (opts.transport ?? pinnedHttpsPost)(
    target,
    JSON.stringify(payload),
    { "content-type": "application/json", "user-agent": "BlockForge-Notifier/1" },
    opts.timeoutMs ?? 10_000,
    opts.maxResponseBytes ?? 64 * 1024,
  );
  if (res.status >= 300 && res.status < 400) throw new Error(`webhook responded with redirect ${res.status}; redirects are not followed`);
  if (res.status < 200 || res.status >= 300) throw new Error(`webhook responded with HTTP ${res.status}`);
  return res;
}
