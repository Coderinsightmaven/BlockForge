import type { Allocation} from "@blockforge/contracts";
import { ArtifactPlan, Template, TemplateImportPreview } from "@blockforge/contracts";
import { parseEgg } from "@blockforge/eggs";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, startWithOwner, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { catalogOptions, connectSimNode, eggFixture, paperRequest, templateIdByKey, waitJob } from "../support/panel.js";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

describe("templates", () => {
  it("seeds built-ins, previews, imports, edits, exports, replaces and deletes egg templates", async () => {
    const r = await startWithOwner();
    t = r.t;
    const owner = r.owner;
    const list = (await owner.get("/templates")).json() as { key: string; source: string }[];
    expect(list.map((x) => x.key).sort()).toEqual(["minecraft-java", "velocity"]);

    const egg = eggFixture("ptero-egg-teamspeak3-server.json");
    const preview = TemplateImportPreview.parse((await owner.post("/templates/import/preview", { egg, category: "Voice" })).json());
    expect(preview.template).toMatchObject({ kind: "egg", source: "import", category: "Voice" });
    const broken = TemplateImportPreview.parse((await owner.post("/templates/import/preview", { egg: { name: "x" }, category: "Voice" })).json());
    expect(broken.template).toBeNull();
    expect(broken.issues.some((i) => i.severity === "error")).toBe(true);
    expect((await owner.post("/templates/import", { egg: { name: "x" }, category: "Voice" })).statusCode).toBe(400);

    const imported = await owner.post("/templates/import", { egg, category: "Voice" });
    expect(imported.statusCode, imported.body).toBe(201);
    const tpl = Template.parse(imported.json().template);
    expect(tpl.variables.length).toBeGreaterThan(0);
    // A second import gets a fresh key.
    const again = Template.parse((await owner.post("/templates/import", { egg, category: "Voice" })).json().template);
    expect(again.key).not.toBe(tpl.key);

    const patched = await owner.patch(`/templates/${tpl.id}`, { name: "TeamSpeak", fileDenylist: ["*.sqlitedb"], startupDone: ["listening on"] });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(Template.parse(patched.json())).toMatchObject({ name: "TeamSpeak", fileDenylist: ["*.sqlitedb"], startupDone: ["listening on"] });
    expect((await owner.patch(`/templates/${tpl.id}`, { dockerImages: [{ label: "x", image: "not a valid ref!" }] })).statusCode).toBe(400);

    // Built-ins: only presentation fields are editable.
    const builtin = await templateIdByKey(owner, "minecraft-java");
    expect((await owner.patch(`/templates/${builtin}`, { description: "Java Edition" })).statusCode).toBe(200);
    expect((await owner.patch(`/templates/${builtin}`, { startup: "rm -rf /" })).statusCode).toBe(400);
    expect((await owner.delete(`/templates/${builtin}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await owner.post("/templates/import", { egg, category: "Voice", replaceKey: "minecraft-java" })).statusCode).toBe(400);

    // Export round-trips through the egg parser.
    const exported = await owner.get(`/templates/${tpl.id}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toMatch(/^attachment; filename="egg-TeamSpeak\.json"$/);
    const reparsed = parseEgg(exported.json(), { category: "Voice" });
    expect(reparsed.issues.filter((i) => i.severity === "error"), JSON.stringify(reparsed.issues)).toEqual([]);
    expect(reparsed.template).toMatchObject({ name: "TeamSpeak", fileDenylist: ["*.sqlitedb"], startupDone: ["listening on"] });
    expect(reparsed.template?.variables.map((v) => v.envName)).toEqual(tpl.variables.map((v) => v.envName));

    // Replace keeps the id and key.
    const replaced = await owner.post("/templates/import", { egg, category: "Voice", replaceKey: tpl.key });
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(replaced.json().template).toMatchObject({ id: tpl.id, key: tpl.key });

    // Permissions: plain users cannot manage templates.
    const user = await createUserClient(r.t, owner, "user@example.com", []);
    expect((await user.get("/templates")).statusCode).toBe(403);
    expect((await user.post("/templates/import", { egg, category: "Voice" })).statusCode).toBe(403);

    expect((await owner.delete(`/templates/${again.id}`)).statusCode).toBe(204);
    const { rows } = await testPool().query("SELECT action FROM audit_events WHERE action LIKE 'template.%' ORDER BY id");
    expect(rows.map((x) => x.action)).toEqual(expect.arrayContaining(["template.import", "template.update", "template.replace", "template.delete"]));
  });

  it("refuses to delete a template that servers use", async () => {
    const r = await startWithOwner({ background: true });
    t = r.t;
    const owner = r.owner;
    await connectSimNode(r.t, owner, { agents, sim: { installCreates: { "server.jar": "x" } } });
    const tpl = (await owner.post("/templates/import", { egg: eggFixture("ptero-egg-vanilla-minecraft.json"), category: "Minecraft" })).json().template as { id: string };
    const created = await owner.post("/servers", { name: "S", slug: "srv-1", templateId: tpl.id, startup: "manual", placement: { mode: "auto" }, memoryLimitBytes: 1024 ** 3, egg: {} });
    expect(created.statusCode, created.body).toBe(202);
    await waitJob(owner, created.json().jobId);
    expect((await owner.delete(`/templates/${tpl.id}`)).statusCode).toBe(409);
    expect(Template.parse((await owner.get(`/templates/${tpl.id}`)).json()).serverCount).toBe(1);
  });
});

describe("software catalogue", () => {
  it("serves versions, builds and plans from upstream through the safe fetch with a TTL cache", async () => {
    const cat = catalogOptions();
    const r = await startWithOwner({ catalog: cat.catalog });
    t = r.t;
    const owner = r.owner;
    const software = (await owner.get("/catalog/software")).json() as { software: string }[];
    expect(software.map((s) => s.software)).toEqual(expect.arrayContaining(["paper", "vanilla", "velocity", "fabric", "forge", "neoforge", "purpur", "folia", "spigot"]));
    const versions = (await owner.get("/catalog/software/paper/versions")).json() as { minecraftVersion: string }[];
    expect(versions.map((v) => v.minecraftVersion)).toContain("1.21.11");
    const builds = (await owner.get("/catalog/software/paper/versions/1.21.11/builds")).json() as { build: string }[];
    expect(builds[0]).toMatchObject({ build: "132" });
    const plan = ArtifactPlan.parse((await owner.get("/catalog/software/paper/versions/1.21.11/builds/latest/plan")).json());
    expect(plan).toMatchObject({ software: "paper", version: "1.21.11", build: "132" });
    const calls = cat.calls.length;
    await owner.get("/catalog/software/paper/versions");
    await owner.get("/catalog/software/paper/versions/1.21.11/builds/latest/plan");
    expect(cat.calls.length).toBe(calls);
    expect((await owner.get("/catalog/software/paper/versions/1.21.11/builds/99999/plan")).statusCode).toBe(404);
    expect((await owner.get("/catalog/software/paper/versions/1.21.11/builds/..%2F..%2Fx/plan")).statusCode).toBe(400);
    expect((await owner.get("/catalog/software/nope/versions")).statusCode).toBe(400);
    // Upstream outage → 502.
    expect((await owner.get("/catalog/software/purpur/versions")).statusCode).toBe(502);
    const user = await createUserClient(r.t, owner, "nobody@example.com", []);
    expect((await user.get("/catalog/software")).statusCode).toBe(403);
  });

  it("refuses upstream hosts that resolve to private addresses", async () => {
    const cat = catalogOptions();
    const r = await startWithOwner({ catalog: { ...cat.catalog, lookup: async () => [{ address: "127.0.0.1", family: 4 }] } });
    t = r.t;
    const res = await r.owner.get("/catalog/software/paper/versions");
    expect(res.statusCode).toBe(502);
    expect(cat.calls).toEqual([]);
  });
});

describe("allocations", () => {
  it("manages node pools, warns about used ports and assigns additional allocations to servers", async () => {
    const cat = catalogOptions();
    const r = await startWithOwner({ background: true, catalog: cat.catalog, serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 } });
    t = r.t;
    const owner = r.owner;
    const node = await connectSimNode(r.t, owner, { agents, ports: "", sim: { ports: { tcp: [22, 25566], udp: [] } } });
    const created = await owner.post(`/nodes/${node.nodeId}/allocations`, { ip: "10.0.0.5", ports: "80, 25565-25567" });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().created).toBe(4);
    expect(created.json().warnings.join(" ")).toMatch(/privileged/);
    expect(created.json().warnings.join(" ")).toMatch(/25566/);
    expect((await owner.post(`/nodes/${node.nodeId}/allocations`, { ip: "10.0.0.5", ports: "25565-25570" })).json()).toMatchObject({ created: 3, skipped: [25565, 25566, 25567] });
    expect((await owner.post(`/nodes/${node.nodeId}/allocations`, { ip: "10.0.0.5", ports: "70000" })).statusCode).toBe(400);

    const page1 = (await owner.get(`/nodes/${node.nodeId}/allocations?limit=3`)).json() as { items: Allocation[]; nextCursor: string };
    expect(page1.items.map((a) => a.port)).toEqual([80, 25565, 25566]);
    const page2 = (await owner.get(`/nodes/${node.nodeId}/allocations?limit=10&cursor=${encodeURIComponent(page1.nextCursor)}`)).json() as { items: Allocation[] };
    expect(page2.items.map((a) => a.port)).toEqual([25567, 25568, 25569, 25570]);
    const port80 = page1.items[0]!;
    expect((await owner.patch(`/allocations/${port80.id}`, { alias: "play.example.com", notes: "web" })).json()).toMatchObject({ alias: "play.example.com", notes: "web" });
    expect((await owner.delete(`/allocations/${port80.id}`)).statusCode).toBe(204);

    const templateId = await templateIdByKey(owner, "minecraft-java");
    const srv = await owner.post("/servers", paperRequest(templateId, { allocationLimit: 1, startup: "manual" }));
    expect(srv.statusCode, srv.body).toBe(202);
    const id = srv.json().server.id as string;
    await waitJob(owner, srv.json().jobId);
    expect((await owner.delete(`/allocations/${(await owner.get(`/servers/${id}/allocations`)).json()[0].id}`)).statusCode).toBe(409);

    const extra = await owner.post(`/servers/${id}/allocations`);
    expect(extra.statusCode, extra.body).toBe(200);
    expect(extra.json()).toMatchObject({ allocation: { serverId: id, primary: false }, restartRequired: true });
    expect((await owner.post(`/servers/${id}/allocations`)).statusCode).toBe(409);
    const mine = (await owner.get(`/servers/${id}/allocations`)).json() as Allocation[];
    expect(mine).toHaveLength(2);
    const primary = mine.find((a) => a.primary)!;
    const secondary = mine.find((a) => !a.primary)!;
    expect((await owner.delete(`/servers/${id}/allocations/${primary.id}`)).statusCode).toBe(409);
    const switched = await owner.patch(`/servers/${id}/allocations/${secondary.id}`, { primary: true });
    expect(switched.statusCode, switched.body).toBe(200);
    const after = (await owner.get(`/servers/${id}/allocations`)).json() as Allocation[];
    expect(after.find((a) => a.primary)?.id).toBe(secondary.id);
    expect((await owner.get(`/servers/${id}`)).json().address).toBe(`10.0.0.5:${secondary.port}`);
    expect((await owner.delete(`/servers/${id}/allocations/${primary.id}`)).statusCode).toBe(200);

    // A user without allocations.manage cannot touch pools.
    const user = await createUserClient(r.t, owner, "u@example.com", [{ roleKey: "observer", scopeType: "global", scopeId: null }]);
    expect((await user.get(`/nodes/${node.nodeId}/allocations`)).statusCode).toBe(200);
    expect((await user.post(`/nodes/${node.nodeId}/allocations`, { ip: "10.0.0.5", ports: "30000" })).statusCode).toBe(403);
  });
});
