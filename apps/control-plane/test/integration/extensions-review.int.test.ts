/**
 * Regression tests for the control plane Phase 4b review (docs/reviews/2026-10-12-control-plane-phase4b.md):
 * #1 #2 #3 #5 #6 #7 and L2 L3 L4 L6 L7.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CompleteExtensionUploadResponse, ExtensionHistoryPage, ExtensionList, ExtensionUploadResponse, ModrinthInstallPlan, RemoveExtensionResponse } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { keptAreaPath } from "../../src/extensions/model.js";
import { stableId } from "../../src/extensions/ops.js";
import { batched } from "../../src/extensions/scan.js";
import { startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { FakeUpstreams } from "../support/modrinth.js";
import { catalogOptions, connectSimNode, paperRequest, poll, publicLookup, templateIdByKey, waitJob, type SimNodeHandle } from "../support/panel.js";
import { makeJar } from "../support/zip.js";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

const pluginJar = (name: string, version: string, extra = "") => makeJar({ "plugin.yml": `name: ${name}\nversion: ${version}\nmain: com.example.${name.toLowerCase()}.Main\napi-version: '1.21'\n${extra}` });
const sha512 = (b: Buffer | string) => createHash("sha512").update(b).digest("hex");
const KEPT = ".blockforge/extensions/kept/";

async function boot() {
  const up = new FakeUpstreams();
  const cat = catalogOptions();
  const r = await startWithOwner({
    background: true,
    catalog: cat.catalog,
    env: { SCHEDULER_INTERVAL_MS: "300000" },
    serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 },
    upstream: { fetchImpl: up.fetch, lookup: publicLookup },
  });
  t = r.t;
  const node = await connectSimNode(r.t, r.owner, { agents });
  up.attach(node.sim);
  up.addProject({ id: "AlphaLib", slug: "alphalib", title: "Alpha Lib", type: "plugin", loaders: ["paper", "spigot", "bukkit"] });
  up.addVersion("AlphaLib", { id: "AlphaV10", number: "1.0.0", filename: "AlphaLib-1.0.0.jar", jar: pluginJar("AlphaLib", "1.0.0") });
  up.addProject({ id: "GammaPl", slug: "gammapl", title: "Gamma", type: "plugin", loaders: ["paper"] });
  return { ...r, node, up };
}

async function paperServer(owner: ApiClient): Promise<string> {
  const created = await owner.post("/servers", paperRequest(await templateIdByKey(owner, "minecraft-java"), { startup: "manual" }));
  expect(created.statusCode, created.body).toBe(202);
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  return created.json().server.id as string;
}

const list = async (c: ApiClient, id: string) => ExtensionList.parse((await c.get(`/servers/${id}/extensions`)).json());
async function scanned(c: ApiClient, id: string): Promise<ExtensionList> {
  const r = await c.post(`/servers/${id}/extensions/scan`, {});
  expect(r.statusCode, r.body).toBe(202);
  expect((await waitJob(c, r.json().jobId)).status).toBe("succeeded");
  return list(c, id);
}
const history = async (c: ApiClient, id: string) => ExtensionHistoryPage.parse((await c.get(`/servers/${id}/extensions/history`)).json());
const keptFiles = (node: SimNodeHandle, id: string) => [...node.sim.files(id).keys()].filter((p) => p.startsWith(KEPT));
const expectFiles = (plan: ModrinthInstallPlan) => plan.files.map((f) => ({ projectId: f.projectId, versionId: f.versionId, action: f.action }));
async function install(c: ApiClient, id: string, project: string): Promise<string> {
  const plan = ModrinthInstallPlan.parse((await c.post(`/servers/${id}/extensions/modrinth/plan`, { project })).json());
  const r = await c.post(`/servers/${id}/extensions/modrinth/install`, { project, expect: expectFiles(plan) });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().jobId as string;
}

describe("Phase 4b review: kept files, rollback targets and recovery", () => {
  it("#1: the undo of a failed install does not restore a kept jar that changed during the download", async () => {
    const { owner, node, up } = await boot();
    const id = await paperServer(owner);
    await scanned(owner, id);
    const original = pluginJar("Gamma", "0.9-local");
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    await scanned(owner, id);
    const gamma = up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    node.sim.artifacts.set(gamma.url, Buffer.from("tampered on the CDN"));
    // A plugin writes into the keep area while the (failing) download runs.
    node.sim.options = { before: { "artifact.fetch": () => { for (const k of keptFiles(node, id)) node.sim.put(id, k, "EVIL-KEPT-JAR"); } } };
    const job = await waitJob(owner, await install(owner, id, "gammapl"));
    node.sim.options = {};
    expect(job.status).toBe("failed");
    expect((job.error as { message: string }).message).toMatch(/kept file .* changed since it was kept/);
    expect(node.sim.read(id, "plugins/Gamma-1.0.jar")).not.toBe("EVIL-KEPT-JAR");
    expect(node.sim.read(id, "plugins/Gamma-1.0.jar")).toBeNull();
    // The swapped file stays in the keep area (and is recorded there for pruning), never in plugins/.
    const [k] = keptFiles(node, id);
    expect(node.sim.read(id, k!)).toBe("EVIL-KEPT-JAR");
    // Round 2 (item 4): the entry exists from the moment the file was kept, so the failed row points at the
    // file left in the keep area (with the digest taken at the keep) and pruning can remove it.
    const { rows } = await testPool().query("SELECT id, status, kept_path, kept_sha512 FROM extension_history WHERE server_id = $1", [id]);
    expect(rows).toEqual([{ id: expect.any(String), status: "failed", kept_path: k, kept_sha512: sha512(original) }]);
    expect((await history(owner, id)).items[0]!.rollback).toEqual({ available: false, reason: "failed_entry" });
    await testPool().query("UPDATE extension_history SET kept_until = now() - interval '1 minute' WHERE id = $1", [rows[0].id]);
    await t!.tasks.maintenance!.runNow();
    expect(node.sim.read(id, k!)).toBeNull();

    // Without interference the undo still restores the original.
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    expect((await waitJob(owner, await install(owner, id, "gammapl"))).status).toBe("failed");
    expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(original)).toBe(true);
  });

  it("#2: a Modrinth rollback never overwrites or deletes a file that now has the old name", async () => {
    const { owner, node, up } = await boot();
    const id = await paperServer(owner);
    const v1 = up.projects.get("AlphaLib")!.versions[0]!;
    node.sim.put(id, "plugins/AlphaLib-1.0.0.jar", v1.jar);
    const alpha = (await scanned(owner, id)).items.find((x) => x.filename === "AlphaLib-1.0.0.jar")!;
    const v2 = up.addVersion("AlphaLib", { id: "AlphaV20", number: "2.0.0", filename: "AlphaLib-2.0.0.jar", jar: pluginJar("AlphaLib", "2.0.0") });
    const apply = await owner.post(`/servers/${id}/extensions/updates/apply`, { extensionIds: [alpha.id] });
    expect((await waitJob(owner, apply.json().jobId)).status).toBe("succeeded");
    const upd = (await history(owner, id)).items[0]!;
    expect(upd).toMatchObject({ action: "update", from: { path: "plugins/AlphaLib-1.0.0.jar" } });
    // The kept v1 would be preferred (no download): without it the rollback re-fetches from Modrinth.
    node.sim.files(id).delete(`.blockforge/extensions/kept/${upd.id}.jar`);

    // Something unrelated now has the old name.
    node.sim.put(id, "plugins/AlphaLib-1.0.0.jar", "UNRELATED");
    const fetchedBefore = node.sim.fetched.length;
    const rb = await owner.post(`/servers/${id}/extensions/history/${upd.id}/rollback`);
    expect(rb.statusCode, rb.body).toBe(202);
    const rj = await waitJob(owner, rb.json().jobId);
    expect(rj.status).toBe("failed");
    expect(rj.error).toMatchObject({ code: "CONFLICT" });
    expect(node.sim.read(id, "plugins/AlphaLib-1.0.0.jar")).toBe("UNRELATED");
    expect(node.sim.files(id).get("plugins/AlphaLib-2.0.0.jar")!.data.equals(v2.jar)).toBe(true);
    expect(node.sim.fetched.length).toBe(fetchedBefore);

    // Appearing during the download: the rename into place refuses, the occupant survives the undo.
    node.sim.files(id).delete("plugins/AlphaLib-1.0.0.jar");
    node.sim.options = { before: { "artifact.fetch": () => node.sim.put(id, "plugins/AlphaLib-1.0.0.jar", "LATE-ARRIVAL") } };
    const rb2 = await owner.post(`/servers/${id}/extensions/history/${upd.id}/rollback`);
    const rj2 = await waitJob(owner, rb2.json().jobId);
    node.sim.options = {};
    expect(rj2.status).toBe("failed");
    expect(node.sim.read(id, "plugins/AlphaLib-1.0.0.jar")).toBe("LATE-ARRIVAL");
    expect(node.sim.files(id).get("plugins/AlphaLib-2.0.0.jar")!.data.equals(v2.jar)).toBe(true);
    expect([...node.sim.files(id).keys()].filter((p) => p.startsWith(".blockforge/extensions/fetch/"))).toEqual([]);

    // A free old name: the rollback works (fetched under a temporary name, renamed into place).
    node.sim.files(id).delete("plugins/AlphaLib-1.0.0.jar");
    const rb3 = await owner.post(`/servers/${id}/extensions/history/${upd.id}/rollback`);
    expect((await waitJob(owner, rb3.json().jobId)).status).toBe("succeeded");
    expect(node.sim.files(id).get("plugins/AlphaLib-1.0.0.jar")!.data.equals(v1.jar)).toBe(true);
    expect(node.sim.read(id, "plugins/AlphaLib-2.0.0.jar")).toBeNull();
  });

  it("#3: extension jobs hold the server operation lock against backup, restore, reinstall and delete (and vice versa)", async () => {
    const { owner, node, up } = await boot();
    const id = await paperServer(owner);
    await scanned(owner, id);
    const bk = await owner.post(`/servers/${id}/backups`, { name: "before" });
    expect(bk.statusCode, bk.body).toBe(202);
    expect((await waitJob(owner, bk.json().jobId)).status).toBe("succeeded");
    const backupId = bk.json().backup.id as string;
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });

    node.sim.options = { delay: { "artifact.fetch": 2000 } };
    const job = await install(owner, id, "gammapl");
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: "extensions", activeJobId: job, state: "stopped" });
    for (const [what, r] of [
      ["backup", await owner.post(`/servers/${id}/backups`, {})],
      ["restore", await owner.post(`/servers/${id}/backups/${backupId}/restore`, { startAfter: false })],
      ["reinstall", await owner.post(`/servers/${id}/reinstall`)],
      ["delete", await owner.delete(`/servers/${id}?deleteData=true`)],
    ] as const) {
      expect(r.statusCode, `${what}: ${r.body}`).toBe(409);
      expect(r.json().error, what).toMatchObject({ code: "INVALID_STATE", details: { activeOperation: "extensions" } });
    }
    expect((await waitJob(owner, job)).status).toBe("succeeded");
    node.sim.options = {};
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null, activeJobId: null, state: "stopped" });

    // A running backup: no extension change starts (job or synchronous).
    node.sim.options = { delay: { "backup.create": 1500 } };
    const bk2 = await owner.post(`/servers/${id}/backups`, {});
    expect(bk2.statusCode, bk2.body).toBe(202);
    const gammaRow = (await list(owner, id)).items.find((x) => x.filename === "Gamma-1.0.jar")!;
    const refusedInstall = await owner.post(`/servers/${id}/extensions/updates/apply`, { extensionIds: [gammaRow.id] });
    expect(refusedInstall.statusCode).toBe(409);
    expect(refusedInstall.json().error).toMatchObject({ code: "INVALID_STATE", details: { activeOperation: "backup" } });
    const refusedRemove = await owner.delete(`/servers/${id}/extensions/${gammaRow.id}`);
    expect(refusedRemove.statusCode).toBe(409);
    expect(node.sim.read(id, "plugins/Gamma-1.0.jar")).not.toBeNull();
    expect((await waitJob(owner, bk2.json().jobId)).status).toBe("succeeded");
    node.sim.options = {};
  });

  it("#5: a job resumed after a crash between keep+fetch and the history write neither keeps nor fetches again", async () => {
    const { t, owner, node, up } = await boot();
    const id = await paperServer(owner);
    await scanned(owner, id);
    const original = pluginJar("Gamma", "0.9-local");
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    await scanned(owner, id);
    const newJar = pluginJar("Gamma", "1.0");
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: newJar });
    const jobId = await install(owner, id, "gammapl");
    expect((await waitJob(owner, jobId)).status).toBe("succeeded");
    const entry = (await history(owner, id)).items[0]!;
    const keptPath = `${KEPT}${entry.id}.jar`;
    expect(node.sim.files(id).get(keptPath)!.data.equals(original)).toBe(true);
    const fetched = node.sim.fetched.length;

    // Crash after the file was kept and the new one fetched, before the history row (state as checkpointed then).
    await t.ctx.jobs.stop();
    await testPool().query("DELETE FROM extension_history WHERE job_id = $1", [jobId]);
    await testPool().query("UPDATE installed_extensions SET sha512 = $2, sha1 = NULL, source = 'unknown', modrinth = NULL WHERE server_id = $1 AND path = 'plugins/Gamma-1.0.jar'", [id, sha512(original)]);
    await testPool().query("UPDATE jobs SET status = 'running', finished_at = NULL, result = NULL, error = NULL, state = $2 WHERE id = $1", [
      jobId,
      JSON.stringify({ journal: { [entry.id]: { atDest: true, kept: { "plugins/Gamma-1.0.jar": { sha512: sha512(original), moved: true } } } } }),
    ]);
    await testPool().query("UPDATE job_steps SET status = CASE WHEN key = 'fetch' THEN 'running' ELSE 'pending' END, finished_at = NULL WHERE job_id = $1", [jobId]);
    await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = $2 WHERE id = $1", [id, jobId]);
    await testPool().query("UPDATE extension_scans SET active_job_id = $2 WHERE server_id = $1", [id, jobId]);
    await t.ctx.jobs.start();

    const row = await t.ctx.jobs.waitForCompletion(jobId);
    expect(row.status, JSON.stringify(row.error)).toBe("succeeded");
    expect(node.sim.fetched.length).toBe(fetched);
    expect(node.sim.files(id).get(keptPath)!.data.equals(original)).toBe(true);
    expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(newJar)).toBe(true);
    expect(keptFiles(node, id)).toEqual([keptPath]);
    const { rows } = await testPool().query("SELECT id, status, kept_path, kept_sha512 FROM extension_history WHERE job_id = $1", [jobId]);
    expect(rows).toEqual([{ id: entry.id, status: "succeeded", kept_path: keptPath, kept_sha512: sha512(original) }]);
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });

    // A resumed step whose history was already written (crash before the step was marked done) does not apply again.
    await t.ctx.jobs.stop();
    await testPool().query("UPDATE jobs SET status = 'running', finished_at = NULL WHERE id = $1", [jobId]);
    await testPool().query("UPDATE job_steps SET status = CASE WHEN key = 'fetch' THEN 'running' ELSE 'pending' END, finished_at = NULL WHERE job_id = $1", [jobId]);
    await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = $2 WHERE id = $1", [id, jobId]);
    await t.ctx.jobs.start();
    expect((await t.ctx.jobs.waitForCompletion(jobId)).status).toBe("succeeded");
    expect(node.sim.fetched.length).toBe(fetched);
    expect(keptFiles(node, id)).toEqual([keptPath]);
    expect((await testPool().query("SELECT count(*)::int AS n FROM extension_history WHERE job_id = $1", [jobId])).rows[0].n).toBe(1);
  });

  it("#6: remove and upload-replace keep the digest of the file actually kept (changed since the scan, or never scanned)", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "1.0"));
    const custom = (await scanned(owner, id)).items[0]!;
    const changed = pluginJar("Custom", "1.1-hotfix");
    node.sim.put(id, "plugins/custom.jar", changed); // no rescan
    const rm = RemoveExtensionResponse.parse((await owner.delete(`/servers/${id}/extensions/${custom.id}`)).json());
    expect(rm.rollbackAvailable).toBe(true);
    expect((await history(owner, id)).items[0]!.rollback).toEqual({ available: true, reason: null });
    const back = await owner.post(`/servers/${id}/extensions/history/${rm.historyEntryId}/rollback`);
    expect(back.statusCode, back.body).toBe(202);
    expect((await waitJob(owner, back.json().jobId)).status).toBe("succeeded");
    expect(node.sim.files(id).get("plugins/custom.jar")!.data.equals(changed)).toBe(true);

    // Upload replacing a file the scan never saw.
    const unscanned = pluginJar("Unscanned", "1.0");
    node.sim.put(id, "plugins/Unscanned.jar", unscanned);
    const v2 = pluginJar("Unscanned", "2.0");
    const u = ExtensionUploadResponse.parse((await owner.post(`/servers/${id}/extensions/uploads`, { filename: "Unscanned.jar", sizeBytes: v2.length })).json());
    const put = await t.app.inject({ method: "PUT", url: u.url, headers: { cookie: owner.cookieHeader(), "content-type": "application/octet-stream" }, payload: v2 });
    expect(put.statusCode, put.body).toBe(200);
    const done = await owner.post(`/servers/${id}/extensions/uploads/${u.uploadId}/complete`, { replaceExisting: true });
    expect(done.statusCode, done.body).toBe(200);
    expect(CompleteExtensionUploadResponse.parse(done.json()).warnings.map((w) => w.code)).toEqual(["REPLACED_EXISTING"]);
    const entry = (await history(owner, id)).items[0]!;
    expect(entry).toMatchObject({ action: "upload", rollback: { available: true } });
    const { rows } = await testPool().query("SELECT kept_sha512 FROM extension_history WHERE id = $1", [entry.id]);
    expect(rows[0].kept_sha512).toBe(sha512(unscanned));
    const rb = await owner.post(`/servers/${id}/extensions/history/${entry.id}/rollback`);
    expect((await waitJob(owner, rb.json().jobId)).status).toBe("succeeded");
    expect(node.sim.files(id).get("plugins/Unscanned.jar")!.data.equals(unscanned)).toBe(true);
  });

  it("#7: history names the acting user by username; the migration replaces stored e-mail addresses", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "1.0"));
    const custom = (await scanned(owner, id)).items[0]!;
    expect((await owner.patch(`/servers/${id}/extensions/${custom.id}`, { enabled: false })).statusCode).toBe(200);
    const h = await history(owner, id);
    expect(h.items[0]!.actor).toMatchObject({ type: "user", name: "owner" });
    expect(JSON.stringify(h)).not.toContain("owner@example.com");

    // Rows written before the fix: the 0006 migration maps them to usernames (or clears unknown e-mails).
    const ownerId = (await owner.get("/auth/me")).json().user.id as string;
    await testPool().query("UPDATE extension_history SET actor_name = 'owner@example.com' WHERE server_id = $1", [id]);
    await testPool().query(
      `INSERT INTO extension_history (id, server_id, action, status, extension_name, path, actor_type, actor_id, actor_name, at)
       VALUES (gen_random_uuid(), $1, 'remove', 'succeeded', 'Gone', 'plugins/gone.jar', 'user', gen_random_uuid(), 'deleted.user@example.com', now() - interval '1 day')`,
      [id],
    );
    const sql = readFileSync(fileURLToPath(new URL("../../drizzle/0006_extensions_review.sql", import.meta.url)), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").filter((s) => /UPDATE "extension_history"/.test(s))) await testPool().query(stmt);
    const { rows } = await testPool().query("SELECT actor_id, actor_name FROM extension_history WHERE server_id = $1 ORDER BY at", [id]);
    expect(rows.map((r) => r.actor_name)).toEqual([null, "owner"]);
    expect(rows[1].actor_id).toBe(ownerId);
  });
});

describe("Phase 4b review: low findings", () => {
  it("L2: a hash answer that does not match the requested paths fails the scan cleanly", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/a.jar", pluginJar("A", "1"));
    node.sim.put(id, "plugins/b.jar", pluginJar("B", "1"));
    node.sim.options = { mapResult: { "fs.hash": (data) => ({ files: (data as { files: unknown[] }).files.slice(1) }) } };
    const r = await owner.post(`/servers/${id}/extensions/scan`, {});
    const job = await waitJob(owner, r.json().jobId);
    node.sim.options = {};
    expect(job.status).toBe("failed");
    expect(job.error).toMatchObject({ code: "AGENT_PROTOCOL" });
    expect((await list(owner, id)).scan).toMatchObject({ status: "failed", error: expect.stringContaining("result(s) for 2 path(s)") });
    // Unit level: shorter, longer and reordered answers are refused.
    const ok = (p: string) => ({ path: p, ok: true });
    await expect(batched(["x", "y"], 10, async (b) => b.slice(1).map(ok))).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    await expect(batched(["x", "y"], 10, async (b) => [...b, "z"].map(ok))).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    await expect(batched(["x", "y"], 10, async (b) => [...b].reverse().map(ok))).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    expect([...(await batched(["x", "y"], 10, async (b) => b.map(ok))).keys()]).toEqual(["x", "y"]);
  });

  it("L3: a synchronous remove holds the lock while it acts (no job, backup or second change starts meanwhile)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/a.jar", pluginJar("A", "1"));
    node.sim.put(id, "plugins/b.jar", pluginJar("B", "1"));
    const l = await scanned(owner, id);
    const [a, b] = [l.items.find((x) => x.filename === "a.jar")!, l.items.find((x) => x.filename === "b.jar")!];
    node.sim.options = { delay: { "fs.rename": 1000 } };
    const removing = owner.delete(`/servers/${id}/extensions/${a.id}`);
    await poll(async () => (await owner.get(`/servers/${id}`)).json().activeOperation === "extensions", 5000, 20);
    const scan = await owner.post(`/servers/${id}/extensions/scan`, {});
    expect(scan.statusCode).toBe(409);
    expect(scan.json().error.details).toEqual({ reason: "extension_job_running" });
    const toggle = await owner.patch(`/servers/${id}/extensions/${b.id}`, { enabled: false });
    expect(toggle.statusCode).toBe(409);
    expect(toggle.json().error.details).toEqual({ reason: "extension_job_running" });
    const backup = await owner.post(`/servers/${id}/backups`, {});
    expect(backup.statusCode).toBe(409);
    expect((await removing).statusCode).toBe(200);
    node.sim.options = {};
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
    expect((await owner.patch(`/servers/${id}/extensions/${b.id}`, { enabled: false })).statusCode).toBe(200);
  });

  it("L4: pruning never deletes a recorded kept path outside the keep area; L3: stale synchronous locks are released", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/important.jar", "do not delete");
    node.sim.put(id, "plugins/other.jar", "x");
    for (const kept of ["plugins/important.jar", ".blockforge/extensions/kept/../../../plugins/other.jar"]) {
      await testPool().query(
        `INSERT INTO extension_history (id, server_id, action, status, extension_name, path, actor_type, at, kept_path, kept_sha512, kept_until)
         VALUES (gen_random_uuid(), $1, 'remove', 'succeeded', 'X', 'plugins/x.jar', 'system', now(), $2, 'abc', now() - interval '1 minute')`,
        [id, kept],
      );
    }
    await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = NULL, updated_at = now() - interval '1 hour' WHERE id = $1", [id]);
    await t.tasks.maintenance!.runNow();
    expect(node.sim.read(id, "plugins/important.jar")).toBe("do not delete");
    expect(node.sim.read(id, "plugins/other.jar")).toBe("x");
    const { rows } = await testPool().query("SELECT kept_path FROM extension_history WHERE server_id = $1", [id]);
    expect(rows.every((r) => r.kept_path === null)).toBe(true);
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
  });

  it("L6/L7: an outdated agent is reported in the list's scan status, and artifact.fetch is part of the capability check", async () => {
    const { t, owner, node, up } = await boot();
    const id = await paperServer(owner);
    const fetchedBefore = node.sim.fetched.length;
    // L6: the automatic first scan cannot start; the list says why (as an explicit scan would).
    t.ctx.gateway.session(node.nodeId)!.capabilities = ["docker"];
    const l = await list(owner, id);
    expect(l.scan).toMatchObject({ status: "never", jobId: null, error: expect.stringContaining("too old") });
    const explicit = await owner.post(`/servers/${id}/extensions/scan`, {});
    expect(l.scan.error).toBe(explicit.json().error.message);
    // L7: an agent with the scan commands but without artifact.fetch cannot install.
    t.ctx.gateway.session(node.nodeId)!.capabilities = ["docker", "fs.hash", "jar.readEntries"];
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    const plan = ModrinthInstallPlan.parse((await owner.post(`/servers/${id}/extensions/modrinth/plan`, { project: "gammapl" })).json());
    const r = await owner.post(`/servers/${id}/extensions/modrinth/install`, { project: "gammapl", expect: expectFiles(plan) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: "INVALID_STATE", details: { reason: "agent_outdated", missingCapabilities: ["artifact.fetch"] } });
    expect(node.sim.fetched.length).toBe(fetchedBefore);
  });
});

/** Running Paper server (power actions may pre-empt plugin/mod changes only while it runs). */
async function runningServer(owner: ApiClient): Promise<string> {
  const id = await paperServer(owner);
  const start = await owner.post(`/servers/${id}/actions`, { action: "start" });
  expect(start.statusCode, start.body).toBe(202);
  expect((await waitJob(owner, start.json().jobId)).status).toBe("succeeded");
  return id;
}

/** Puts an install job into the state a crash leaves behind (step `fetch` running, both locks held). */
async function crashInto(t: TestApp, id: string, jobId: string, state: unknown): Promise<void> {
  await t.ctx.jobs.stop();
  await testPool().query("DELETE FROM extension_history WHERE job_id = $1", [jobId]);
  await testPool().query("UPDATE jobs SET status = 'running', finished_at = NULL, result = NULL, error = NULL, state = $2 WHERE id = $1", [jobId, JSON.stringify(state)]);
  await testPool().query("UPDATE job_steps SET status = CASE WHEN key = 'fetch' THEN 'running' ELSE 'pending' END, finished_at = NULL WHERE job_id = $1", [jobId]);
  await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = $2 WHERE id = $1", [id, jobId]);
  await testPool().query("UPDATE extension_scans SET active_job_id = $2 WHERE server_id = $1", [id, jobId]);
}

describe("Phase 4b review round 2 (Grok)", () => {
  it("B1: a failing finalize cannot pin the server lock: maintenance (and lock takeover) release it", async () => {
    const { t, owner, up } = await boot();
    const id = await runningServer(owner);
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    const state = t.ctx.serverState;
    const end = state.end.bind(state);
    let failed = 0;
    state.end = async (serverId: string, jobId: string) => {
      if (failed === 0 && (await testPool().query("SELECT 1 FROM jobs WHERE id = $1 AND type = 'server.extensions.install'", [jobId])).rowCount) {
        failed++;
        throw new Error("simulated release failure");
      }
      return end(serverId, jobId);
    };
    const job = await install(owner, id, "gammapl");
    expect((await waitJob(owner, job)).status).toBe("succeeded");
    expect(failed).toBe(1);
    // The extension job lock was still released; the server lock is pinned by a terminal job.
    expect((await testPool().query("SELECT active_job_id FROM extension_scans WHERE server_id = $1", [id])).rows[0].active_job_id).toBeNull();
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: "extensions", activeJobId: job });
    await t.tasks.maintenance!.runNow();
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null, activeJobId: null });
    const stop = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    expect(stop.statusCode, stop.body).toBe(202);
    expect((await waitJob(owner, stop.json().jobId)).status).toBe("succeeded");

    // Without maintenance, a new operation takes over a lock held by a terminal job.
    await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = $2 WHERE id = $1", [id, job]);
    const backup = await owner.post(`/servers/${id}/backups`, {});
    expect(backup.statusCode, backup.body).toBe(202);
    expect((await waitJob(owner, backup.json().jobId)).status).toBe("succeeded");
  });

  /** Original jar back in place, nothing left in the keep/fetch areas, a fresh scan. */
  async function resetGamma(owner: ApiClient, node: SimNodeHandle, id: string, original: Buffer) {
    for (const k of [...node.sim.files(id).keys()]) if (k.startsWith(KEPT) || k.startsWith(".blockforge/extensions/fetch/")) node.sim.files(id).delete(k);
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    await scanned(owner, id);
  }
  const fetchFiles = (node: SimNodeHandle, id: string) => [...node.sim.files(id).keys()].filter((k) => k.startsWith(".blockforge/extensions/fetch/") && k.endsWith(".jar"));
  /** fs.rename / fs.delete commands that touched plugin/mod or extension-area files since `mark`. */
  const fileOps = (node: SimNodeHandle, mark: number) =>
    node.agent.commands.slice(mark).filter((c) => {
      if (c.type !== "fs.rename" && c.type !== "fs.delete") return false;
      const p = c.payload as { path?: string; from?: string; to?: string };
      return [p.path, p.from, p.to].some((x) => typeof x === "string" && (x.startsWith("plugins/") || x.startsWith(".blockforge/extensions/")));
    });

  it("2a: stop/kill with nothing else afterwards: the pre-empted change takes a cleanup hold and undoes itself", async () => {
    const { owner, node, up } = await boot();
    const id = await runningServer(owner);
    const original = pluginJar("Gamma", "0.9-local");
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    await scanned(owner, id);
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });

    for (const action of ["kill", "stop"] as const) {
      let power: string | null = null;
      let backupDuring = 0;
      let duringCleanup: { server: Record<string, unknown>; start: number; backup: number } | null = null;
      node.sim.options = {
        before: {
          // While the download runs (the original jar is already kept): backup stays blocked, the power action
          // pre-empts and finishes before the download returns (the server is stopped and free afterwards).
          "artifact.fetch": async () => {
            backupDuring = (await owner.post(`/servers/${id}/backups`, {})).statusCode;
            const r = await owner.post(`/servers/${id}/actions`, { action });
            expect(r.statusCode, r.body).toBe(202);
            power = r.json().jobId as string;
            expect((await waitJob(owner, power!)).status).toBe("succeeded");
          },
          // The cleanup undo moves the kept jar back: it runs under its own `extensions` hold (no job id), and
          // start/backup are refused until it ends.
          "fs.rename": async (p) => {
            if (!power || duringCleanup || !String(p.from).startsWith(KEPT)) return;
            duringCleanup = {
              server: (await owner.get(`/servers/${id}`)).json(),
              start: (await owner.post(`/servers/${id}/actions`, { action: "start" })).statusCode,
              backup: (await owner.post(`/servers/${id}/backups`, {})).statusCode,
            };
          },
        },
      };
      const job = await install(owner, id, "gammapl");
      const ej = await waitJob(owner, job);
      node.sim.options = {};
      expect(backupDuring).toBe(409);
      expect(duringCleanup).toMatchObject({ server: { activeOperation: "extensions", activeJobId: null, state: "stopped" }, start: 409, backup: 409 });
      expect(ej.status).toBe("failed");
      expect(ej.error).toMatchObject({ code: "LOCK_LOST" });
      expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(original)).toBe(true);
      expect(keptFiles(node, id)).toEqual([]);
      expect(fetchFiles(node, id)).toEqual([]);
      const rows = (await testPool().query("SELECT status, kept_path FROM extension_history WHERE job_id = $1", [job])).rows;
      expect(rows).toEqual([{ status: "failed", kept_path: null }]);
      expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null, activeJobId: null, state: "stopped" });
      const start = await owner.post(`/servers/${id}/actions`, { action: "start" });
      expect((await waitJob(owner, start.json().jobId)).status).toBe("succeeded");
    }
  });

  it("2b: while another operation holds the server or it runs, the pre-empted change touches no file and records what it left", async () => {
    const { owner, node, up } = await boot();
    const id = await runningServer(owner);
    const original = pluginJar("Gamma", "0.9-local");
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    await scanned(owner, id);
    const newJar = pluginJar("Gamma", "1.0");
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: newJar });
    const waitIdle = async () => poll(async () => (await owner.get(`/servers/${id}`)).json().activeOperation === null, 15_000, 50);

    const scenarios: Record<string, { delay: Record<string, number>; during: () => Promise<void> }> = {
      // restart: its job stops, then starts the server (slow start) while holding the lock.
      "restart overlapping the undo": {
        delay: { "workload.start": 2500 },
        during: async () => {
          const r = await owner.post(`/servers/${id}/actions`, { action: "restart" });
          expect(r.statusCode, r.body).toBe(202);
          await poll(async () => {
            const s = (await owner.get(`/servers/${id}`)).json();
            return s.activeOperation === "restart" && s.state === "starting";
          }, 10_000, 20);
        },
      },
      // kill, then a start before the download returns: the server runs (lock free, but not stopped).
      "kill then start": {
        delay: {},
        during: async () => {
          const k = await owner.post(`/servers/${id}/actions`, { action: "kill" });
          expect((await waitJob(owner, k.json().jobId)).status).toBe("succeeded");
          const s = await owner.post(`/servers/${id}/actions`, { action: "start" });
          expect((await waitJob(owner, s.json().jobId)).status).toBe("succeeded");
        },
      },
      // kill, then a backup that holds the lock when the download returns.
      "kill then backup": {
        delay: { "backup.create": 2500 },
        during: async () => {
          const k = await owner.post(`/servers/${id}/actions`, { action: "kill" });
          expect((await waitJob(owner, k.json().jobId)).status).toBe("succeeded");
          const b = await owner.post(`/servers/${id}/backups`, {});
          expect(b.statusCode, b.body).toBe(202);
          await poll(async () => (await owner.get(`/servers/${id}`)).json().activeOperation === "backup", 10_000, 20);
        },
      },
    };
    for (const [name, sc] of Object.entries(scenarios)) {
      let mark = 0;
      node.sim.options = {
        delay: sc.delay,
        before: {
          "artifact.fetch": async () => {
            await sc.during();
            mark = node.agent.commands.length;
          },
        },
      };
      const job = await install(owner, id, "gammapl");
      const ej = await waitJob(owner, job, 30_000);
      expect(ej.status, name).toBe("failed");
      expect(ej.error, name).toMatchObject({ code: "PREEMPTED_UNDO_SKIPPED" });
      // No file was touched after the pre-emption: the original stays kept, the download stays in the fetch area.
      expect(fileOps(node, mark), name).toEqual([]);
      expect(node.sim.read(id, "plugins/Gamma-1.0.jar"), name).toBeNull();
      const [kept] = keptFiles(node, id);
      expect(node.sim.files(id).get(kept!)!.data.equals(original), name).toBe(true);
      const [temp] = fetchFiles(node, id);
      expect(node.sim.files(id).get(temp!)!.data.equals(newJar), name).toBe(true);
      // The history row records every kept file and every file the change wrote.
      const rows = (await testPool().query("SELECT status, kept_path, kept_sha512, error FROM extension_history WHERE job_id = $1", [job])).rows;
      expect(rows, name).toEqual([{ status: "failed", kept_path: kept, kept_sha512: sha512(original), error: expect.stringContaining("undo skipped") }]);
      expect(rows[0].error).toContain(temp!);
      expect(rows[0].error).toContain(sha512(newJar));
      await waitIdle();
      node.sim.options = {};
      const s = (await owner.get(`/servers/${id}`)).json();
      if (s.state !== "running") {
        const st = await owner.post(`/servers/${id}/actions`, { action: "start" });
        expect((await waitJob(owner, st.json().jobId)).status).toBe("succeeded");
      }
      await resetGamma(owner, node, id, original);
    }
  });

  it("2c: synchronous changes: a pre-empted remove under a running stop touches nothing; after a finished kill it undoes itself", async () => {
    const { owner, node } = await boot();
    const id = await runningServer(owner);
    const original = pluginJar("Gamma", "0.9-local");
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    const gamma = (await scanned(owner, id)).items.find((x) => x.filename === "Gamma-1.0.jar")!;

    // Stop (slow) pre-empts while the jar moves to the keep area: the remove decides under the stop's lock.
    let stopJob: string | null = null;
    node.sim.options = {
      delay: { "workload.stop": 2500 },
      before: {
        "fs.rename": async (p) => {
          if (stopJob || !String(p.to).startsWith(KEPT)) return;
          const r = await owner.post(`/servers/${id}/actions`, { action: "stop" });
          expect(r.statusCode, r.body).toBe(202);
          stopJob = r.json().jobId as string;
          await poll(async () => (await owner.get(`/servers/${id}`)).json().state === "stopping", 5000, 20);
        },
      },
    };
    const rm = await owner.delete(`/servers/${id}/extensions/${gamma.id}`);
    expect(rm.statusCode, rm.body).toBe(409);
    expect(rm.json().error.details).toMatchObject({ reason: "preempted_undo_skipped" });
    // Still inside the stop: the lock is the stop's (the remove released nothing but its own token).
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: "stop", activeJobId: stopJob, state: "stopping" });
    const [kept] = keptFiles(node, id);
    expect(node.sim.files(id).get(kept!)!.data.equals(original)).toBe(true);
    expect(node.sim.read(id, "plugins/Gamma-1.0.jar")).toBeNull();
    const { rows } = await testPool().query("SELECT action, status, kept_path, kept_sha512 FROM extension_history WHERE server_id = $1", [id]);
    expect(rows).toEqual([{ action: "remove", status: "failed", kept_path: kept, kept_sha512: sha512(original) }]);
    expect((await waitJob(owner, stopJob!)).status).toBe("succeeded");
    node.sim.options = {};

    // Kill finished before the move returns (server stopped, lock free): cleanup hold, the jar goes back.
    node.sim.files(id).delete(kept!);
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    const start = await owner.post(`/servers/${id}/actions`, { action: "start" });
    expect((await waitJob(owner, start.json().jobId)).status).toBe("succeeded");
    const g2 = (await scanned(owner, id)).items.find((x) => x.filename === "Gamma-1.0.jar")!;
    let killed = false;
    node.sim.options = {
      before: {
        "fs.rename": async (p) => {
          if (killed || !String(p.to).startsWith(KEPT)) return;
          killed = true;
          const k = await owner.post(`/servers/${id}/actions`, { action: "kill" });
          expect((await waitJob(owner, k.json().jobId)).status).toBe("succeeded");
        },
      },
    };
    const rm2 = await owner.delete(`/servers/${id}/extensions/${g2.id}`);
    node.sim.options = {};
    expect(rm2.statusCode, rm2.body).toBe(409);
    expect(rm2.json().error.details).toMatchObject({ reason: "preempted" });
    expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(original)).toBe(true);
    expect(keptFiles(node, id)).toEqual([]);
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null, state: "stopped" });

    // Enable/disable re-checks after its rename too (minor 4): pre-empted → renamed back under a cleanup hold.
    const st2 = await owner.post(`/servers/${id}/actions`, { action: "start" });
    expect((await waitJob(owner, st2.json().jobId)).status).toBe("succeeded");
    let killed2 = false;
    node.sim.options = {
      before: {
        "fs.rename": async (p) => {
          if (killed2 || String(p.to) !== "plugins/Gamma-1.0.jar.disabled") return;
          killed2 = true;
          const k = await owner.post(`/servers/${id}/actions`, { action: "kill" });
          expect((await waitJob(owner, k.json().jobId)).status).toBe("succeeded");
        },
      },
    };
    const off = await owner.patch(`/servers/${id}/extensions/${g2.id}`, { enabled: false });
    node.sim.options = {};
    expect(off.statusCode, off.body).toBe(409);
    expect(off.json().error.details).toMatchObject({ reason: "preempted" });
    expect(node.sim.read(id, "plugins/Gamma-1.0.jar.disabled")).toBeNull();
    expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(original)).toBe(true);
  });

  it("crash during the undo: recover() finishes it under the job's lock, or under a cleanup hold, or skips it — one failed row each time", async () => {
    const { t, owner, node, up } = await boot();
    const id = await paperServer(owner);
    const original = pluginJar("Gamma", "0.9-local");
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    await scanned(owner, id);
    const gamma = up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    node.sim.artifacts.set(gamma.url, Buffer.from("tampered on the CDN"));
    for (const variant of ["job still holds its lock", "lock lost, server free and stopped", "lock held by another change"] as const) {
      const jobId = await install(owner, id, "gammapl");
      expect((await waitJob(owner, jobId)).status).toBe("failed");
      const entryId = stableId(jobId, "apply:plugins/Gamma-1.0.jar");
      const keptPath = `${KEPT}${entryId}.jar`;
      const temp = `.blockforge/extensions/fetch/${entryId}.jar`;
      // Crash state: the original was kept (journaled), the download failed, the undo started and had done the
      // temp-file step but not yet moved the original back.
      node.sim.files(id).delete("plugins/Gamma-1.0.jar");
      node.sim.put(id, keptPath, original);
      const entry = { id: entryId, action: "update", extensionId: null, extensionName: "Gamma", path: "plugins/Gamma-1.0.jar", from: null, to: null, keptPath, keptSha512: sha512(original) };
      await crashInto(t, id, jobId, {
        journal: { [entryId]: { atDest: true, kept: { "plugins/Gamma-1.0.jar": { sha512: sha512(original), moved: true } } } },
        undo: {
          install: {
            steps: [
              { kind: "restore", kept: keptPath, sha512: sha512(original), path: "plugins/Gamma-1.0.jar", entryId },
              { kind: "delete", path: temp, sha512: gamma.sha512 },
            ],
            entries: [entry],
            started: true,
            error: { code: "CHECKSUM_MISMATCH", message: "install: sha512 mismatch" },
            done: [1],
            failed: [],
            notes: [],
          },
        },
      });
      const foreign = "00000000-0000-4000-8000-00000000f00d";
      if (variant === "lock lost, server free and stopped") await testPool().query("UPDATE servers SET active_operation = NULL, active_job_id = NULL WHERE id = $1", [id]);
      if (variant === "lock held by another change")
        await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = NULL, operation_token = $2, operation_started_at = now() WHERE id = $1", [id, foreign]);
      const fetched = node.sim.fetched.length;
      await t.ctx.jobs.start();
      const row = await t.ctx.jobs.waitForCompletion(jobId);
      expect(row.status, variant).toBe("failed");
      expect(node.sim.fetched.length, variant).toBe(fetched); // the apply is never resumed
      const { rows } = await testPool().query("SELECT status, kept_path, kept_sha512, error FROM extension_history WHERE job_id = $1", [jobId]);
      expect(rows.length, variant).toBe(1);
      if (variant === "lock held by another change") {
        expect(row.error, variant).toMatchObject({ code: "PREEMPTED_UNDO_SKIPPED" });
        expect(node.sim.read(id, "plugins/Gamma-1.0.jar"), variant).toBeNull();
        expect(rows[0], variant).toMatchObject({ status: "failed", kept_path: keptPath, kept_sha512: sha512(original) });
        expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: "extensions", activeJobId: null });
        await testPool().query("UPDATE servers SET active_operation = NULL, operation_token = NULL, operation_started_at = NULL WHERE id = $1", [id]);
        node.sim.files(id).delete(keptPath);
        node.sim.put(id, "plugins/Gamma-1.0.jar", original);
      } else {
        expect(row.error, variant).toMatchObject({ code: "CHECKSUM_MISMATCH" });
        expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(original), variant).toBe(true);
        expect(node.sim.read(id, keptPath), variant).toBeNull();
        expect(rows[0], variant).toMatchObject({ status: "failed", kept_path: null });
        expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
      }
      await scanned(owner, id);
    }
  });

  it("rescan: a job that lost its lock after recording the change fails with LOCK_LOST and changes nothing more", async () => {
    const { t, owner, node, up } = await boot();
    const id = await paperServer(owner);
    await scanned(owner, id);
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    const jobId = await install(owner, id, "gammapl");
    expect((await waitJob(owner, jobId)).status).toBe("succeeded");
    await t.ctx.jobs.stop();
    await testPool().query("UPDATE jobs SET status = 'running', finished_at = NULL, result = NULL, error = NULL WHERE id = $1", [jobId]);
    await testPool().query("UPDATE job_steps SET status = CASE WHEN key = 'fetch' THEN 'succeeded' ELSE 'running' END WHERE job_id = $1", [jobId]);
    await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = NULL, operation_token = gen_random_uuid(), operation_started_at = now() WHERE id = $1", [id]);
    await testPool().query("UPDATE extension_scans SET active_job_id = $2 WHERE server_id = $1", [id, jobId]);
    const mark = node.agent.commands.length;
    await t.ctx.jobs.start();
    const row = await t.ctx.jobs.waitForCompletion(jobId);
    expect(row.status).toBe("failed");
    expect(row.error).toMatchObject({ code: "LOCK_LOST", message: expect.stringContaining("files were changed") });
    expect(node.agent.commands.slice(mark).filter((c) => c.type === "fs.list" || c.type === "fs.hash")).toEqual([]);
    expect((await testPool().query("SELECT status FROM extension_history WHERE job_id = $1", [jobId])).rows).toEqual([{ status: "succeeded" }]);
    await testPool().query("UPDATE servers SET active_operation = NULL, operation_token = NULL, operation_started_at = NULL WHERE id = $1", [id]);
  });

  it("minor 1: a changed upload that cannot be moved back is reported as stuck; the kept file is not restored onto it", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    const original = pluginJar("Uploaded", "1.0");
    node.sim.put(id, "plugins/Uploaded.jar", original);
    await scanned(owner, id);
    const v2 = pluginJar("Uploaded", "2.0");
    const u = ExtensionUploadResponse.parse((await owner.post(`/servers/${id}/extensions/uploads`, { filename: "Uploaded.jar", sizeBytes: v2.length })).json());
    const put = await t.app.inject({ method: "PUT", url: u.url, headers: { cookie: owner.cookieHeader(), "content-type": "application/octet-stream" }, payload: v2 });
    expect(put.statusCode, put.body).toBe(200);
    const staging = `.blockforge/extensions/uploads/${u.uploadId}.jar.part`;
    node.sim.options = {
      before: {
        "fs.rename": (p) => {
          if (p.from === staging) node.sim.put(id, staging, "SWAPPED-AFTER-CHECK");
          if (p.from === "plugins/Uploaded.jar" && p.to === staging) node.sim.put(id, staging, "BLOCKS-THE-MOVE-BACK");
        },
      },
    };
    const done = await owner.post(`/servers/${id}/extensions/uploads/${u.uploadId}/complete`, { replaceExisting: true });
    node.sim.options = {};
    expect(done.statusCode, done.body).toBe(409);
    expect(done.json().error.details).toMatchObject({ reason: "placement_stuck", path: "plugins/Uploaded.jar" });
    expect(node.sim.read(id, "plugins/Uploaded.jar")).toBe("SWAPPED-AFTER-CHECK");
    const [kept] = keptFiles(node, id);
    expect(node.sim.files(id).get(kept!)!.data.equals(original)).toBe(true);
    const { rows } = await testPool().query("SELECT action, status, kept_path, kept_sha512, error FROM extension_history WHERE server_id = $1", [id]);
    expect(rows).toEqual([{ action: "upload", status: "failed", kept_path: kept, kept_sha512: sha512(original), error: expect.stringContaining("could not be moved back") }]);
  });

  it("3: a resumed job never adopts a kept file whose digest was not journaled before the move", async () => {
    const { t, owner, node, up } = await boot();
    const id = await paperServer(owner);
    await scanned(owner, id);
    const original = pluginJar("Gamma", "0.9-local");
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    await scanned(owner, id);
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });

    for (const variant of ["no digest", "other digest"] as const) {
      const jobId = await install(owner, id, "gammapl");
      expect((await waitJob(owner, jobId)).status).toBe("succeeded");
      const entryId = stableId(jobId, "apply:plugins/Gamma-1.0.jar");
      const keptPath = `${KEPT}${entryId}.jar`;
      expect(node.sim.files(id).get(keptPath)!.data.equals(original)).toBe(true);
      // Crash right after the move (before the new file was fetched); meanwhile the kept file was replaced.
      node.sim.files(id).delete("plugins/Gamma-1.0.jar");
      node.sim.put(id, keptPath, "REPLACED-IN-KEEP-AREA");
      const fetched = node.sim.fetched.length;
      const kept = variant === "no digest" ? {} : { "plugins/Gamma-1.0.jar": { sha512: sha512(original), moved: false } };
      await crashInto(t, id, jobId, { journal: { [entryId]: { atDest: true, kept } } });
      await t.ctx.jobs.start();
      const row = await t.ctx.jobs.waitForCompletion(jobId);
      expect(row.status, variant).toBe("failed");
      expect(row.error, variant).toMatchObject({ code: "KEPT_FILE_UNVERIFIED" });
      expect(node.sim.fetched.length).toBe(fetched);
      // Not restored, not recorded as the original: a failed row points at it without a digest.
      expect(node.sim.read(id, "plugins/Gamma-1.0.jar"), variant).toBeNull();
      expect(node.sim.read(id, keptPath)).toBe("REPLACED-IN-KEEP-AREA");
      const { rows } = await testPool().query("SELECT status, kept_path, kept_sha512, error FROM extension_history WHERE job_id = $1", [jobId]);
      expect(rows, variant).toEqual([{ status: "failed", kept_path: keptPath, kept_sha512: null, error: expect.stringContaining("will not be restored") }]);
      expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
      // Next round: the original back in place, the inspected file removed by the operator.
      node.sim.files(id).delete(keptPath);
      node.sim.put(id, "plugins/Gamma-1.0.jar", original);
      await scanned(owner, id);
    }
  });

  it("4: a file that cannot be hashed is not moved (remove refused, original in place)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "1.0"));
    const custom = (await scanned(owner, id)).items[0]!;
    node.sim.options = { ioErrorPaths: ["plugins/custom.jar"] };
    const rm = await owner.delete(`/servers/${id}/extensions/${custom.id}`);
    node.sim.options = {};
    expect(rm.statusCode).toBe(409);
    expect(rm.json().error.details).toMatchObject({ reason: "hash_failed" });
    expect(node.sim.read(id, "plugins/custom.jar")).not.toBeNull();
    expect(keptFiles(node, id)).toEqual([]);
    expect((await list(owner, id)).items.map((x) => x.filename)).toEqual(["custom.jar"]);
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
  });

  it("5: staged upload bytes that change between the check and the move are refused (and moved back)", async () => {
    const { t, owner, node } = await boot();
    const id = await paperServer(owner);
    await scanned(owner, id);
    const good = pluginJar("Uploaded", "1.0");
    const u = ExtensionUploadResponse.parse((await owner.post(`/servers/${id}/extensions/uploads`, { filename: "Uploaded.jar", sizeBytes: good.length })).json());
    const put = await t.app.inject({ method: "PUT", url: u.url, headers: { cookie: owner.cookieHeader(), "content-type": "application/octet-stream" }, payload: good });
    expect(put.statusCode, put.body).toBe(200);
    const staging = `.blockforge/extensions/uploads/${u.uploadId}.jar.part`;
    node.sim.options = { before: { "fs.rename": (p) => { if (p.from === staging) node.sim.put(id, staging, "SWAPPED-AFTER-CHECK"); } } };
    const done = await owner.post(`/servers/${id}/extensions/uploads/${u.uploadId}/complete`, {});
    node.sim.options = {};
    expect(done.statusCode, done.body).toBe(409);
    expect(done.json().error.details).toMatchObject({ reason: "upload_changed" });
    expect(node.sim.read(id, "plugins/Uploaded.jar")).toBeNull();
    expect(node.sim.read(id, staging)).toBe("SWAPPED-AFTER-CHECK");
    expect((await testPool().query("SELECT count(*)::int AS n FROM installed_extensions WHERE server_id = $1", [id])).rows[0].n).toBe(0);
    const { rows } = await testPool().query("SELECT outcome, details FROM audit_events WHERE action = 'server.extension.upload.complete' ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toMatchObject({ outcome: "failed", details: { reason: "upload_changed" } });
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
  });

  it("6: an install never renames over a file that appeared at the destination during the download", async () => {
    const { owner, node, up } = await boot();
    const id = await paperServer(owner);
    await scanned(owner, id);
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    node.sim.options = { before: { "artifact.fetch": () => node.sim.put(id, "plugins/Gamma-1.0.jar", "APPEARED-DURING-DOWNLOAD") } };
    const job = await waitJob(owner, await install(owner, id, "gammapl"));
    node.sim.options = {};
    expect(job.status).toBe("failed");
    expect(job.error).toMatchObject({ code: "CONFLICT" });
    expect(node.sim.read(id, "plugins/Gamma-1.0.jar")).toBe("APPEARED-DURING-DOWNLOAD");
    expect([...node.sim.files(id).keys()].filter((k) => k.startsWith(".blockforge/extensions/fetch/"))).toEqual([]);
  });

  it("keptAreaPath accepts only files directly inside the keep area", () => {
    expect(keptAreaPath(".blockforge/extensions/kept/a.jar")).toBe(".blockforge/extensions/kept/a.jar");
    expect(keptAreaPath("./.blockforge//extensions/kept/a.jar")).toBe(".blockforge/extensions/kept/a.jar");
    for (const bad of [
      ".blockforge/extensions/kept/",
      ".blockforge/extensions/kept",
      ".blockforge/extensions/kept-evil/x.jar",
      ".blockforge/extensions/keptx.jar",
      ".blockforge/extensions/kept/../../../plugins/a.jar",
      ".blockforge/extensions/kept/sub/a.jar",
      "/.blockforge/extensions/kept/a.jar",
      ".blockforge\\extensions\\kept\\a.jar",
      "plugins/a.jar",
    ]) {
      expect(keptAreaPath(bad), bad).toBeNull();
    }
  });

  it("the reconciler keeps following the workload during a plugin/mod change (exit → crashed)", async () => {
    const { owner, node, up } = await boot();
    const id = await runningServer(owner);
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    node.sim.options = { delay: { "artifact.fetch": 1500 } };
    const job = await install(owner, id, "gammapl");
    await poll(async () => (await owner.get(`/servers/${id}`)).json().activeOperation === "extensions", 5000, 20);
    node.sim.exit(id, 1);
    await poll(async () => (await owner.get(`/servers/${id}`)).json().state === "crashed", 5000, 50);
    expect((await waitJob(owner, job)).status).toBe("succeeded");
    node.sim.options = {};
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ state: "crashed", activeOperation: null });
  });

  it("round 4: no cleanup on a crashed server (the agent's restart policy may restart it): undo skipped, no file touched", async () => {
    const { owner, node, up } = await boot();
    const id = await runningServer(owner);
    const original = pluginJar("Gamma", "0.9-local");
    node.sim.put(id, "plugins/Gamma-1.0.jar", original);
    await scanned(owner, id);
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    let mark = 0;
    node.sim.options = {
      before: {
        "artifact.fetch": async () => {
          // Kill pre-empts; then the server is reported crashed (lock free) when the download returns.
          const k = await owner.post(`/servers/${id}/actions`, { action: "kill" });
          expect((await waitJob(owner, k.json().jobId)).status).toBe("succeeded");
          await testPool().query("UPDATE servers SET state = 'crashed' WHERE id = $1", [id]);
          mark = node.agent.commands.length;
        },
      },
    };
    const job = await install(owner, id, "gammapl");
    const ej = await waitJob(owner, job);
    node.sim.options = {};
    expect(ej.status).toBe("failed");
    expect(ej.error).toMatchObject({ code: "PREEMPTED_UNDO_SKIPPED" });
    expect(fileOps(node, mark)).toEqual([]);
    expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null, state: "crashed" });
    const [kept] = keptFiles(node, id);
    const rows = (await testPool().query("SELECT status, kept_path, kept_sha512, error FROM extension_history WHERE job_id = $1", [job])).rows;
    expect(rows).toEqual([{ status: "failed", kept_path: kept, kept_sha512: sha512(original), error: expect.stringContaining("no file was touched") }]);
  });

  describe("round 4: resumed undo records", () => {
    /** A failed install job whose undo record says `started`, as a crash leaves it; `steps`/`done` as given. */
    async function crashedUndo(t: TestApp, owner: ApiClient, node: SimNodeHandle, up: FakeUpstreams, id: string, undo: (ids: { entryId: string; keptPath: string }) => Record<string, unknown>) {
      const gamma = up.projects.get("GammaPl")!.versions[0]!;
      node.sim.artifacts.set(gamma.url, Buffer.from("tampered on the CDN"));
      const jobId = await install(owner, id, "gammapl");
      expect((await waitJob(owner, jobId)).status).toBe("failed");
      const entryId = stableId(jobId, "apply:plugins/Gamma-1.0.jar");
      const keptPath = `${KEPT}${entryId}.jar`;
      await crashInto(t, id, jobId, { undo: { install: { entries: [], started: true, error: { code: "CHECKSUM_MISMATCH", message: "install: sha512 mismatch" }, done: [], failed: [], notes: [], ...undo({ entryId, keptPath }) } } });
      return { jobId, entryId, keptPath };
    }
    const entryOf = (entryId: string, keptPath: string, sha: string) => ({ id: entryId, action: "update", extensionId: null, extensionName: "Gamma", path: "plugins/Gamma-1.0.jar", from: null, to: null, keptPath, keptSha512: sha });

    it("a crash after the cleanup hold committed: the job re-adopts its token, finishes the undo and releases it", async () => {
      const { t, owner, node, up } = await boot();
      const id = await paperServer(owner);
      const original = pluginJar("Gamma", "0.9-local");
      node.sim.put(id, "plugins/Gamma-1.0.jar", original);
      await scanned(owner, id);
      up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
      for (const variant of ["hold committed", "token recorded, hold not committed"] as const) {
        const token = "00000000-0000-4000-8000-0000000c1ea0";
        const { jobId, keptPath } = await crashedUndo(t, owner, node, up, id, ({ entryId, keptPath }) => ({
          steps: [{ kind: "restore", kept: keptPath, sha512: sha512(original), path: "plugins/Gamma-1.0.jar", entryId }],
          entries: [entryOf(entryId, keptPath, sha512(original))],
          cleanupToken: token,
        }));
        node.sim.files(id).delete("plugins/Gamma-1.0.jar");
        node.sim.put(id, keptPath, original);
        if (variant === "hold committed") await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = NULL, operation_token = $2, operation_started_at = now() WHERE id = $1", [id, token]);
        else await testPool().query("UPDATE servers SET active_operation = NULL, active_job_id = NULL WHERE id = $1", [id]);
        // Start is blocked by the leaked hold until the job resumes.
        if (variant === "hold committed") expect((await owner.post(`/servers/${id}/actions`, { action: "start" })).statusCode).toBe(409);
        await t.ctx.jobs.start();
        const row = await t.ctx.jobs.waitForCompletion(jobId);
        expect(row.status, variant).toBe("failed");
        expect(row.error, variant).toMatchObject({ code: "CHECKSUM_MISMATCH" });
        expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(original), variant).toBe(true);
        expect(node.sim.read(id, keptPath), variant).toBeNull();
        const rows = (await testPool().query("SELECT status, kept_path FROM extension_history WHERE job_id = $1", [jobId])).rows;
        expect(rows, variant).toEqual([{ status: "failed", kept_path: null }]);
        expect((await owner.get(`/servers/${id}`)).json(), variant).toMatchObject({ activeOperation: null, activeJobId: null });
        const start = await owner.post(`/servers/${id}/actions`, { action: "start" });
        expect((await waitJob(owner, start.json().jobId)).status, variant).toBe("succeeded");
        const stop = await owner.post(`/servers/${id}/actions`, { action: "stop" });
        expect((await waitJob(owner, stop.json().jobId)).status).toBe("succeeded");
        await scanned(owner, id);
      }
    });

    it("finalize releases a recorded cleanup hold the job never got to release", async () => {
      const { t, owner, node, up } = await boot();
      const id = await paperServer(owner);
      await scanned(owner, id);
      up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
      const token = "00000000-0000-4000-8000-0000000c1ea1";
      const { jobId } = await crashedUndo(t, owner, node, up, id, () => ({ steps: [], cleanupToken: token }));
      // The resumed undo finds a running server: the hold cannot be re-adopted (it is released, nothing touched).
      await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = NULL, operation_token = $2, operation_started_at = now(), state = 'running' WHERE id = $1", [id, token]);
      await t.ctx.jobs.start();
      expect((await t.ctx.jobs.waitForCompletion(jobId)).status).toBe("failed");
      expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
    });

    it("crash between the quarantine rename and the delete: the resumed undo deletes the quarantined file", async () => {
      const { t, owner, node, up } = await boot();
      const id = await paperServer(owner);
      await scanned(owner, id);
      up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
      const written = Buffer.from("WRITTEN-BY-THE-JOB");
      const quarantine = ".blockforge/extensions/fetch/0000-quarantined.delete";
      const { jobId } = await crashedUndo(t, owner, node, up, id, () => ({ steps: [{ kind: "delete", path: "plugins/Gamma-1.0.jar", sha512: sha512(written), quarantine }] }));
      node.sim.put(id, quarantine, written);
      await t.ctx.jobs.start();
      const row = await t.ctx.jobs.waitForCompletion(jobId);
      expect(row.status).toBe("failed");
      expect(row.error).toMatchObject({ code: "CHECKSUM_MISMATCH", message: expect.not.stringContaining("undo:") });
      expect(node.sim.read(id, quarantine)).toBeNull();
      expect(node.sim.read(id, "plugins/Gamma-1.0.jar")).toBeNull();
    });

    it("FILE_ORPHANED: a file that changed in quarantine and cannot be put back is reported with its quarantine path", async () => {
      const { t, owner, node, up } = await boot();
      const id = await paperServer(owner);
      await scanned(owner, id);
      up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
      const written = Buffer.from("WRITTEN-BY-THE-JOB");
      const { jobId } = await crashedUndo(t, owner, node, up, id, () => ({ steps: [{ kind: "delete", path: "plugins/Gamma-1.0.jar", sha512: sha512(written) }] }));
      node.sim.put(id, "plugins/Gamma-1.0.jar", written);
      node.sim.options = {
        before: {
          // The file changes on its way into quarantine, and its old name is taken before it can go back.
          "fs.rename": (p) => {
            if (String(p.to).endsWith(".delete")) node.sim.put(id, "plugins/Gamma-1.0.jar", "CHANGED-IN-FLIGHT");
          },
          "fs.hash": (p) => {
            const q = (p.paths as string[])[0]!;
            if (q.endsWith(".delete") && node.sim.read(id, q) !== null && node.sim.read(id, "plugins/Gamma-1.0.jar") === null) node.sim.put(id, "plugins/Gamma-1.0.jar", "OCCUPIER");
          },
        },
      };
      await t.ctx.jobs.start();
      const row = await t.ctx.jobs.waitForCompletion(jobId);
      node.sim.options = {};
      expect(row.status).toBe("failed");
      const quarantined = [...node.sim.files(id).keys()].filter((k) => k.endsWith(".delete"));
      expect(quarantined).toHaveLength(1);
      expect(node.sim.read(id, quarantined[0]!)).toBe("CHANGED-IN-FLIGHT");
      expect((row.error as { message: string }).message).toContain(`it is at ${quarantined[0]}`);
      const { rows } = await testPool().query("SELECT error FROM extension_history WHERE job_id = $1", [jobId]);
      expect(rows).toHaveLength(0); // no history entries recorded for this crafted record: the job error carries it
    });

    it("resume after a restore that completed but was not recorded: one failed row, jar in place, nothing left in the keep area", async () => {
      const { t, owner, node, up } = await boot();
      const id = await paperServer(owner);
      const original = pluginJar("Gamma", "0.9-local");
      node.sim.put(id, "plugins/Gamma-1.0.jar", original);
      await scanned(owner, id);
      up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
      const { jobId, keptPath } = await crashedUndo(t, owner, node, up, id, ({ entryId, keptPath }) => ({
        steps: [{ kind: "restore", kept: keptPath, sha512: sha512(original), path: "plugins/Gamma-1.0.jar", entryId }],
        entries: [entryOf(entryId, keptPath, sha512(original))],
      }));
      // The rename already happened: the jar is at its place, the keep path is gone.
      node.sim.put(id, "plugins/Gamma-1.0.jar", original);
      await t.ctx.jobs.start();
      const row = await t.ctx.jobs.waitForCompletion(jobId);
      expect(row.status).toBe("failed");
      expect(row.error).toMatchObject({ code: "CHECKSUM_MISMATCH", message: expect.not.stringContaining("KEPT") });
      expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(original)).toBe(true);
      expect(node.sim.read(id, keptPath)).toBeNull();
      const rows = (await testPool().query("SELECT status, kept_path FROM extension_history WHERE job_id = $1", [jobId])).rows;
      expect(rows).toEqual([{ status: "failed", kept_path: null }]);
    });

    it("round 4 minors: resume with mismatched quarantined bytes → FILE_ORPHANED (never counted as deleted)", async () => {
      const { t, owner, node, up } = await boot();
      const id = await paperServer(owner);
      await scanned(owner, id);
      up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
      const quarantine = ".blockforge/extensions/fetch/0000-mismatch.delete";
      const { jobId } = await crashedUndo(t, owner, node, up, id, () => ({ steps: [{ kind: "delete", path: "plugins/Gamma-1.0.jar", sha512: sha512("WRITTEN-BY-THE-JOB"), quarantine }] }));
      node.sim.put(id, quarantine, "OTHER-BYTES");
      await t.ctx.jobs.start();
      const row = await t.ctx.jobs.waitForCompletion(jobId);
      expect(row.status).toBe("failed");
      expect((row.error as { message: string }).message).toContain(`it is left at ${quarantine}`);
      expect(node.sim.read(id, quarantine)).toBe("OTHER-BYTES");
    });

    it("round 4 minors: a re-adopted hour-old cleanup hold survives the stale-hold sweep during the undo", async () => {
      const { t, owner, node, up } = await boot();
      const id = await paperServer(owner);
      const original = pluginJar("Gamma", "0.9-local");
      node.sim.put(id, "plugins/Gamma-1.0.jar", original);
      await scanned(owner, id);
      up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
      const token = "00000000-0000-4000-8000-0000000c1ea2";
      const { jobId, keptPath } = await crashedUndo(t, owner, node, up, id, ({ entryId, keptPath }) => ({
        steps: [{ kind: "restore", kept: keptPath, sha512: sha512(original), path: "plugins/Gamma-1.0.jar", entryId }],
        entries: [entryOf(entryId, keptPath, sha512(original))],
        cleanupToken: token,
      }));
      node.sim.files(id).delete("plugins/Gamma-1.0.jar");
      node.sim.put(id, keptPath, original);
      await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = NULL, operation_token = $2, operation_started_at = now() - interval '1 hour' WHERE id = $1", [id, token]);
      let swept = false;
      node.sim.options = {
        before: {
          // The sweep runs while the undo hashes the kept jar, i.e. between the fence check and the rename.
          "fs.hash": async (p) => {
            if (swept || !String((p.paths as string[])[0]).startsWith(KEPT)) return;
            swept = true;
            await t.tasks.maintenance!.runNow();
          },
        },
      };
      await t.ctx.jobs.start();
      const row = await t.ctx.jobs.waitForCompletion(jobId);
      node.sim.options = {};
      expect(swept).toBe(true);
      expect(row.error).toMatchObject({ code: "CHECKSUM_MISMATCH" });
      expect(node.sim.files(id).get("plugins/Gamma-1.0.jar")!.data.equals(original)).toBe(true);
      expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
    });

    it("round 4 minors: finalize releases a cleanup token recorded in the job state even when the undo never ran", async () => {
      const { t, owner, node, up } = await boot();
      const id = await paperServer(owner);
      await scanned(owner, id);
      up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
      const token = "00000000-0000-4000-8000-0000000c1ea3";
      const { jobId } = await crashedUndo(t, owner, node, up, id, () => ({ steps: [], started: false, error: null, cleanupToken: token }));
      await testPool().query("UPDATE jobs SET status = 'queued' WHERE id = $1", [jobId]);
      await testPool().query("UPDATE servers SET active_operation = 'extensions', active_job_id = NULL, operation_token = $2, operation_started_at = now() WHERE id = $1", [id, token]);
      // Cancelled while queued: finalize runs without any step (and so without fencedUndo).
      await t.ctx.jobs.cancel(jobId);
      expect((await t.ctx.jobs.getRow(jobId))!.status).toBe("cancelled");
      expect((await owner.get(`/servers/${id}`)).json()).toMatchObject({ activeOperation: null });
    });
  });

  it("round 4 minors: failed history commits keep the progress records; a resumed update writes exactly one history row", async () => {
    const { t, owner, node, up } = await boot();
    const id = await paperServer(owner);
    const v1 = up.projects.get("AlphaLib")!.versions[0]!;
    node.sim.put(id, "plugins/AlphaLib-1.0.0.jar", v1.jar);
    const alpha = (await scanned(owner, id)).items.find((x) => x.filename === "AlphaLib-1.0.0.jar")!;
    const v2 = up.addVersion("AlphaLib", { id: "AlphaV20", number: "2.0.0", filename: "AlphaLib-2.0.0.jar", jar: pluginJar("AlphaLib", "2.0.0") });
    up.addVersion("GammaPl", { id: "GammaV10", number: "1.0", filename: "Gamma-1.0.jar", jar: pluginJar("Gamma", "1.0") });
    const pool = testPool();
    await pool.query("CREATE OR REPLACE FUNCTION bf_test_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$");
    await pool.query("CREATE TRIGGER bf_test_fail_history BEFORE INSERT ON extension_history FOR EACH ROW EXECUTE FUNCTION bf_test_fail_history()");
    let updateJob: string;
    try {
      // Install: the completing commit fails → the journal and undo record stay persisted.
      const inst = await install(owner, id, "gammapl");
      expect((await waitJob(owner, inst)).status).toBe("failed");
      const { rows: st } = await pool.query("SELECT state FROM jobs WHERE id = $1", [inst]);
      expect(Object.keys(st[0].state)).toEqual(expect.arrayContaining(["journal", "undo"]));
      // Update: the history commit fails → the plan is not marked done.
      const apply = await owner.post(`/servers/${id}/extensions/updates/apply`, { extensionIds: [alpha.id] });
      updateJob = apply.json().jobId as string;
      const uj = await waitJob(owner, updateJob);
      expect(uj.status).toBe("failed");
      expect(uj.error).toMatchObject({ code: "COMMIT_FAILED" });
      const { rows: us } = await pool.query("SELECT state FROM jobs WHERE id = $1", [updateJob]);
      expect(us[0].state.done ?? []).toEqual([]);
      expect(us[0].state.results ?? []).toEqual([]);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS bf_test_fail_history ON extension_history");
      await pool.query("DROP FUNCTION IF EXISTS bf_test_fail_history()");
    }
    // Resume the update (as after a crash): the plan is re-checked and its history written once.
    await t.ctx.jobs.stop();
    await pool.query("UPDATE jobs SET status = 'running', finished_at = NULL, result = NULL, error = NULL WHERE id = $1", [updateJob]);
    await pool.query("UPDATE job_steps SET status = CASE WHEN key = 'plan' THEN 'succeeded' WHEN key = 'apply' THEN 'running' ELSE 'pending' END, finished_at = NULL WHERE job_id = $1", [updateJob]);
    await pool.query("UPDATE servers SET active_operation = 'extensions', active_job_id = $2 WHERE id = $1", [id, updateJob]);
    await pool.query("UPDATE extension_scans SET active_job_id = $2 WHERE server_id = $1", [id, updateJob]);
    const fetched = node.sim.fetched.length;
    await t.ctx.jobs.start();
    expect((await t.ctx.jobs.waitForCompletion(updateJob)).status).toBe("succeeded");
    expect(node.sim.fetched.length).toBe(fetched);
    const { rows } = await pool.query("SELECT action, status FROM extension_history WHERE job_id = $1", [updateJob]);
    expect(rows).toEqual([{ action: "update", status: "succeeded" }]);
    expect(node.sim.files(id).get("plugins/AlphaLib-2.0.0.jar")!.data.equals(v2.jar)).toBe(true);
  });

  it("round 4: enable/disable refuses a file it cannot hash (nothing renamed)", async () => {
    const { owner, node } = await boot();
    const id = await paperServer(owner);
    node.sim.put(id, "plugins/custom.jar", pluginJar("Custom", "1.0"));
    const custom = (await scanned(owner, id)).items[0]!;
    node.sim.options = { ioErrorPaths: ["plugins/custom.jar"] };
    const r = await owner.patch(`/servers/${id}/extensions/${custom.id}`, { enabled: false });
    node.sim.options = {};
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details).toMatchObject({ reason: "hash_failed" });
    expect(node.sim.read(id, "plugins/custom.jar")).not.toBeNull();
    expect(node.sim.read(id, "plugins/custom.jar.disabled")).toBeNull();
  });
});
