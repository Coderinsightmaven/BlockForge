import { createHash } from "node:crypto";
import { Backup, Server, TransferUrlResponse } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { catalogOptions, connectSimNode, paperRequest, poll, templateIdByKey, waitJob, type SimNodeHandle } from "../support/panel.js";
import { UiSocket } from "../support/realtime-client.js";

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
  const r = await startWithOwner({ background: true, catalog: cat.catalog, serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0, saveTimeoutMs: 1500 } });
  t = r.t;
  return r;
}

async function paperServer(t: TestApp, owner: ApiClient, node: SimNodeHandle, over: Record<string, unknown> = {}): Promise<string> {
  const templateId = await templateIdByKey(owner, "minecraft-java");
  const created = await owner.post("/servers", paperRequest(templateId, over));
  expect(created.statusCode, created.body).toBe(202);
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  void t;
  void node;
  return created.json().server.id as string;
}

const state = async (c: ApiClient, id: string) => Server.parse((await c.get(`/servers/${id}`)).json()).state;
const list = async (c: ApiClient, id: string) => ((await c.get(`/servers/${id}/backups`)).json() as unknown[]).map((b) => Backup.parse(b));
const code = async (res: Promise<{ statusCode: number; json(): { error?: { code: string } } }>) => {
  const r = await res;
  return `${r.statusCode} ${r.json().error?.code ?? ""}`.trim();
};

/** Command types (and console lines) the sim received for a server, in order. */
function trail(node: SimNodeHandle, serverId: string): string[] {
  return node.agent.commands
    .filter((c) => (c.payload as { workloadId?: string }).workloadId === serverId)
    .map((c) => (c.type === "workload.console" ? `console:${(c.payload as { line: string }).line}` : c.type));
}

describe("backups (local storage)", () => {
  it("backs up a running Minecraft server with save-off / save-all flush / save-on and publishes progress", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents });
    const id = await paperServer(t, owner, node);
    node.sim.put(id, "world/level.dat", "level");
    node.sim.put(id, "logs/latest.log", "noise");
    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    expect((await ui.subscribe(`server:${id}`)).op).toBe("subscribed");

    const before = trail(node, id).length;
    const res = await owner.post(`/servers/${id}/backups`, { name: "nightly", ignore: ["logs/"] });
    expect(res.statusCode, res.body).toBe(202);
    expect(Backup.parse(res.json().backup)).toMatchObject({ name: "nightly", status: "pending", storage: "local", locked: false, createdByName: "owner", createdBy: expect.any(String) });
    expect(await state(owner, id)).toBe("backing_up");
    expect((await waitJob(owner, res.json().jobId)).status).toBe("succeeded");

    const [b] = await list(owner, id);
    expect(b).toMatchObject({ status: "completed", consistency: "save-flush", skippedSymlinks: 0, ignored: ["logs/"] });
    const archive = node.sim.backupArchives.get(`${id}:${b!.id}`)!;
    expect(b!.sha256).toBe(archive.sha256);
    expect(b!.sizeBytes).toBe(archive.bytes.length);
    expect(Object.keys(archive.files)).toContain("world/level.dat");
    expect(Object.keys(archive.files).some((f) => f.startsWith("logs/"))).toBe(false);
    // save-off is confirmed before save-all; the final state comes from the real workload status (H8).
    expect(trail(node, id).slice(before)).toEqual(["workload.status", "console:save-off", "console:save-all flush", "backup.create", "console:save-on", "workload.status"]);
    expect(await state(owner, id)).toBe("running");
    const frame = await ui.waitForEvent(`server:${id}`, "backup.updated", 5000, (d) => (d as Backup).status === "completed");
    expect((frame.data as Backup).id).toBe(b!.id);
    expect(ui.invalid).toEqual([]);
    const { rows: ev } = await testPool().query("SELECT type FROM events WHERE subject_id = $1 AND type LIKE 'backup.%' ORDER BY id", [id]);
    expect(ev.map((e) => e.type)).toEqual(["backup.started", "backup.completed"]);

    // No save confirmation: the backup fails, but save-on is still sent and the server keeps running.
    node.sim.options = { saveConfirm: false };
    const mark = trail(node, id).length;
    const failed = await owner.post(`/servers/${id}/backups`, { name: "no-confirm" });
    const fj = await waitJob(owner, failed.json().jobId);
    expect(fj.status).toBe("failed");
    expect(fj.error).toMatchObject({ code: "SAVE_TIMEOUT" });
    // save-on first; then the state is settled from the agent and any partial archive is removed.
    expect(trail(node, id).slice(mark)).toEqual(["workload.status", "console:save-off", "console:save-all flush", "console:save-on", "workload.status", "backup.delete"]);
    expect((await list(owner, id)).find((x) => x.name === "no-confirm")).toMatchObject({ status: "failed", error: expect.stringContaining("did not confirm") });
    expect(await state(owner, id)).toBe("running");

    // Archive failure (disk reserve): save-on again, failed row, server running.
    node.sim.options = { fail: { "backup.create": { code: "QUOTA_EXCEEDED", message: "free disk below the reserve" } } };
    const mark2 = trail(node, id).length;
    const quota = await owner.post(`/servers/${id}/backups`, { name: "quota" });
    expect((await waitJob(owner, quota.json().jobId)).error).toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(trail(node, id).slice(mark2)).toEqual(["workload.status", "console:save-off", "console:save-all flush", "backup.create", "console:save-on", "workload.status", "backup.delete"]);
    expect(await state(owner, id)).toBe("running");
  });

  it("stops and restarts for stopServer, archives proxies live and stopped servers as stopped", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents, ports: "25565-25570" });
    const id = await paperServer(t, owner, node);
    const mark = trail(node, id).length;
    const r = await owner.post(`/servers/${id}/backups`, { stopServer: true });
    expect((await waitJob(owner, r.json().jobId)).status).toBe("succeeded");
    expect(trail(node, id).slice(mark)).toEqual(["workload.status", "workload.stop", "backup.create", "workload.ensure", "workload.start", "workload.status"]);
    expect((await list(owner, id))[0]).toMatchObject({ consistency: "stopped", status: "completed" });
    expect(await state(owner, id)).toBe("running");

    // Velocity is archived live (no save cycle).
    node.sim.options = { readyLine: "[12:00:00 INFO]: Done (1.0s)!" };
    const velocity = await owner.post("/servers", {
      name: "Proxy",
      slug: "proxy-b",
      templateId: await templateIdByKey(owner, "velocity"),
      placement: { mode: "auto" },
      memoryLimitBytes: 1024 ** 3,
      minecraft: { software: "velocity", version: "4.2.0" },
    });
    expect((await waitJob(owner, velocity.json().jobId)).status).toBe("succeeded");
    const vid = velocity.json().server.id as string;
    const vb = await owner.post(`/servers/${vid}/backups`, {});
    expect((await waitJob(owner, vb.json().jobId)).status).toBe("succeeded");
    expect((await list(owner, vid))[0]).toMatchObject({ consistency: "live" });
    expect(trail(node, vid).filter((x) => x.startsWith("console:"))).toEqual([]);

    // A stopped server stays stopped.
    const stop = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    await waitJob(owner, stop.json().jobId);
    const sb = await owner.post(`/servers/${id}/backups`, {});
    expect((await waitJob(owner, sb.json().jobId)).status).toBe("succeeded");
    expect((await list(owner, id))[0]).toMatchObject({ consistency: "stopped" });
    expect(await state(owner, id)).toBe("stopped");
  });

  it("enforces limits, rotation and locks; downloads, restores (with a safety backup) and deletes", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents });
    const alice = await createUserClient(t, owner, "alice@example.com", []);
    const aliceId = (await alice.get("/auth/me")).json().user.id as string;
    const id = await paperServer(t, owner, node, { ownerId: aliceId, startup: "manual", backupLimit: 2 });
    node.sim.put(id, "world/level.dat", "v1");
    const make = async (c: ApiClient, body: Record<string, unknown> = {}) => {
      const r = await c.post(`/servers/${id}/backups`, body);
      if (r.statusCode !== 202) return r;
      expect((await waitJob(owner, r.json().jobId)).status).toBe("succeeded");
      return r;
    };
    const first = (await make(alice, { name: "first" })).json().backup.id as string;
    node.sim.put(id, "world/level.dat", "v2");
    await make(alice, { name: "second" });
    // At the limit: refused without rotate; rotate deletes the oldest unlocked completed backup.
    expect(await code(alice.post(`/servers/${id}/backups`, { name: "third" }))).toBe("409 CONFLICT");
    expect((await alice.patch(`/servers/${id}/backups/${first}`, { locked: true })).json()).toMatchObject({ locked: true });
    await make(alice, { name: "third", rotate: true });
    expect((await list(alice, id)).map((b) => b.name).sort()).toEqual(["first", "third"]);
    expect([...node.sim.backupArchives.keys()].filter((k) => k.startsWith(id)).length).toBe(2);
    // Everything locked → rotation impossible.
    const third = (await list(alice, id)).find((b) => b.name === "third")!;
    await alice.patch(`/servers/${id}/backups/${third.id}`, { locked: true });
    expect(await code(alice.post(`/servers/${id}/backups`, { rotate: true }))).toBe("409 CONFLICT");
    expect(await code(alice.delete(`/servers/${id}/backups/${first}`))).toBe("409 CONFLICT");
    // Administrators are not bound by the limit.
    const adminMade = await owner.post(`/servers/${id}/backups`, { name: "admin" });
    expect(adminMade.statusCode).toBe(202);
    await waitJob(owner, adminMade.json().jobId);

    // Download (local): single-use URL streamed from the agent.
    const url = TransferUrlResponse.parse((await alice.get(`/servers/${id}/backups/${first}/download`)).json());
    const got = await t.app.inject({ method: "GET", url: url.url, headers: { cookie: alice.cookieHeader() } });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("application/gzip");
    expect(createHash("sha256").update(got.rawPayload).digest("hex")).toBe((await list(alice, id)).find((b) => b.id === first)!.sha256);
    expect((await t.app.inject({ method: "GET", url: url.url, headers: { cookie: alice.cookieHeader() } })).statusCode).toBe(404);

    // Restore "first" (v1): no safety backup (alice is at her limit → skipped with a warning).
    node.sim.put(id, "world/level.dat", "v3");
    node.sim.put(id, "extra.txt", "not in the backup");
    const restore = await alice.post(`/servers/${id}/backups/${first}/restore`, { truncate: true, startAfter: true });
    expect(restore.statusCode, restore.body).toBe(202);
    const rj = await waitJob(owner, restore.json().jobId);
    expect(rj.status, JSON.stringify(rj)).toBe("succeeded");
    expect(node.sim.read(id, "world/level.dat")).toBe("v1");
    expect(node.sim.read(id, "extra.txt")).toBeNull();
    expect(await state(alice, id)).toBe("running");
    expect(JSON.stringify((await owner.get(`/jobs/${restore.json().jobId}/logs`)).json())).toContain("Safety backup skipped");

    // Restoring a running server (admin, room for a safety backup): the locked safety backup is taken
    // first with the save cycle, then the server is stopped (stopping → stopped → restoring).
    node.sim.put(id, "world/level.dat", "v4");
    const mark = trail(node, id).length;
    const r2 = await owner.post(`/servers/${id}/backups/${first}/restore`, { startAfter: false });
    expect(r2.statusCode, r2.body).toBe(202);
    expect(await state(owner, id)).toBe("stopping");
    expect((await waitJob(owner, r2.json().jobId)).status).toBe("succeeded");
    expect(trail(node, id).slice(mark)).toEqual([
      "workload.status",
      "console:save-off",
      "console:save-all flush",
      "backup.create",
      "console:save-on",
      "workload.status",
      "workload.stop",
      "backup.restore",
    ]);
    const safety = (await list(owner, id)).find((b) => b.name.startsWith("Safety backup"))!;
    expect(safety).toMatchObject({ locked: true, status: "completed", consistency: "save-flush", createdByName: "owner" });
    expect(node.sim.backupArchives.get(`${id}:${safety.id}`)!.files["world/level.dat"]).toBe("v4");
    expect(node.sim.read(id, "world/level.dat")).toBe("v1");
    expect(await state(owner, id)).toBe("stopped");

    // A failing restore leaves the server stopped with a clear error.
    node.sim.options = { fail: { "backup.restore": { code: "CHECKSUM_MISMATCH", message: "sha256 mismatch" } } };
    const r3 = await owner.post(`/servers/${id}/backups/${first}/restore`, { safetyBackup: false });
    const fj = await waitJob(owner, r3.json().jobId);
    expect(fj.status).toBe("failed");
    expect(fj.error).toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(await state(owner, id)).toBe("stopped");
    node.sim.options = {};

    // Delete (unlocked) removes archive and row; deleting the server removes every backup.
    await owner.patch(`/servers/${id}/backups/${first}`, { locked: false });
    const del = await owner.delete(`/servers/${id}/backups/${first}`);
    expect(del.statusCode).toBe(202);
    expect((await waitJob(owner, del.json().jobId)).status).toBe("succeeded");
    expect(node.sim.backupArchives.has(`${id}:${first}`)).toBe(false);
    expect((await list(owner, id)).some((b) => b.id === first)).toBe(false);
    const remaining = (await list(owner, id)).length;
    expect(remaining).toBeGreaterThan(0);
    const delServer = await owner.delete(`/servers/${id}`);
    expect((await waitJob(owner, delServer.json().jobId)).status).toBe("succeeded");
    expect([...node.sim.backupArchives.keys()].some((k) => k.startsWith(id))).toBe(false);
    const { rows } = await testPool().query("SELECT count(*)::int AS n FROM backups WHERE server_id = $1", [id]);
    expect(rows[0].n).toBe(0);
    expect(trail(node, id).filter((x) => x === "backup.delete").length).toBeGreaterThanOrEqual(remaining);
  });

  it("disables backups for non-administrators at limit 0 and checks permissions", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents });
    const alice = await createUserClient(t, owner, "alice@example.com", []);
    const aliceId = (await alice.get("/auth/me")).json().user.id as string;
    const id = await paperServer(t, owner, node, { ownerId: aliceId, startup: "manual", backupLimit: 0 });
    expect(await code(alice.post(`/servers/${id}/backups`, {}))).toBe("403 FORBIDDEN");
    const viewer = await createUserClient(t, owner, "viewer@example.com", []);
    await alice.post(`/servers/${id}/subusers`, { user: "viewer", permissions: ["servers.view", "servers.backups.view"] });
    expect((await viewer.get(`/servers/${id}/backups`)).statusCode).toBe(200);
    expect(await code(viewer.post(`/servers/${id}/backups`, {}))).toBe("403 FORBIDDEN");
    const made = await owner.post(`/servers/${id}/backups`, {});
    await waitJob(owner, made.json().jobId);
    const b = made.json().backup.id as string;
    expect(await code(viewer.get(`/servers/${id}/backups/${b}/download`))).toBe("403 FORBIDDEN");
    expect(await code(viewer.post(`/servers/${id}/backups/${b}/restore`, {}))).toBe("403 FORBIDDEN");
    await poll(async () => (await list(owner, id))[0]?.status === "completed");
  });
});
