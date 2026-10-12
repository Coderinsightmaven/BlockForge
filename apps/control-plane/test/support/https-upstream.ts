import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTransportOverride, type TestTransportOverride } from "../../src/catalog/safe-fetch.js";

/** Hostnames the local test upstream presents a certificate for. */
export const TEST_UPSTREAM_HOSTS = ["api.modrinth.com", "api.mojang.com", "a.test", "b.test"] as const;

function openssl(): string {
  const candidates = ["openssl", "C:/Program Files/Git/mingw64/bin/openssl.exe", "C:/Program Files/Git/usr/bin/openssl.exe"];
  for (const c of candidates) {
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      // next
    }
  }
  throw new Error("openssl is needed to create the test TLS certificate (install it or put it on PATH)");
}

/**
 * A self-signed certificate (P-256, 2 days) for `hosts`, created with the openssl CLI (Node cannot
 * build X.509 certificates) and cached in the temp directory for the test run. Test-only key material,
 * never committed.
 */
export function testCertificate(hosts: readonly string[] = TEST_UPSTREAM_HOSTS, name = "upstream"): { cert: string; key: string } {
  const dir = join(tmpdir(), `blockforge-test-tls-${createHash("sha256").update(`${name}:${hosts.join(",")}:${new Date().toISOString().slice(0, 10)}`).digest("hex").slice(0, 12)}`);
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  if (!existsSync(cert) || !existsSync(key)) {
    mkdirSync(dir, { recursive: true });
    execFileSync(
      openssl(),
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=BlockForge test ${name}`,
        "-addext", `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(",")}`,
      ],
      { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
    );
  }
  return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpsUpstream {
  port: number;
  /** Trust the test certificate and connect every pinned request here (TLS verified for the hostname). */
  override: TestTransportOverride;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * A local HTTPS server standing in for upstream APIs: each request becomes a `Request` for `handler`
 * (so the fake upstreams see exactly what the real transport sent: method, headers, body).
 */
export async function startHttpsUpstream(handler: (url: string, init: RequestInit) => Promise<Response> | Response, opts: { hold?: (url: string) => boolean } = {}): Promise<HttpsUpstream> {
  const { cert, key } = testCertificate();
  const requests: RecordedRequest[] = [];
  const server: Server = createServer({ cert, key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      const url = `https://${host}${req.url ?? "/"}`;
      const body = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      requests.push({ method: req.method ?? "GET", url, headers, body });
      if (opts.hold?.(url)) return; // never answer (timeouts)
      void (async () => {
        try {
          const r = await handler(url, { method: req.method ?? "GET", headers, ...(body ? { body } : {}) });
          const out: Record<string, string> = {};
          r.headers.forEach((v, k) => (out[k] = v));
          const data = Buffer.from(await r.arrayBuffer());
          res.writeHead(r.status, out);
          res.end(data);
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    override: testTransportOverride({ ca: cert, connect: { address: "127.0.0.1", port } }),
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
