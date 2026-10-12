import { randomUUID } from "node:crypto";
import { Server, TransferUrlResponse, type Template } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, responseLog, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { catalogOptions, connectSimNode, eggFixture, paperRequest, poll, templateIdByKey, waitJob, type SimNodeHandle } from "../support/panel.js";
import { UiSocket } from "../support/realtime-client.js";

/** Regression tests for the Codex review of the Phase 3 control plane (docs/reviews/2026-10-12-control-plane-phase3.md). */

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
const sockets: UiSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

async function boot() {
  const cat = catalogOptions();
  const r = await startWithOwner({ background: true, catalog: cat.catalog, serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 } });
  t = r.t;
  return r;
}

async function importVanilla(owner: ApiClient, patch: (tpl: Template) => Partial<Template> = () => ({})): Promise<Template> {
  const imported = await owner.post("/templates/import", { egg: eggFixture("ptero-egg-vanilla-minecraft.json"), category: "Minecraft" });
  expect(imported.statusCode, imported.body).toBe(201);
  const tpl = imported.json().template as Template;
  const changes = patch(tpl);
  if (!Object.keys(changes).length) return tpl;
  const res = await owner.patch(`/templates/${tpl.id}`, changes);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Template;
}

function eggBody(templateId: string, over: Record<string, unknown> = {}, variables: Record<string, string> = {}): Record<string, unknown> {
  return {
    name: "Egg",
    slug: `egg-${randomUUID().slice(0, 6)}`,
    templateId,
    placement: { mode: "auto" },
    memoryLimitBytes: 2 * 1024 ** 3,
    egg: { variables: { VANILLA_VERSION: "1.21.11", ...variables }, acceptEula: true },
    ...over,
  };
}

const code = async (res: Promise<{ statusCode: number; json(): { error?: { code: string } } }>) => {
  const r = await res;
  return `${r.statusCode} ${r.json().error?.code ?? ""}`.trim();
};

describe("#1 /servers list honours servers.view of subusers", () => {
  it("does not list servers where a subuser grant lacks servers.view", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    const templateId = await templateIdByKey(owner, "minecraft-java");
    const created = await owner.post("/servers", paperRequest(templateId, { startup: "manual" }));
    const id = created.json().server.id as string;
    await waitJob(owner, created.json().jobId);
    const eve = await createUserClient(t, owner, "eve@example.com", []);
    const eveId = (await eve.get("/auth/me")).json().user.id as string;
    // A grant without servers.view (written directly: the API would accept it, it is just useless).
    await testPool().query("INSERT INTO server_subusers (id, server_id, user_id, permissions) VALUES ($1, $2, $3, $4)", [randomUUID(), id, eveId, ["servers.files.read"]]);
    expect((await eve.get("/servers")).json().items).toEqual([]);
    expect((await eve.get("/servers?filter=mine")).json().items).toEqual([]);
    expect((await eve.get(`/servers/${id}`)).statusCode).toBe(404);
    await testPool().query("UPDATE server_subusers SET permissions = $1 WHERE user_id = $2", [["servers.view", "servers.files.read"], eveId]);
    expect((await eve.get("/servers")).json().items.map((s: Server) => s.id)).toEqual([id]);
  });
});

describe("#2 non-editable egg variables need servers.admin on the target", () => {
  it("checks servers.admin against the chosen node, not anywhere", async () => {
    const { t, owner } = await boot();
    const nodeA = await connectSimNode(t, owner, { agents, name: "node-a", sim: { installCreates: { "server.jar": "x" } } });
    const nodeB = await connectSimNode(t, owner, { agents, name: "node-b", sim: { installCreates: { "server.jar": "x" } } });
    const tpl = await importVanilla(owner, (x) => ({ variables: x.variables.map((v) => (v.envName === "VANILLA_VERSION" ? { ...v, userEditable: false } : v)) }));
    // bob: servers.create everywhere (network_admin), servers.admin only on node A (custom role).
    const bob = await createUserClient(t, owner, "bob@example.com", [{ roleKey: "network_admin", scopeType: "global", scopeId: null }]);
    const bobId = (await bob.get("/auth/me")).json().user.id as string;
    const roleId = randomUUID();
    await testPool().query("INSERT INTO roles (id, key, name) VALUES ($1, 'node-server-admin', 'Node server admin')", [roleId]);
    await testPool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'servers.admin'), ($1, 'servers.view')", [roleId]);
    await testPool().query("INSERT INTO role_bindings (id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'node', $4)", [randomUUID(), bobId, roleId, nodeA.nodeId]);
    const alice = await createUserClient(t, owner, "alice@example.com", [{ roleKey: "network_admin", scopeType: "global", scopeId: null }]);

    const onB = await bob.post("/servers", eggBody(tpl.id, { placement: { mode: "node", nodeId: nodeB.nodeId } }));
    expect(onB.statusCode, onB.body).toBe(403);
    expect(JSON.stringify(onB.json().error.details)).toContain("egg.variables.VANILLA_VERSION");
    const onA = await bob.post("/servers", eggBody(tpl.id, { placement: { mode: "node", nodeId: nodeA.nodeId } }));
    expect(onA.statusCode, onA.body).toBe(202);
    // Auto placement only considers nodes where bob may set the variable.
    const auto = await bob.post("/servers", eggBody(tpl.id));
    expect(auto.statusCode, auto.body).toBe(202);
    expect(auto.json().server.nodeId).toBe(nodeA.nodeId);
    // Without servers.admin anywhere: a validation error, as before.
    const none = await alice.post("/servers", eggBody(tpl.id));
    expect(none.statusCode).toBe(400);
    expect(JSON.stringify(none.json().error.details)).toContain("not editable");
    // Editable variables are fine for everyone.
    const editable = await alice.post("/servers", { ...eggBody(tpl.id), egg: { variables: { SERVER_JARFILE: "server.jar" }, acceptEula: true } });
    expect(editable.statusCode, editable.body).toBe(202);
    // Startup edits use the effective permissions on the server itself.
    const bobServer = onA.json().server.id as string;
    expect((await bob.put(`/servers/${bobServer}/startup/variables`, { envName: "VANILLA_VERSION", value: "1.21.10" })).statusCode).toBe(200);
  });
});

describe("#3 secret variable values never reach console, realtime or job logs", () => {
  it("masks non-viewable variable values (and base64) in install output and runtime console lines", async () => {
    const { t, owner } = await boot();
    const SECRET = "S3cr3t-Passw0rd!";
    const B64 = Buffer.from(SECRET).toString("base64").replace(/=+$/, "");
    const node = await connectSimNode(t, owner, {
      agents,
      sim: { installCreates: { "server.jar": "x" }, installLines: [`connecting with password ${SECRET}`, `auth header ${B64}`, "done"] },
    });
    const tpl = await importVanilla(owner, (x) => ({
      variables: [...x.variables, { envName: "DB_PASSWORD", name: "Database password", description: "", defaultValue: "", userViewable: false, userEditable: false, rules: "nullable|string|max:64", sortOrder: 9 }],
    }));
    const created = await owner.post("/servers", eggBody(tpl.id, {}, { DB_PASSWORD: SECRET }));
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().server.id as string;
    expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
    const logs = JSON.stringify((await owner.get(`/jobs/${created.json().jobId}/logs`)).json());
    expect(logs).toContain("[install] connecting with password ••••••");
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain(B64);
    const history = JSON.stringify((await owner.get(`/servers/${id}/console/history?lines=200`)).json());
    expect(history).toContain("••••••");
    expect(history).not.toContain(SECRET);
    expect(history).not.toContain(B64);

    // Runtime console lines over the realtime topic.
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    expect((await ui.subscribe(`console:${id}`)).op).toBe("subscribed");
    node.agent.logs(id, [{ ts: Date.now(), stream: "stdout", line: `[Server] db password is ${SECRET}` }]);
    const frame = await ui.waitForEvent(`console:${id}`, "console.lines", 5000, (d) => JSON.stringify(d).includes("db password"));
    expect(JSON.stringify(frame.data)).toContain("db password is ••••••");
    expect(JSON.stringify(frame.data)).not.toContain(SECRET);

    // A changed value is masked immediately (cache invalidated).
    const NEXT = "N3w-Secret-Value";
    expect((await owner.put(`/servers/${id}/startup/variables`, { envName: "DB_PASSWORD", value: NEXT })).statusCode).toBe(200);
    node.agent.logs(id, [{ ts: Date.now(), stream: "stdout", line: `rotated to ${NEXT}` }]);
    const rotated = await ui.waitForEvent(`console:${id}`, "console.lines", 5000, (d) => JSON.stringify(d).includes("rotated to"));
    expect(JSON.stringify(rotated.data)).not.toContain(NEXT);

    // Failing installs write the agent's log tail into the job log: masked too.
    node.sim.options = { installExitCode: 1, installLines: [`fatal: bad password ${NEXT}`] };
    const stop = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    await waitJob(owner, stop.json().jobId);
    const re = await owner.post(`/servers/${id}/reinstall`);
    expect((await waitJob(owner, re.json().jobId)).status).toBe("failed");
    const reLogs = JSON.stringify((await owner.get(`/jobs/${re.json().jobId}/logs`)).json());
    expect(reLogs).toContain("fatal: bad password ••••••");
    expect(reLogs).not.toContain(NEXT);
    // Only the startup view of an administrator (servers.admin) may show non-viewable values.
    const leaks = responseLog.filter((r) => !r.url.includes("/startup") && (r.body.includes(SECRET) || r.body.includes(NEXT)));
    expect(leaks.map((r) => r.url)).toEqual([]);
  });
});

describe("#5 transfer URLs re-check access when used", () => {
  it("refuses a URL after the grant was revoked or the server was suspended", async () => {
    const { t, owner } = await boot();
    const node: SimNodeHandle = await connectSimNode(t, owner, { agents, sim: { installCreates: { "server.jar": "x" } } });
    const tpl = await importVanilla(owner);
    const created = await owner.post("/servers", eggBody(tpl.id, { startup: "manual" }));
    const id = created.json().server.id as string;
    await waitJob(owner, created.json().jobId);
    node.sim.put(id, "notes.txt", "hello");
    const carol = await createUserClient(t, owner, "carol@example.com", []);
    const sub = await owner.post(`/servers/${id}/subusers`, { user: "carol", permissions: ["servers.view", "servers.files.read", "servers.files.write"] });
    expect(sub.statusCode).toBe(201);

    const down = TransferUrlResponse.parse((await carol.get(`/servers/${id}/files/download-url?path=notes.txt`)).json());
    const up = TransferUrlResponse.parse((await carol.post(`/servers/${id}/files/upload-url`, { directory: "", fileName: "up.txt", size: 2 })).json());
    // Write permission revoked after the URLs were issued.
    expect((await owner.put(`/servers/${id}/subusers/${sub.json().id}`, { permissions: ["servers.view"] })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: down.url, headers: { cookie: carol.cookieHeader() } })).statusCode).toBe(403);
    const put = await t.app.inject({ method: "PUT", url: up.url, headers: { cookie: carol.cookieHeader(), "content-type": "application/octet-stream" }, payload: Buffer.from("hi") });
    expect(put.statusCode).toBe(403);
    expect(node.sim.read(id, "up.txt")).toBeNull();

    // Suspension between issue and use.
    expect((await owner.put(`/servers/${id}/subusers/${sub.json().id}`, { permissions: ["servers.view", "servers.files.read"] })).statusCode).toBe(200);
    const down2 = TransferUrlResponse.parse((await carol.get(`/servers/${id}/files/download-url?path=notes.txt`)).json());
    expect((await owner.post(`/servers/${id}/suspend`)).statusCode).toBe(200);
    const blocked = await t.app.inject({ method: "GET", url: down2.url, headers: { cookie: carol.cookieHeader() } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/suspended/);
    // Removed entirely: the server is not revealed.
    expect((await owner.post(`/servers/${id}/unsuspend`)).statusCode).toBe(200);
    const down3 = TransferUrlResponse.parse((await carol.get(`/servers/${id}/files/download-url?path=notes.txt`)).json());
    expect((await owner.delete(`/servers/${id}/subusers/${sub.json().id}`)).statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: down3.url, headers: { cookie: carol.cookieHeader() } })).statusCode).toBe(404);
  });
});

describe("#6 failed or cancelled initial provisioning releases its resources", () => {
  async function resources(id: string) {
    const { rows: a } = await testPool().query("SELECT count(*)::int AS n FROM allocations WHERE server_id = $1", [id]);
    const { rows: r } = await testPool().query("SELECT kind FROM resource_reservations WHERE server_id = $1", [id]);
    return { allocations: a[0].n as number, reservations: r.map((x) => x.kind as string) };
  }

  it("releases allocation and hold on failure, re-acquires on re-provision, and lets the owner delete it", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents, ports: "25565", sim: { installExitCode: 2 } });
    const tpl = await importVanilla(owner);
    const alice = await createUserClient(t, owner, "alice@example.com", []);
    const aliceId = (await alice.get("/auth/me")).json().user.id as string;
    const created = await owner.post("/servers", eggBody(tpl.id, { ownerId: aliceId }));
    const id = created.json().server.id as string;
    expect((await waitJob(owner, created.json().jobId)).status).toBe("failed");
    expect(Server.parse((await alice.get(`/servers/${id}`)).json())).toMatchObject({ state: "provision_failed", address: null });
    expect(await resources(id)).toEqual({ allocations: 0, reservations: [] });
    // The single port is free again for another server.
    node.sim.options = { installCreates: { "server.jar": "x" } };
    const other = await owner.post("/servers", eggBody(tpl.id, { startup: "manual" }));
    expect(other.statusCode, other.body).toBe(202);
    await waitJob(owner, other.json().jobId);
    // Re-provision needs a free allocation: none left → refused, nothing changes.
    expect(await code(owner.post(`/servers/${id}/reinstall`))).toBe("422 CAPACITY_EXCEEDED");
    expect(Server.parse((await alice.get(`/servers/${id}`)).json()).state).toBe("provision_failed");
    expect((await owner.post(`/nodes/${node.nodeId}/allocations`, { ip: "10.0.0.5", ports: "25566" })).statusCode).toBe(201);
    const re = await owner.post(`/servers/${id}/reinstall`);
    expect(re.statusCode, re.body).toBe(202);
    expect((await waitJob(owner, re.json().jobId)).status).toBe("succeeded");
    expect(await resources(id)).toEqual({ allocations: 1, reservations: ["server"] });

    // A second server failing: its owner (no servers.delete in the owner set) may delete it.
    node.sim.options = { installExitCode: 2 };
    expect((await owner.post(`/nodes/${node.nodeId}/allocations`, { ip: "10.0.0.5", ports: "25567" })).statusCode).toBe(201);
    const failed = await owner.post("/servers", eggBody(tpl.id, { ownerId: aliceId }));
    const failedId = failed.json().server.id as string;
    expect((await waitJob(owner, failed.json().jobId)).status).toBe("failed");
    expect(Server.parse((await alice.get(`/servers/${failedId}`)).json()).myPermissions).toContain("servers.delete");
    expect(Server.parse((await alice.get(`/servers/${id}`)).json()).myPermissions).not.toContain("servers.delete");
    const del = await alice.delete(`/servers/${failedId}`);
    expect(del.statusCode, del.body).toBe(202);
    expect((await waitJob(owner, del.json().jobId)).status).toBe("succeeded");
    expect((await alice.get(`/servers/${failedId}`)).statusCode).toBe(404);
  });

  it("releases resources when provisioning is cancelled", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents, sim: { installCreates: { "server.jar": "x" }, delay: { "workload.install": 4000 } } });
    const tpl = await importVanilla(owner);
    const created = await owner.post("/servers", eggBody(tpl.id));
    const id = created.json().server.id as string;
    const jobId = created.json().jobId as string;
    await poll(async () => ((await owner.get(`/jobs/${jobId}`)).json().steps as { key: string; status: string }[]).some((s) => s.key === "install" && s.status === "running"));
    expect((await owner.post(`/jobs/${jobId}/cancel`)).statusCode).toBe(200);
    expect((await waitJob(owner, jobId)).status).toBe("cancelled");
    expect(Server.parse((await owner.get(`/servers/${id}`)).json()).state).toBe("provision_failed");
    expect(await resources(id)).toEqual({ allocations: 0, reservations: [] });
  });
});

describe("#7 /build checks capacity under the node lock", () => {
  it("refuses growing past the node's capacity unless an admin overrides (audited)", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents });
    const templateId = await templateIdByKey(owner, "minecraft-java");
    const created = await owner.post("/servers", paperRequest(templateId, { startup: "manual" }));
    const id = created.json().server.id as string;
    await waitJob(owner, created.json().jobId);
    const huge = 512 * 1024 ** 3;
    const refused = await owner.patch(`/servers/${id}/build`, { memoryLimitBytes: huge });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(JSON.stringify(refused.json().error.details)).toContain("not enough memory");
    // A user with servers.admin on the node but without nodes.manage cannot override.
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    const bobId = (await bob.get("/auth/me")).json().user.id as string;
    const roleId = randomUUID();
    await testPool().query("INSERT INTO roles (id, key, name) VALUES ($1, 'node-server-admin', 'Node server admin')", [roleId]);
    await testPool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'servers.admin'), ($1, 'servers.view')", [roleId]);
    await testPool().query("INSERT INTO role_bindings (id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'node', $4)", [randomUUID(), bobId, roleId, node.nodeId]);
    expect(await code(bob.patch(`/servers/${id}/build`, { memoryLimitBytes: huge, overrideCapacity: true }))).toBe("403 FORBIDDEN");
    // Shrinking or staying within capacity needs no override.
    expect((await bob.patch(`/servers/${id}/build`, { memoryLimitBytes: 3 * 1024 ** 3 })).statusCode).toBe(200);
    const ok = await owner.patch(`/servers/${id}/build`, { memoryLimitBytes: huge, overrideCapacity: true });
    expect(ok.statusCode, ok.body).toBe(200);
    const { rows } = await testPool().query("SELECT details FROM audit_events WHERE action = 'server.build.override' AND target_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].details)).toContain("not enough memory");
    const { rows: res } = await testPool().query("SELECT memory_bytes FROM resource_reservations WHERE server_id = $1", [id]);
    expect(Number(res[0].memory_bytes)).toBe(huge);
  });
});

describe("idempotency keys cover the query string (Grok web review)", () => {
  it("refuses DELETE ?deleteData=false under a key first used with ?deleteData=true", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    const templateId = await templateIdByKey(owner, "minecraft-java");
    const created = await owner.post("/servers", paperRequest(templateId, { startup: "manual" }));
    const id = created.json().server.id as string;
    await waitJob(owner, created.json().jobId);
    const first = await owner.request("DELETE", `/servers/${id}?deleteData=true`, undefined, { "idempotency-key": "del-1" });
    expect(first.statusCode, first.body).toBe(202);
    const other = await owner.request("DELETE", `/servers/${id}?deleteData=false`, undefined, { "idempotency-key": "del-1" });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("CONFLICT");
    // The same query replays the stored response.
    const replay = await owner.request("DELETE", `/servers/${id}?deleteData=true`, undefined, { "idempotency-key": "del-1" });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().jobId).toBe(first.json().jobId);
    const { rows } = await testPool().query("SELECT input_data FROM jobs WHERE id = $1", [first.json().jobId]);
    expect(rows[0].input_data).toMatchObject({ deleteData: true });
  });
});
