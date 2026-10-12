import { createHash } from "node:crypto";
import type { ApiKey} from "@blockforge/contracts";
import { API_KEY_PATTERN, CreatedApiKey } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createUserClient, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import { TEST_PUBLIC_URL } from "../support/env.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { catalogOptions, connectSimNode, paperRequest, templateIdByKey, waitJob } from "../support/panel.js";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

function keyClient(t: TestApp, secret: string) {
  const req = (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, body?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${secret}`, ...headers }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { get: (u: string, h?: Record<string, string>) => req("GET", u, undefined, h), post: (u: string, b: unknown = {}) => req("POST", u, b), delete: (u: string) => req("DELETE", u) };
}

async function createKey(c: ApiClient, body: Record<string, unknown>) {
  const r = await c.post("/account/api-keys", body);
  expect(r.statusCode, r.body).toBe(201);
  return CreatedApiKey.parse(r.json());
}

describe("personal API keys", () => {
  it("authenticate with Bearer (no CSRF), are hashed at rest, audited as api_token and revocable", async () => {
    const r = await startWithOwner();
    t = r.t;
    const owner = r.owner;
    const created = await createKey(owner, { name: "CI", expiresInDays: 30 });
    expect(created.secret).toMatch(API_KEY_PATTERN);
    expect(created.secret.startsWith(`${created.key.prefix}_`)).toBe(true);
    expect(created.key).toMatchObject({ name: "CI", permissions: null, allowedIps: [], lastUsedAt: null });
    expect(created.key.expiresAt! - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const listed = (await owner.get("/account/api-keys")).json() as ApiKey[];
    expect(listed.map((k) => k.id)).toEqual([created.key.id]);
    const secretPart = API_KEY_PATTERN.exec(created.secret)![2]!;
    expect(JSON.stringify(listed)).not.toContain(secretPart);
    const { rows } = await testPool().query("SELECT token_hash FROM api_tokens WHERE id = $1", [created.key.id]);
    expect(rows[0].token_hash).toBe(createHash("sha256").update(secretPart).digest("hex"));

    const k = keyClient(r.t, created.secret);
    expect((await k.get("/servers")).statusCode).toBe(200);
    // State-changing request without any CSRF header.
    const token = await k.post("/nodes/enrollment-tokens", { label: "via key" });
    expect(token.statusCode, token.body).toBe(201);
    const { rows: audit } = await testPool().query("SELECT actor_type, actor_id, actor_name FROM audit_events WHERE action = 'node.enrollment_token.create' ORDER BY id DESC LIMIT 1");
    expect(audit[0]).toMatchObject({ actor_type: "api_token", actor_id: created.key.id });
    expect(audit[0].actor_name).toContain(created.key.prefix);
    const { rows: tok } = await testPool().query("SELECT created_by FROM enrollment_tokens ORDER BY created_at DESC LIMIT 1");
    expect(tok[0].created_by).toBe((await owner.get("/auth/me")).json().user.id);
    await new Promise((res) => setTimeout(res, 50));
    expect(((await owner.get("/account/api-keys")).json() as ApiKey[])[0]).toMatchObject({ lastUsedIp: "127.0.0.1" });

    // Never: settings.manage (forbidden for keys), account routes, authentication routes, realtime.
    expect((await owner.get("/settings/notifications.webhookAllowlist")).statusCode).toBe(200);
    expect((await k.get("/settings/notifications.webhookAllowlist")).statusCode).toBe(403);
    expect((await k.get("/account/api-keys")).statusCode).toBe(403);
    expect((await k.post("/account/api-keys", { name: "escalate" })).statusCode).toBe(403);
    expect((await k.get("/auth/me")).statusCode).toBe(403);
    const ws = await new Promise<number>((resolve) => {
      const s = new WebSocket(`${r.t.wsBaseUrl}/api/v1/realtime`, { headers: { authorization: `Bearer ${created.secret}`, origin: TEST_PUBLIC_URL } });
      s.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      s.on("open", () => (s.close(), resolve(101)));
      s.on("error", () => resolve(-1));
    });
    expect(ws).toBe(403);

    // Malformed / unknown / wrong secret → 401.
    expect((await keyClient(r.t, "bfk_nope").get("/servers")).statusCode).toBe(401);
    expect((await keyClient(r.t, `${created.key.prefix}_${"A".repeat(43)}`).get("/servers")).statusCode).toBe(401);

    // Revocation.
    expect((await owner.delete(`/account/api-keys/${created.key.id}`)).statusCode).toBe(204);
    expect((await k.get("/servers")).statusCode).toBe(401);
    const { rows: revoked } = await testPool().query("SELECT action FROM audit_events WHERE action LIKE 'account.api_key.%' ORDER BY id");
    expect(revoked.map((x) => x.action)).toEqual(["account.api_key.create", "account.api_key.revoke"]);
  });

  it("limits keys to their permissions ∩ the owner's current effective permissions, IPs and expiry", async () => {
    const cat = catalogOptions();
    const r = await startWithOwner({ background: true, catalog: cat.catalog, serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 } });
    t = r.t;
    const owner = r.owner;
    // Creation: forbidden permissions and permissions the owner does not hold are refused.
    expect((await owner.post("/account/api-keys", { name: "x", permissions: ["settings.manage"] })).statusCode).toBe(400);
    const alice = await createUserClient(r.t, owner, "alice@example.com", [{ roleKey: "observer", scopeType: "global", scopeId: null }]);
    expect((await alice.post("/account/api-keys", { name: "x", permissions: ["nodes.manage"] })).statusCode).toBe(400);

    // Scoped key: servers.view only.
    const narrow = keyClient(r.t, (await createKey(owner, { name: "narrow", permissions: ["servers.view"] })).secret);
    expect((await narrow.get("/servers")).statusCode).toBe(200);
    expect((await narrow.get("/nodes")).statusCode).toBe(403);

    // The owner's current permissions are re-evaluated per request.
    const aliceKey = keyClient(r.t, (await createKey(alice, { name: "all" })).secret);
    expect((await aliceKey.get("/nodes")).statusCode).toBe(200);
    const aliceId = (await alice.get("/auth/me")).json().user.id as string;
    const binding = (await owner.get(`/users/${aliceId}`)).json().roles[0];
    expect((await owner.delete(`/users/${aliceId}/roles/${binding.id}`)).statusCode).toBe(200);
    expect((await aliceKey.get("/nodes")).statusCode).toBe(403);

    // Ownership counts, but only within the key's permission set.
    const node = await connectSimNode(r.t, owner, { agents });
    const created = await owner.post("/servers", paperRequest(await templateIdByKey(owner, "minecraft-java"), { ownerId: aliceId, startup: "manual" }));
    const id = created.json().server.id as string;
    await waitJob(owner, created.json().jobId);
    const viewKey = keyClient(r.t, (await createKey(alice, { name: "view", permissions: ["servers.view", "jobs.view"] })).secret);
    expect((await viewKey.get(`/servers/${id}`)).statusCode).toBe(200);
    expect((await viewKey.get(`/jobs/${created.json().jobId}`)).statusCode).toBe(200);
    expect((await viewKey.post(`/servers/${id}/actions`, { action: "start" })).statusCode).toBe(403);
    // Transfer URLs are bound to the key (no browser session involved).
    node.sim.put(id, "notes.txt", "hello from the key");
    const reader = (await createKey(alice, { name: "reader", permissions: ["servers.view", "servers.files.read"] })).secret;
    const dl = (await keyClient(r.t, reader).get(`/servers/${id}/files/download-url?path=notes.txt`)).json() as { url: string };
    const got = await r.t.app.inject({ method: "GET", url: dl.url, headers: { authorization: `Bearer ${reader}` } });
    expect(got.statusCode).toBe(200);
    expect(got.body).toBe("hello from the key");
    const dl2 = (await keyClient(r.t, reader).get(`/servers/${id}/files/download-url?path=notes.txt`)).json() as { url: string };
    expect((await r.t.app.inject({ method: "GET", url: dl2.url, headers: { authorization: `Bearer ${(await createKey(alice, { name: "other" })).secret}` } })).statusCode).toBe(404);
    const filesOnly = keyClient(r.t, (await createKey(alice, { name: "files", permissions: ["servers.files.read"] })).secret);
    expect((await filesOnly.get(`/servers/${id}`)).statusCode).toBe(404);
    expect((await filesOnly.get("/servers")).json().items).toEqual([]);

    // IP allowlist (CIDR; IPv4-mapped IPv6 matches IPv4).
    const lan = keyClient(r.t, (await createKey(owner, { name: "lan", allowedIps: ["10.0.0.0/8"] })).secret);
    expect((await lan.get("/servers")).statusCode).toBe(403);
    const local = keyClient(r.t, (await createKey(owner, { name: "local", allowedIps: ["127.0.0.0/8", "::1/128"] })).secret);
    expect((await local.get("/servers")).statusCode).toBe(200);
    expect((await owner.post("/account/api-keys", { name: "bad", allowedIps: ["300.1.1.1"] })).statusCode).toBe(400);

    // Expiry.
    const exp = await createKey(owner, { name: "short", expiresInDays: 1 });
    await testPool().query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [exp.key.id]);
    expect((await keyClient(r.t, exp.secret).get("/servers")).statusCode).toBe(401);
  });

  it("rate-limits each key", async () => {
    const r = await startWithOwner({ env: { API_KEY_RATE_LIMIT_PER_MIN: "3" } });
    t = r.t;
    const k = keyClient(r.t, (await createKey(r.owner, { name: "busy" })).secret);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await k.get("/servers")).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429]);
    // Another key is unaffected; the session still works.
    const other = keyClient(r.t, (await createKey(r.owner, { name: "other" })).secret);
    expect((await other.get("/servers")).statusCode).toBe(200);
    expect((await r.owner.get("/servers")).statusCode).toBe(200);
  });
});
