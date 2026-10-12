import { afterEach, describe, expect, it } from "vitest";
import { createSafeFetch, MAX_REQUEST_BODY_BYTES, SafeFetchError, testTransportOverride } from "../../src/catalog/safe-fetch.js";
import type { PinnedRequestOptions } from "../../src/notifications/http.js";
import { startHttpsUpstream, testCertificate, type HttpsUpstream } from "../support/https-upstream.js";

/**
 * The REAL pinned transport (no `fetchImpl`) against a local HTTPS server: the connection goes to
 * 127.0.0.1 through the test-only override while TLS is verified for the URL's hostname.
 */

const servers: HttpsUpstream[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const PUBLIC: Record<string, string> = { "api.modrinth.com": "151.101.1.1", "a.test": "151.101.2.2", "b.test": "151.101.3.3", "c.test": "151.101.4.4" };
const lookups: string[] = [];
const lookup = async (host: string) => {
  lookups.push(host);
  if (host === "private.test") return [{ address: "10.0.0.7", family: 4 }];
  return [{ address: PUBLIC[host] ?? "151.101.9.9", family: 4 }];
};

async function upstream(handler: (url: string, init: RequestInit) => Response | Promise<Response>, opts: { hold?: (url: string) => boolean } = {}) {
  const s = await startHttpsUpstream(handler, opts);
  servers.push(s);
  return s;
}

describe("catalogue/upstream safe fetch over the real pinned transport", () => {
  it("sends method, headers (User-Agent, Content-Type) and body as given; defaults Accept/User-Agent", async () => {
    const s = await upstream((url, init) => new Response(JSON.stringify({ url, method: init.method }), { status: 200, headers: { "content-type": "application/json" } }));
    const f = createSafeFetch({ allowedHosts: ["api.modrinth.com"], lookup, testOverride: s.override });
    const body = JSON.stringify({ hashes: ["ab"], algorithm: "sha512" });
    const r = await f("https://api.modrinth.com/v2/version_files", { method: "POST", headers: { "user-agent": "BlockForge/9.9.9 (ops@example.com)", "content-type": "application/json", accept: "application/json" }, body });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://api.modrinth.com/v2/version_files", method: "POST" });
    expect(s.requests[0]).toMatchObject({ method: "POST", url: "https://api.modrinth.com/v2/version_files", body });
    expect(s.requests[0]!.headers).toMatchObject({ "user-agent": "BlockForge/9.9.9 (ops@example.com)", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), accept: "application/json" });
    expect(s.requests[0]!.headers.host).toMatch(/^api\.modrinth\.com(:\d+)?$/);
    // Headers as a Headers object; defaults when absent.
    await f("https://api.modrinth.com/v2/project/x", { headers: new Headers({ "x-test": "1" }) });
    expect(s.requests[1]).toMatchObject({ method: "GET", body: "" });
    expect(s.requests[1]!.headers).toMatchObject({ "x-test": "1", accept: "application/json, */*", "user-agent": expect.stringMatching(/^BlockForge\/\d+\.\d+\.\d+$/) });
    // HEAD has no body; methods outside GET/HEAD/POST and bodies on GET are refused locally.
    expect((await f("https://api.modrinth.com/v2/", { method: "HEAD" })).status).toBe(200);
    await expect(f("https://api.modrinth.com/v2/", { method: "DELETE" })).rejects.toThrow(/not allowed/);
    await expect(f("https://api.modrinth.com/v2/", { method: "GET", body: "x" })).rejects.toThrow(SafeFetchError);
    await expect(f("https://api.modrinth.com/v2/", { method: "POST", body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1) })).rejects.toThrow(/request body exceeds/);
    expect(s.requests).toHaveLength(3);
  });

  it("returns a POST's redirect to the caller and follows (re-validated) GET redirects only", async () => {
    const s = await upstream((url) => {
      if (url.endsWith("/post")) return new Response(null, { status: 307, headers: { location: "https://b.test/elsewhere" } });
      if (url === "https://a.test/get") return new Response(null, { status: 302, headers: { location: "https://b.test/target" } });
      if (url === "https://a.test/out") return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      if (url === "https://a.test/private") return new Response(null, { status: 302, headers: { location: "https://private.test/" } });
      return new Response(`hello from ${url}`, { status: 200 });
    });
    const f = createSafeFetch({ allowedHosts: ["a.test", "b.test", "private.test"], lookup, testOverride: s.override });
    const post = await f("https://a.test/post", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(post.status).toBe(307);
    expect(post.headers.get("location")).toBe("https://b.test/elsewhere");
    expect(s.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST https://a.test/post"]);
    lookups.length = 0;
    expect(await (await f("https://a.test/get")).text()).toBe("hello from https://b.test/target");
    expect(lookups).toEqual(["a.test", "b.test"]);
    await expect(f("https://a.test/out")).rejects.toThrow(/allowlist/);
    await expect(f("https://a.test/private")).rejects.toThrow(/non-public/);
    expect(s.requests.some((r) => r.url.includes("evil.example") || r.url.includes("private.test"))).toBe(false);
  });

  it("enforces the response size cap and the timeout", async () => {
    const s = await upstream(
      (url) => {
        if (url.endsWith("/declared")) return new Response("x".repeat(64), { status: 200, headers: { "content-length": "64" } });
        // Chunked (no content-length): counted while streaming.
        return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("y".repeat(64))), c.close()) }), { status: 200 });
      },
      { hold: (url) => url.endsWith("/slow") },
    );
    const f = createSafeFetch({ allowedHosts: ["a.test"], lookup, testOverride: s.override, maxBytes: 32, timeoutMs: 400 });
    await expect(f("https://a.test/declared")).rejects.toThrow(/too large|exceeds/);
    await expect(f("https://a.test/streamed")).rejects.toThrow(/exceeds|too large/);
    const started = Date.now();
    await expect(f("https://a.test/slow")).rejects.toThrow(SafeFetchError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("keeps certificate and hostname verification on (the override only adds a CA and the socket address)", async () => {
    const s = await upstream(() => new Response("ok"));
    // The certificate does not cover c.test → hostname verification fails.
    const f = createSafeFetch({ allowedHosts: ["c.test"], lookup, testOverride: s.override });
    await expect(f("https://c.test/")).rejects.toThrow(SafeFetchError);
    // Another CA → the server certificate is not trusted.
    const other = testCertificate(["a.test"], "other-ca");
    const wrongCa = testTransportOverride({ ca: other.cert, connect: { address: "127.0.0.1", port: s.port } });
    await expect(createSafeFetch({ allowedHosts: ["a.test"], lookup, testOverride: wrongCa })("https://a.test/")).rejects.toThrow(SafeFetchError);
    expect(s.requests).toEqual([]);
  });

  it("honours only overrides created by testTransportOverride, which refuses to run outside tests", async () => {
    const seen: PinnedRequestOptions[] = [];
    const forged = Object.freeze({ ca: "-----BEGIN CERTIFICATE-----", connect: Object.freeze({ address: "127.0.0.1", port: 1 }) });
    const f = createSafeFetch({
      allowedHosts: ["a.test"],
      lookup,
      testOverride: forged,
      transport: async (_t, o) => (seen.push(o), { status: 200, headers: {}, body: Buffer.from("ok") }),
    });
    await f("https://a.test/");
    expect(seen[0]!.testOverride).toBeUndefined();
    const env = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST };
    try {
      process.env.NODE_ENV = "production";
      delete process.env.VITEST;
      expect(() => testTransportOverride({ ca: "x", connect: { address: "127.0.0.1", port: 1 } })).toThrow(/only available in tests/);
    } finally {
      process.env.NODE_ENV = env.NODE_ENV;
      if (env.VITEST !== undefined) process.env.VITEST = env.VITEST;
    }
  });
});
