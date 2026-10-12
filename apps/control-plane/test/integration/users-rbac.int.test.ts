import { Role, User } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, createUserClient, OWNER_PASSWORD, responseLog, startWithOwner, type TestApp } from "../support/app.js";
import { insertNode, insertServer, testPool } from "../support/db.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setupFleet(t: TestApp) {
  const pool = testPool();
  const nodeA = await insertNode(pool, { name: "node-a" });
  const nodeB = await insertNode(pool, { name: "node-b" });
  const srvA = await insertServer(pool, nodeA, { name: "srv-a" });
  const srvB = await insertServer(pool, nodeB, { name: "srv-b" });
  await t.ctx.tracker.load();
  return { nodeA, nodeB, srvA, srvB };
}

describe("users & roles", () => {
  it("lists built-in roles reconciled from the contracts", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const roles = Role.array().parse((await owner.get("/roles")).json());
    expect(roles.map((r) => r.key)).toEqual(["owner", "admin", "infra_admin", "network_admin", "server_admin", "moderator", "observer"]);
    expect(roles.find((r) => r.key === "moderator")?.permissions).not.toContain("servers.console.send");
    // Re-seeding is idempotent and removes permissions no longer in the contracts.
    const modId = roles.find((r) => r.key === "moderator")!.id;
    await testPool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'servers.console.send')", [modId]);
    await t.ctx.rbac.seedBuiltinRoles();
    await t.ctx.rbac.seedBuiltinRoles();
    const after = Role.array().parse((await owner.get("/roles")).json());
    expect(after.find((r) => r.key === "moderator")?.permissions).not.toContain("servers.console.send");
    expect(after).toHaveLength(7);
  });

  it("creates users with scoped roles, paginates and validates bindings", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { nodeA, srvA } = await setupFleet(t);
    const created = await owner.post("/users", {
      email: "Infra@Example.com",
      username: "infra",
      displayName: "Infra",
      password: "a long enough password",
      roles: [
        { roleKey: "infra_admin", scopeType: "node", scopeId: nodeA },
        { roleKey: "server_admin", scopeType: "server", scopeId: srvA },
      ],
    });
    expect(created.statusCode).toBe(201);
    const user = User.parse(created.json());
    expect(user.email).toBe("infra@example.com");
    expect(user.roles.map((r) => [r.roleKey, r.scopeName])).toEqual([
      ["infra_admin", "node-a"],
      ["server_admin", "srv-a"],
    ]);
    expect((await owner.post("/users", { email: "infra@example.com", username: "infra-dup", displayName: "Dup", password: "a long enough password" })).statusCode).toBe(409);

    const badScope = await owner.post(`/users/${user.id}/roles`, { roleKey: "observer", scopeType: "node", scopeId: "00000000-0000-4000-8000-000000000000" });
    expect(badScope.statusCode).toBe(400);
    const privilegedScoped = await owner.post(`/users/${user.id}/roles`, { roleKey: "admin", scopeType: "node", scopeId: nodeA });
    expect(privilegedScoped.statusCode).toBe(400);
    const globalMismatch = await owner.post(`/users/${user.id}/roles`, { roleKey: "observer", scopeType: "global", scopeId: nodeA });
    expect(globalMismatch.statusCode).toBe(400);
    expect((await owner.post(`/users/${user.id}/roles`, { roleKey: "infra_admin", scopeType: "node", scopeId: nodeA })).statusCode).toBe(409);

    for (let i = 0; i < 3; i++) await owner.post("/users", { email: `u${i}@example.com`, username: `user-${i}`, displayName: `U${i}`, password: "a long enough password" });
    const p1 = (await owner.get("/users?limit=2")).json();
    expect(p1.items).toHaveLength(2);
    const p2 = (await owner.get(`/users?limit=2&cursor=${p1.nextCursor}`)).json();
    const p3 = (await owner.get(`/users?limit=2&cursor=${p2.nextCursor}`)).json();
    const all = [...p1.items, ...p2.items, ...p3.items].map((u: { email: string }) => u.email);
    expect(new Set(all).size).toBe(5);
    expect(p3.nextCursor).toBeNull();
    expect((await owner.get("/users?cursor=garbage")).statusCode).toBe(400);
  });

  it("enforces the privileged-role rules and protects the last owner", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const admin = await createUserClient(t, owner, "admin@example.com", [{ roleKey: "admin", scopeType: "global", scopeId: null }]);
    const plain = (await owner.post("/users", { email: "plain@example.com", username: "plain", displayName: "Plain", password: "a long enough password" })).json();
    const ownerMe = (await owner.get("/auth/me")).json();
    const ownerId: string = ownerMe.user.id;
    const ownerBinding: string = ownerMe.user.roles[0].id;

    // Admins can manage normal users but not grant/revoke privileged roles or touch privileged accounts.
    expect((await admin.post(`/users/${plain.id}/roles`, { roleKey: "observer", scopeType: "global", scopeId: null })).statusCode).toBe(200);
    expect((await admin.post(`/users/${plain.id}/roles`, { roleKey: "owner", scopeType: "global", scopeId: null })).statusCode).toBe(403);
    expect((await admin.post(`/users/${plain.id}/roles`, { roleKey: "admin", scopeType: "global", scopeId: null })).statusCode).toBe(403);
    expect((await admin.post("/users", { email: "x@example.com", username: "xuser", displayName: "X", password: "a long enough password", roles: [{ roleKey: "admin", scopeType: "global", scopeId: null }] })).statusCode).toBe(403);
    expect((await admin.patch(`/users/${ownerId}`, { status: "disabled" })).statusCode).toBe(403);
    expect((await admin.post(`/users/${ownerId}/password`, { password: "hijacked password!!" })).statusCode).toBe(403);
    expect((await admin.delete(`/users/${ownerId}/roles/${ownerBinding}`)).statusCode).toBe(403);

    // The last owner cannot be removed or disable themselves.
    const last = await owner.delete(`/users/${ownerId}/roles/${ownerBinding}`);
    expect(last.statusCode).toBe(409);
    expect((await owner.patch(`/users/${ownerId}`, { status: "disabled" })).statusCode).toBe(400);

    // With a second owner the first owner role can go.
    const second = await owner.post(`/users/${plain.id}/roles`, { roleKey: "owner", scopeType: "global", scopeId: null });
    expect(second.statusCode).toBe(200);
    expect((await owner.delete(`/users/${ownerId}/roles/${ownerBinding}`)).statusCode).toBe(200);
  });

  it("disabling a user and resetting a password revokes their sessions", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const obs = await createUserClient(t, owner, "obs@example.com", [{ roleKey: "observer", scopeType: "global", scopeId: null }]);
    const id = (await obs.get("/auth/me")).json().user.id;
    expect((await owner.post(`/users/${id}/password`, { password: "new password for obs" })).statusCode).toBe(204);
    expect((await obs.get("/auth/me")).statusCode).toBe(401);
    const again = new ApiClient(t);
    expect((await again.login("obs@example.com", "new password for obs")).statusCode).toBe(200);
    expect((await owner.patch(`/users/${id}`, { status: "disabled" })).json().status).toBe("disabled");
    expect((await again.get("/auth/me")).statusCode).toBe(401);
    expect((await new ApiClient(t).login("obs@example.com", "new password for obs")).statusCode).toBe(401);
    expect((await owner.post(`/users/${id}/mfa/reset`)).statusCode).toBe(204);
  });
});

describe("cross-scope authorisation", () => {
  it("restricts node, metrics and user access to the granted scope and audits denials", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { nodeA, nodeB, srvA, srvB } = await setupFleet(t);
    const infra = await createUserClient(t, owner, "infra@example.com", [{ roleKey: "infra_admin", scopeType: "node", scopeId: nodeA }]);
    const srv = await createUserClient(t, owner, "srv@example.com", [{ roleKey: "server_admin", scopeType: "server", scopeId: srvA }]);

    const list = (await infra.get("/nodes")).json();
    expect(list.map((n: { id: string }) => n.id)).toEqual([nodeA]);
    expect((await infra.get(`/nodes/${nodeA}`)).statusCode).toBe(200);
    expect((await infra.get(`/nodes/${nodeB}`)).statusCode).toBe(403);
    expect((await infra.patch(`/nodes/${nodeB}`, { location: "x" })).statusCode).toBe(403);
    expect((await infra.patch(`/nodes/${nodeA}`, { location: "Rack 4" })).json().location).toBe("Rack 4");
    expect((await infra.get("/users")).statusCode).toBe(403);
    expect((await infra.get("/nodes/enrollment-tokens")).statusCode).toBe(403); // nodes.enroll is global-only
    // Deleting a node removes the grants scoped to it.
    const nodeC = await insertNode(testPool(), { name: "node-c" });
    await t.ctx.tracker.load();
    const infraId = (await infra.get("/auth/me")).json().user.id;
    await owner.post(`/users/${infraId}/roles`, { roleKey: "observer", scopeType: "node", scopeId: nodeC });
    expect((await owner.delete(`/nodes/${nodeC}`)).statusCode).toBe(204);
    expect((await owner.get(`/users/${infraId}`)).json().roles.map((r: { scopeId: string }) => r.scopeId)).toEqual([nodeA]);

    expect((await srv.get("/nodes")).statusCode).toBe(403);
    const now = Date.now();
    const q = (serverId: string) => `/metrics/range?series=server.cpu&serverId=${serverId}&from=${now - 600_000}&to=${now}`;
    expect((await srv.get(q(srvB))).statusCode).toBe(403);
    const okRange = await srv.get(q(srvA));
    expect(okRange.statusCode).toBe(200);
    expect(okRange.json()).toMatchObject({ series: "server.cpu", unit: "percent", lines: [] });
    expect((await srv.get(`/metrics/range?series=node.cpu.usage&nodeId=${nodeA}&from=${now - 60_000}&to=${now}`)).statusCode).toBe(403);
    expect((await srv.get("/overview")).statusCode).toBe(200);

    const denials = (await owner.get("/audit?action=authz.denied&limit=50")).json();
    const details = denials.items.map((e: { actorName: string; details: { permission: string } }) => `${e.actorName}:${e.details.permission}`);
    expect(details).toContain("infra@example.com:nodes.view");
    expect(details).toContain("infra@example.com:users.view");
    expect(details).toContain("srv@example.com:monitoring.view");
    expect(denials.items.every((e: { outcome: string }) => e.outcome === "denied")).toBe(true);
  });
});

describe("audit log", () => {
  it("is hash-chained, paginated, filterable and detects tampering", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    for (let i = 0; i < 3; i++) await owner.post("/users", { email: `a${i}@example.com`, username: `auser-${i}`, displayName: `A${i}`, password: "a long enough password" });
    const verify = (await owner.get("/audit/verify")).json();
    expect(verify.valid).toBe(true);
    expect(verify.checked).toBeGreaterThanOrEqual(4);

    const page1 = (await owner.get("/audit?limit=2")).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (await owner.get(`/audit?limit=2&cursor=${page1.nextCursor}`)).json();
    expect(Number(page2.items[0].id)).toBeLessThan(Number(page1.items[1].id));
    const creates = (await owner.get("/audit?action=user.create")).json();
    expect(creates.items).toHaveLength(3);
    expect((await owner.get("/audit?action=user.*")).json().items.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(creates)).not.toContain("a long enough password");

    const { rows } = await testPool().query("SELECT id FROM audit_events ORDER BY id LIMIT 1 OFFSET 2");
    const target = rows[0].id as number;
    await testPool().query("UPDATE audit_events SET details = '{\"tampered\":true}' WHERE id = $1", [target]);
    const broken = (await owner.get("/audit/verify")).json();
    expect(broken).toMatchObject({ valid: false, firstBrokenId: String(target) });
  });

  it("never echoes passwords in any response", async () => {
    ({ t } = await startWithOwner());
    const leaks = responseLog.filter((r) => r.body.includes(OWNER_PASSWORD) || r.body.includes("a long enough password"));
    expect(leaks).toEqual([]);
  });
});

describe("settings", () => {
  it("reads and writes known settings with settings.manage only", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    expect((await owner.get("/settings/notifications.webhookAllowlist")).json()).toEqual({ key: "notifications.webhookAllowlist", value: [] });
    const put = await owner.put("/settings/notifications.webhookAllowlist", { value: ["CI.internal"] });
    expect(put.json()).toEqual({ key: "notifications.webhookAllowlist", value: ["ci.internal"] });
    expect((await owner.put("/settings/notifications.webhookAllowlist", { value: ["bad host!"] })).statusCode).toBe(400);
    expect((await owner.get("/settings/unknown.key")).statusCode).toBe(404);
    const infra = await createUserClient(t, owner, "infra2@example.com", [{ roleKey: "infra_admin", scopeType: "global", scopeId: null }]);
    expect((await infra.get("/settings/notifications.webhookAllowlist")).statusCode).toBe(403);
    expect((await owner.get("/audit?action=settings.update")).json().items).toHaveLength(1);
  });
});
