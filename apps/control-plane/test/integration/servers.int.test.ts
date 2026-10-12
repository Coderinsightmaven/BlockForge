import { Job, PlacementPreviewResponse, Server, ServerStartup } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, responseLog, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import {
  catalogOptions,
  connectSimNode,
  eggFixture,
  paperRequest,
  poll,
  SFTP_FACT,
  templateIdByKey,
  waitJob,
} from "../support/panel.js";
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

const FAST_JOBS = { serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 } };

async function boot() {
  const cat = catalogOptions();
  const r = await startWithOwner({ background: true, catalog: cat.catalog, ...FAST_JOBS });
  t = r.t;
  return { t: r.t, owner: r.owner, catalogCalls: cat.calls };
}

async function serverState(client: ApiClient, id: string): Promise<string> {
  return Server.parse((await client.get(`/servers/${id}`)).json()).state;
}

async function events(type: string, subjectId: string): Promise<number> {
  const { rows } = await testPool().query("SELECT count(*)::int AS n FROM events WHERE type = $1 AND subject_id = $2", [type, subjectId]);
  return rows[0].n as number;
}

describe("Minecraft server lifecycle (Paper via the catalogue, simulated node)", () => {
  it("creates, provisions, starts, stops, restarts, kills, detects crashes and deletes", async () => {
    const { t, owner, catalogCalls } = await boot();
    const node = await connectSimNode(t, owner, { agents });
    const templateId = await templateIdByKey(owner, "minecraft-java");

    const preview = PlacementPreviewResponse.parse((await owner.post("/servers/placement-preview", { memoryLimitBytes: 4 * 1024 ** 3 })).json());
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]).toMatchObject({ nodeId: node.nodeId, fits: true, freeAllocations: 6 });

    const ui = await UiSocket.open(t, owner);
    sockets.push(ui);
    expect((await ui.subscribe("servers")).op).toBe("subscribed");

    const req = paperRequest(templateId);
    const created = await owner.post("/servers", req, { "idempotency-key": "create-1" });
    expect(created.statusCode, created.body).toBe(202);
    const { server: s0, jobId } = created.json() as { server: Server; jobId: string };
    expect(Server.parse(s0)).toMatchObject({ state: "provisioning", nodeId: node.nodeId, software: "paper", minecraftVersion: "1.21.11" });
    expect(s0.address).toBe("10.0.0.5:25565");
    expect(s0.sftp).toEqual({ host: expect.any(String), port: SFTP_FACT.port, username: `owner.${s0.id.replace(/-/g, "").slice(0, 8)}`, hostKeyFingerprint: SFTP_FACT.hostKeyFingerprint });
    // Idempotent replay returns the same server and job; a different body under the same key is refused.
    const replay = await owner.post("/servers", req, { "idempotency-key": "create-1" });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().jobId).toBe(jobId);
    expect((await owner.post("/servers", paperRequest(templateId), { "idempotency-key": "create-1" })).statusCode).toBe(409);

    const job = await waitJob(owner, jobId);
    expect(job.status, JSON.stringify(job)).toBe("succeeded");
    const steps = Job.parse(job).steps.map((st) => [st.key, st.status]);
    expect(steps).toEqual([
      ["ensure", "succeeded"],
      ["download", "succeeded"],
      ["install", "skipped"],
      ["configure", "succeeded"],
      ["start", "succeeded"],
      ["ready", "succeeded"],
    ]);
    expect(await serverState(owner, s0.id)).toBe("running");

    // What the agent was asked to do.
    const spec = node.sim.ensured[0]!;
    expect(spec).toMatchObject({ workloadId: s0.id, kind: "minecraft" });
    expect(spec.ports).toEqual(expect.arrayContaining([expect.objectContaining({ hostPort: 25565, containerPort: 25565, protocol: "tcp" })]));
    expect(node.sim.fetched).toEqual([expect.objectContaining({ workloadId: s0.id, url: expect.stringMatching(/^https:\/\/fill-data\.papermc\.io\//), destPath: "server.jar" })]);
    expect(node.sim.read(s0.id, "eula.txt")).toMatch(/eula=true/);
    expect(node.sim.read(s0.id, "server.properties")).toMatch(/server-port=25565/);
    expect(catalogCalls.every((u) => u.startsWith("https://"))).toBe(true);

    // Events, reservation and audit.
    expect(await events("server.installed", s0.id)).toBe(1);
    expect(await events("server.provision.completed", s0.id)).toBe(1);
    const { rows: res } = await testPool().query("SELECT kind, expires_at FROM resource_reservations WHERE server_id = $1", [s0.id]);
    expect(res).toEqual([{ kind: "server", expires_at: null }]);
    const { rows: audit } = await testPool().query("SELECT details FROM audit_events WHERE action = 'server.create' AND target_id = $1", [s0.id]);
    expect(audit[0].details).toMatchObject({ allocation: "10.0.0.5:25565", eulaAccepted: true, template: "minecraft-java" });

    // server.updated is broadcast without per-user fields.
    const upd = await ui.waitForEvent("servers", "server.updated", 5000, (d) => (d as { id: string }).id === s0.id);
    expect(upd.data).not.toHaveProperty("myPermissions");
    expect(upd.data).not.toHaveProperty("sftp");
    expect(ui.invalid).toEqual([]);

    // Stop.
    const stop = await owner.post(`/servers/${s0.id}/actions`, { action: "stop" });
    expect(stop.statusCode).toBe(202);
    expect((await waitJob(owner, stop.json().jobId)).status).toBe("succeeded");
    expect(await serverState(owner, s0.id)).toBe("stopped");

    // Start, then a concurrent operation is refused while the first holds the lock.
    const start = await owner.post(`/servers/${s0.id}/actions`, { action: "start" });
    expect(start.statusCode).toBe(202);
    const clash = await owner.post(`/servers/${s0.id}/actions`, { action: "restart" });
    expect(clash.statusCode).toBe(409);
    expect((await waitJob(owner, start.json().jobId)).status).toBe("succeeded");
    expect(await serverState(owner, s0.id)).toBe("running");

    // Console: sent to the agent and audited.
    expect((await owner.post(`/servers/${s0.id}/console`, { command: "say hello" })).statusCode).toBe(204);
    expect(node.sim.consoleLines).toContainEqual({ workloadId: s0.id, line: "say hello" });
    const history = (await owner.get(`/servers/${s0.id}/console/history?lines=50`)).json();
    expect(JSON.stringify(history)).toContain("For help, type");

    // Restart and kill.
    const restart = await owner.post(`/servers/${s0.id}/actions`, { action: "restart", timeoutMs: 5000 });
    expect((await waitJob(owner, restart.json().jobId)).status).toBe("succeeded");
    expect(await serverState(owner, s0.id)).toBe("running");
    const kill = await owner.post(`/servers/${s0.id}/actions`, { action: "kill" });
    expect((await waitJob(owner, kill.json().jobId)).status).toBe("succeeded");
    expect(await serverState(owner, s0.id)).toBe("stopped");

    // Reconciler: a crash reported by the agent while running.
    const again = await owner.post(`/servers/${s0.id}/actions`, { action: "start" });
    expect((await waitJob(owner, again.json().jobId)).status).toBe("succeeded");
    node.sim.exit(s0.id, 1);
    await poll(async () => (await serverState(owner, s0.id)) === "crashed");
    await poll(async () => (await events("server.crashed", s0.id)) === 1);

    // Activity log shows the operations.
    const activity = (await owner.get(`/servers/${s0.id}/activity?limit=100`)).json().items as { action: string }[];
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(["server.create", "server.stop", "server.start", "server.restart", "server.kill", "server.console.command"]));

    // Delete: workload removed, allocation released, row gone.
    const del = await owner.delete(`/servers/${s0.id}?deleteData=true`);
    expect(del.statusCode).toBe(202);
    expect((await waitJob(owner, del.json().jobId)).status).toBe("succeeded");
    expect((await owner.get(`/servers/${s0.id}`)).statusCode).toBe(404);
    expect(node.sim.workloads.has(s0.id)).toBe(false);
    expect(node.sim.fs.has(s0.id)).toBe(false);
    const { rows: allocs } = await testPool().query("SELECT count(*)::int AS n FROM allocations WHERE server_id IS NOT NULL");
    expect(allocs[0].n).toBe(0);
    expect(await events("server.deleted", s0.id)).toBe(1);
  });

  it("marks a server crashed when it exits during start-up, and provision_failed when an install fails", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents, sim: { crashOnStart: 1 } });
    const templateId = await templateIdByKey(owner, "minecraft-java");
    const created = (await owner.post("/servers", paperRequest(templateId))).json() as { server: Server; jobId: string };
    const job = await waitJob(owner, created.jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toMatchObject({ code: "CRASHED", message: "the server exited during start-up (exit code 1)" });
    expect(await serverState(owner, created.server.id)).toBe("crashed");
    expect(Server.parse((await owner.get(`/servers/${created.server.id}`)).json()).lastExitCode).toBe(1);

    // Egg with a failing install script.
    const imported = await owner.post("/templates/import", { egg: eggFixture("ptero-egg-vanilla-minecraft.json"), category: "Minecraft" });
    expect(imported.statusCode, imported.body).toBe(201);
    node.sim.options = { installExitCode: 2, installLines: ["curl: (6) Could not resolve host"] };
    const egg = await owner.post("/servers", {
      name: "Egg",
      slug: "egg-fail",
      templateId: imported.json().template.id,
      placement: { mode: "node", nodeId: node.nodeId },
      memoryLimitBytes: 2 * 1024 ** 3,
      egg: { variables: { VANILLA_VERSION: "1.21.11" }, acceptEula: true },
    });
    expect(egg.statusCode, egg.body).toBe(202);
    const failed = await waitJob(owner, egg.json().jobId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({ code: "INSTALL_FAILED" });
    expect(await serverState(owner, egg.json().server.id)).toBe("provision_failed");
    expect(await events("server.install.failed", egg.json().server.id)).toBe(1);
    const logs = (await owner.get(`/jobs/${egg.json().jobId}/logs`)).json() as { items?: { message: string }[] } | { message: string }[];
    expect(JSON.stringify(logs)).toContain("[install] curl: (6) Could not resolve host");
  });

  it("refuses placement when no allocation is free and validates the template options", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents, ports: "25565" });
    const templateId = await templateIdByKey(owner, "minecraft-java");
    const first = await owner.post("/servers", paperRequest(templateId, { startup: "manual" }));
    expect(first.statusCode).toBe(202);
    const second = await owner.post("/servers", paperRequest(templateId));
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe("CAPACITY_EXCEEDED");
    expect(JSON.stringify(second.json().error.details)).toContain(node.nodeId);

    const noEula = await owner.post("/servers", paperRequest(templateId, { minecraft: { software: "paper", version: "1.21.11" } }));
    expect(noEula.statusCode).toBe(400);
    const velocityOnGame = await owner.post("/servers", paperRequest(templateId, { minecraft: { software: "velocity", version: "3.4.0" } }));
    expect(velocityOnGame.statusCode).toBe(400);
    const worldUpload = await owner.post("/servers", paperRequest(templateId, { minecraft: { software: "paper", version: "1.21.11", acceptEula: true, world: { mode: "upload", transferId: "00000000-0000-4000-8000-000000000001" } } }));
    expect(worldUpload.statusCode).toBe(400);
    expect(JSON.stringify(worldUpload.json().error.details)).toContain("minecraft.world");
    const unknownVersion = await owner.post("/servers", paperRequest(templateId, { minecraft: { software: "paper", version: "9.99", acceptEula: true } }));
    expect(unknownVersion.statusCode).toBe(404);

    // Manual startup: provisioned but not started.
    expect((await waitJob(owner, first.json().jobId)).status).toBe("succeeded");
    expect(await serverState(owner, first.json().server.id)).toBe("stopped");
  });
});

describe("Velocity proxies", () => {
  it("maps the primary port to Velocity's default until its config exists, then writes the bind", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents, ports: "25577-25578", sim: { readyLine: "[12:00:00 INFO]: Done (1.234s)!" } });
    const templateId = await templateIdByKey(owner, "velocity");
    const created = await owner.post("/servers", {
      name: "Proxy",
      slug: "proxy",
      templateId,
      placement: { mode: "auto" },
      memoryLimitBytes: 1024 ** 3,
      minecraft: { software: "velocity", version: "4.2.0" },
    });
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().server.id as string;
    const job = await waitJob(owner, created.json().jobId);
    expect(job.status, JSON.stringify(job)).toBe("succeeded");
    expect(Server.parse((await owner.get(`/servers/${id}`)).json())).toMatchObject({ kind: "proxy", state: "running", software: "velocity" });
    // No velocity.toml yet: host 25577 → container 25565 (Velocity's default bind).
    expect(node.sim.ensured[0]!.ports).toEqual(expect.arrayContaining([expect.objectContaining({ hostPort: 25577, containerPort: 25565, protocol: "tcp" })]));
    expect(node.sim.read(id, "eula.txt")).toBeNull();

    // Velocity wrote its config on first start; the next start sets the bind and maps 1:1.
    node.sim.put(id, "velocity.toml", ['config-version = "2.7"', 'bind = "0.0.0.0:25565"', 'motd = "<#09add3>A Velocity Server"', ""].join("\n"));
    const restart = await owner.post(`/servers/${id}/actions`, { action: "restart", timeoutMs: 5000 });
    expect((await waitJob(owner, restart.json().jobId)).status).toBe("succeeded");
    expect(node.sim.read(id, "velocity.toml")).toMatch(/bind = "0\.0\.0\.0:25577"/);
    expect(node.sim.read(id, "velocity.toml")).toContain("A Velocity Server");
    expect(node.sim.ensured.at(-1)!.ports).toEqual(expect.arrayContaining([expect.objectContaining({ hostPort: 25577, containerPort: 25577, protocol: "tcp" })]));
  });
});

describe("start-up failures", () => {
  it("names known blockers (EULA, port bind, Java version) and records exit code and OOM kills", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, {
      agents,
      sim: { crashOnStart: 0, startupLines: ["[12:00:01] [ServerMain/INFO]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info."] },
    });
    const templateId = await templateIdByKey(owner, "minecraft-java");
    const created = (await owner.post("/servers", paperRequest(templateId))).json() as { server: Server; jobId: string };
    const job = await waitJob(owner, created.jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toMatchObject({ code: "EULA_NOT_ACCEPTED", message: "the server stopped because the Minecraft EULA has not been accepted in eula.txt (exit code 0)" });
    const s = Server.parse((await owner.get(`/servers/${created.server.id}`)).json());
    expect(s).toMatchObject({ state: "crashed", lastExitCode: 0 });
    expect(s.lastCrashAt).not.toBeNull();
    const { rows: ev } = await testPool().query("SELECT data FROM events WHERE type = 'server.crashed' AND subject_id = $1", [s.id]);
    expect(ev[0].data).toMatchObject({ during: "provision", reason: "EULA_NOT_ACCEPTED", exitCode: 0, oomKilled: false });

    // Port bind failure on a start.
    node.sim.options = { crashOnStart: 0, startupLines: ["[12:00:02] [Server thread/WARN]: **** FAILED TO BIND TO PORT!"] };
    const start = await owner.post(`/servers/${s.id}/actions`, { action: "start" });
    const failed = await waitJob(owner, start.json().jobId);
    expect(failed.error).toMatchObject({ code: "PORT_BIND_FAILED" });
    expect(String((failed.error as { message: string }).message)).toContain("could not bind its port 25565");

    // OOM kill during start-up.
    node.sim.options = { crashOnStart: 137, oomOnStart: true };
    const oom = await waitJob(owner, (await owner.post(`/servers/${s.id}/actions`, { action: "start" })).json().jobId);
    expect(oom.error).toMatchObject({ code: "OOM_KILLED" });
    const { rows } = await testPool().query("SELECT state, last_exit_code, last_oom_killed FROM servers WHERE id = $1", [s.id]);
    expect(rows[0]).toEqual({ state: "crashed", last_exit_code: 137, last_oom_killed: true });

    // A normal start, then exits recorded by the reconciler (clean) and by stop/kill.
    node.sim.options = {};
    expect((await waitJob(owner, (await owner.post(`/servers/${s.id}/actions`, { action: "start" })).json().jobId)).status).toBe("succeeded");
    const kill = await waitJob(owner, (await owner.post(`/servers/${s.id}/actions`, { action: "kill" })).json().jobId);
    expect(kill.status).toBe("succeeded");
    expect(Server.parse((await owner.get(`/servers/${s.id}`)).json())).toMatchObject({ state: "stopped", lastExitCode: 137 });
    expect((await waitJob(owner, (await owner.post(`/servers/${s.id}/actions`, { action: "start" })).json().jobId)).status).toBe("succeeded");
    node.sim.exit(s.id, 0);
    await poll(async () => (await serverState(owner, s.id)) === "stopped");
    const { rows: after } = await testPool().query("SELECT last_exit_code, last_oom_killed FROM servers WHERE id = $1", [s.id]);
    expect(after[0]).toEqual({ last_exit_code: 0, last_oom_killed: false });
  });
});

describe("Minecraft eggs", () => {
  it("requires EULA acceptance, writes eula.txt before the first start and on reinstall, and uses Minecraft readiness + SLP", async () => {
    const r = await startWithOwner({ background: true, serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 5000 } });
    t = r.t;
    const owner = r.owner;
    // Velocity-style "Done (…)!" matches the Minecraft readiness parser but not the egg's done string.
    const node = await connectSimNode(r.t, owner, { agents, sim: { installCreates: { "server.jar": "jar" }, readyLine: "[12:00:00 INFO]: Done (2.5s)!", slpAfterReady: true } });
    const imported = await owner.post("/templates/import", { egg: eggFixture("ptero-egg-vanilla-minecraft.json"), category: "Minecraft" });
    const tpl = imported.json().template as { id: string; features: string[]; game: string };
    expect(tpl).toMatchObject({ game: "minecraft-java" });
    expect(tpl.features).toContain("eula");
    const body = { name: "Vanilla", slug: "vanilla", templateId: tpl.id, placement: { mode: "auto" }, memoryLimitBytes: 2 * 1024 ** 3, egg: { variables: { VANILLA_VERSION: "1.21.11" } } };

    const refused = await owner.post("/servers", body);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({ code: "VALIDATION_FAILED", details: { issues: [{ path: "egg.acceptEula" }] } });

    const created = await owner.post("/servers", { ...body, egg: { ...body.egg, acceptEula: true } });
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().server.id as string;
    const job = await waitJob(owner, created.json().jobId);
    expect(job.status, JSON.stringify(job)).toBe("succeeded");
    expect(await serverState(owner, id)).toBe("running");

    const eula = node.sim.read(id, "eula.txt") ?? "";
    expect(eula).toMatch(/^#accepted via BlockForge \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z by owner\neula=true\n$/);
    // Written before the server was started.
    const order = node.agent.commands.map((c) => (c.type === "fs.write" ? `fs.write:${(c.payload as { path: string }).path}` : c.type));
    expect(order.indexOf("fs.write:eula.txt")).toBeGreaterThan(-1);
    expect(order.indexOf("fs.write:eula.txt")).toBeLessThan(order.indexOf("workload.start"));
    const { rows } = await testPool().query("SELECT details FROM audit_events WHERE action = 'server.create' AND target_id = $1", [id]);
    expect(rows[0].details).toMatchObject({ eulaAccepted: true, eulaAcceptedBy: "owner" });
    // Ready through the Minecraft parser, then an SLP answer arrived (no "no Server List Ping" warning).
    const logs = JSON.stringify((await owner.get(`/jobs/${created.json().jobId}/logs`)).json());
    expect(logs).toContain("eula.txt written");
    expect(logs).not.toContain("no Server List Ping answer");

    // Plain starts do not rewrite eula.txt; reinstall does.
    node.sim.put(id, "eula.txt", "eula=false\n");
    const stop = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    await waitJob(owner, stop.json().jobId);
    const start = await owner.post(`/servers/${id}/actions`, { action: "start" });
    expect((await waitJob(owner, start.json().jobId)).status).toBe("succeeded");
    expect(node.sim.read(id, "eula.txt")).toBe("eula=false\n");
    const stop2 = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    await waitJob(owner, stop2.json().jobId);
    node.sim.files(id).delete("eula.txt");
    const re = await owner.post(`/servers/${id}/reinstall`);
    expect((await waitJob(owner, re.json().jobId)).status).toBe("succeeded");
    expect(node.sim.read(id, "eula.txt")).toMatch(/by owner\neula=true\n$/);

    // Templates without the eula feature do not need (or write) it.
    const ts = (await owner.post("/templates/import", { egg: eggFixture("ptero-egg-teamspeak3-server.json"), category: "Voice" })).json().template as { id: string; game: string; features: string[] };
    expect(ts.game).toBe("other");
    expect(ts.features).not.toContain("eula");
  });
});

describe("egg servers", () => {
  it("installs with the egg script, applies config files before every start and validates variables", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents, sim: { installCreates: { "server.jar": "jar bytes" } } });
    const imported = await owner.post("/templates/import", { egg: eggFixture("ptero-egg-vanilla-minecraft.json"), category: "Minecraft" });
    expect(imported.statusCode, imported.body).toBe(201);
    const tpl = imported.json().template as { id: string; variables: { envName: string }[] };

    const bad = await owner.post("/servers", {
      name: "Egg",
      slug: "egg-bad",
      templateId: tpl.id,
      placement: { mode: "auto" },
      memoryLimitBytes: 2 * 1024 ** 3,
      egg: { variables: { SERVER_JARFILE: "../evil.sh" }, acceptEula: true },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json().error.details)).toContain("egg.variables.SERVER_JARFILE");

    const created = await owner.post("/servers", {
      name: "Egg",
      slug: "egg-ok",
      templateId: tpl.id,
      placement: { mode: "auto" },
      memoryLimitBytes: 2 * 1024 ** 3,
      egg: { dockerImage: "ghcr.io/pterodactyl/yolks:java_21", variables: { VANILLA_VERSION: "1.21.11" }, acceptEula: true },
    });
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().server.id as string;
    const job = await waitJob(owner, created.json().jobId);
    expect(job.status, JSON.stringify(job)).toBe("succeeded");
    expect(await serverState(owner, id)).toBe("running");

    const install = node.sim.installs[0]!.payload as { image: string; entrypoint: string; script: string; env: Record<string, string> };
    expect(install).toMatchObject({ image: "ghcr.io/pterodactyl/installers:alpine", entrypoint: "ash" });
    expect(install.env).toMatchObject({ VANILLA_VERSION: "1.21.11", SERVER_JARFILE: "server.jar", SERVER_PORT: "25565", SERVER_MEMORY: "2048" });
    const spec = node.sim.ensured.at(-1)!;
    // The template's game is minecraft-java: SLP status and the JVM probe are enabled for the egg workload.
    expect(spec).toMatchObject({ kind: "minecraft", jvmProbe: true, image: "ghcr.io/pterodactyl/yolks:java_21", entrypoint: "image" });
    expect(spec.env).toMatchObject({ STARTUP: "java -Xms128M -XX:MaxRAMPercentage=95.0 -jar {{SERVER_JARFILE}}", SERVER_JARFILE: "server.jar" });
    expect(node.sim.read(id, "server.properties")).toMatch(/server-port=25565/);

    // Startup API: variables and resolved startup.
    const startup = ServerStartup.parse((await owner.get(`/servers/${id}/startup`)).json());
    expect(startup.resolvedStartup).toBe("java -Xms128M -XX:MaxRAMPercentage=95.0 -jar server.jar");
    expect(startup.variables.find((v) => v.envName === "VANILLA_VERSION")?.value).toBe("1.21.11");
    expect((await owner.put(`/servers/${id}/startup/variables`, { envName: "SERVER_JARFILE", value: "no spaces allowed.jar" })).statusCode).toBe(400);
    expect((await owner.put(`/servers/${id}/startup/variables`, { envName: "SERVER_JARFILE", value: "paper.jar" })).statusCode).toBe(200);
    expect((await owner.put(`/servers/${id}/startup/image`, { image: "ghcr.io/pterodactyl/yolks:java_17" })).statusCode).toBe(200);
    expect((await owner.put(`/servers/${id}/startup/image`, { image: "docker.io/library/evil:latest" })).statusCode).toBe(400);

    // Config files are re-applied before every start (a user edit to the port is reverted).
    node.sim.put(id, "server.properties", "server-port=1\nmotd=Hi\n");
    const stop = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    expect((await waitJob(owner, stop.json().jobId)).status).toBe("succeeded");
    const start = await owner.post(`/servers/${id}/actions`, { action: "start" });
    expect((await waitJob(owner, start.json().jobId)).status).toBe("succeeded");
    const props = node.sim.read(id, "server.properties") ?? "";
    expect(props).toMatch(/server-port=25565/);
    expect(props).toMatch(/motd=Hi/);
    const last = node.sim.ensured.at(-1)!;
    expect(last).toMatchObject({ image: "ghcr.io/pterodactyl/yolks:java_17" });
    expect(last.env).toMatchObject({ SERVER_JARFILE: "paper.jar" });

    // Reinstall reruns the install script and leaves the server stopped.
    const stop2 = await owner.post(`/servers/${id}/actions`, { action: "stop" });
    await waitJob(owner, stop2.json().jobId);
    const re = await owner.post(`/servers/${id}/reinstall`);
    expect(re.statusCode).toBe(202);
    expect((await waitJob(owner, re.json().jobId)).status).toBe("succeeded");
    expect(node.sim.installs).toHaveLength(2);
    expect(await serverState(owner, id)).toBe("stopped");
  });
});

describe("server permissions (ownership, subusers, suspension)", () => {
  it("derives effective permissions, filters lists and prevents escalation", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents });
    const templateId = await templateIdByKey(owner, "minecraft-java");
    const alice = await createUserClient(t, owner, "alice@example.com", []);
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    const aliceId = (await alice.get("/auth/me")).json().user.id as string;

    // Owner creates a server for alice (needs servers.admin) and one for themselves.
    const forAlice = await owner.post("/servers", paperRequest(templateId, { ownerId: aliceId, startup: "manual" }));
    expect(forAlice.statusCode, forAlice.body).toBe(202);
    const aliceServer = forAlice.json().server.id as string;
    const mine = (await owner.post("/servers", paperRequest(templateId, { startup: "manual" }))).json().server.id as string;
    await waitJob(owner, forAlice.json().jobId);

    // Alice sees only her server; her permissions are the owner set (no delete, no secrets).
    const aliceList = (await alice.get("/servers")).json().items as Server[];
    expect(aliceList.map((s) => s.id)).toEqual([aliceServer]);
    expect((await alice.get("/servers?filter=mine")).json().items).toHaveLength(1);
    const aView = Server.parse((await alice.get(`/servers/${aliceServer}`)).json());
    expect(aView.myPermissions).toContain("servers.subusers.manage");
    expect(aView.myPermissions).toContain("servers.files.sftp");
    expect(aView.myPermissions).not.toContain("servers.delete");
    expect(aView.myPermissions).not.toContain("secrets.read");
    expect(aView.sftp?.username).toBe(`alice.${aliceServer.replace(/-/g, "").slice(0, 8)}`);
    expect((await alice.get(`/servers/${mine}`)).statusCode).toBe(404);
    expect((await alice.delete(`/servers/${aliceServer}`)).statusCode).toBe(403);
    expect((await owner.get("/servers?filter=mine")).json().items.map((s: Server) => s.id)).toEqual([mine]);
    // Owners can follow their provisioning job (jobs.view through ownership).
    expect((await alice.get(`/jobs/${forAlice.json().jobId}`)).statusCode).toBe(200);
    expect((await alice.get("/jobs")).json().items.map((j: { id: string }) => j.id)).toContain(forAlice.json().jobId);

    // Alice adds bob as a subuser; granting something she does not hold is refused.
    const deny = await alice.post(`/servers/${aliceServer}/subusers`, { user: "bob@example.com", permissions: ["servers.view", "secrets.read"] });
    expect(deny.statusCode).toBe(403);
    const added = await alice.post(`/servers/${aliceServer}/subusers`, { user: "bob", permissions: ["servers.view", "servers.console.view", "servers.subusers.manage", "servers.files.read"] });
    expect(added.statusCode, added.body).toBe(201);
    const subId = added.json().id as string;
    const bView = Server.parse((await bob.get(`/servers/${aliceServer}`)).json());
    expect(bView.myPermissions).toEqual(["servers.console.view", "servers.files.read", "servers.subusers.manage", "servers.view"]);
    expect((await bob.post(`/servers/${aliceServer}/actions`, { action: "start" })).statusCode).toBe(403);
    expect((await bob.get("/servers?filter=mine")).json().items.map((s: Server) => s.id)).toEqual([aliceServer]);

    // Bob cannot change his own grant.
    expect((await bob.put(`/servers/${aliceServer}/subusers/${subId}`, { permissions: ["servers.view"] })).statusCode).toBe(403);

    // A grant by the owner of something bob (as granter) does not hold stays when bob edits carol.
    const carol = await createUserClient(t, owner, "carol@example.com", []);
    const carolSub = await alice.post(`/servers/${aliceServer}/subusers`, { user: "carol", permissions: ["servers.view", "servers.files.write"] });
    expect(carolSub.statusCode).toBe(201);
    const relative = await bob.put(`/servers/${aliceServer}/subusers/${carolSub.json().id}`, { permissions: ["servers.view", "servers.console.view"] });
    expect(relative.statusCode, relative.body).toBe(200);
    expect(relative.json().permissions).toEqual(["servers.console.view", "servers.files.write", "servers.view"]);
    // ...but bob cannot add a permission he lacks.
    const escalate = await bob.put(`/servers/${aliceServer}/subusers/${carolSub.json().id}`, { permissions: ["servers.view", "servers.control"] });
    expect(escalate.statusCode).toBe(403);
    expect(Server.parse((await carol.get(`/servers/${aliceServer}`)).json()).myPermissions).toEqual(["servers.console.view", "servers.files.write", "servers.view"]);

    // Realtime: subusers may subscribe to the server and its console (effective permissions).
    const bobUi = await UiSocket.open(t, bob);
    sockets.push(bobUi);
    expect((await bobUi.subscribe(`server:${aliceServer}`)).op).toBe("subscribed");
    expect((await bobUi.subscribe(`console:${aliceServer}`)).op).toBe("subscribed");
    expect((await bobUi.subscribe(`server:${mine}`)).op).toBe("error");
    const carolUi = await UiSocket.open(t, carol);
    sockets.push(carolUi);
    expect((await carolUi.subscribe(`console:${aliceServer}`)).op).toBe("subscribed");

    // Suspension: only servers.admin holders keep non-view permissions.
    expect((await alice.post(`/servers/${aliceServer}/suspend`)).statusCode).toBe(403);
    const suspended = await owner.post(`/servers/${aliceServer}/suspend`);
    expect(suspended.statusCode, suspended.body).toBe(200);
    const sView = Server.parse((await alice.get(`/servers/${aliceServer}`)).json());
    expect(sView.suspended).toBe(true);
    expect(sView.myPermissions.every((p) => p.endsWith(".view"))).toBe(true);
    const refused = await alice.post(`/servers/${aliceServer}/actions`, { action: "start" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toMatch(/suspended/);
    expect((await owner.post(`/servers/${aliceServer}/unsuspend`)).statusCode).toBe(200);
    expect(Server.parse((await alice.get(`/servers/${aliceServer}`)).json()).myPermissions).toContain("servers.control");

    // Removing a subuser revokes access.
    expect((await alice.delete(`/servers/${aliceServer}/subusers/${subId}`)).statusCode).toBe(204);
    expect((await bob.get(`/servers/${aliceServer}`)).statusCode).toBe(404);
    const { rows } = await testPool().query("SELECT action FROM audit_events WHERE target_id = $1 AND action LIKE 'server.subuser%' ORDER BY id", [aliceServer]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["server.subuser.add", "server.subuser.update", "server.subuser.remove"]));
    void node;
  });

  it("updates settings and build limits (reservations follow)", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    const templateId = await templateIdByKey(owner, "minecraft-java");
    const created = (await owner.post("/servers", paperRequest(templateId, { startup: "manual" }))).json();
    await waitJob(owner, created.jobId);
    const id = created.server.id as string;
    const patched = await owner.patch(`/servers/${id}`, { name: "Renamed", description: "<b>not html</b>" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Renamed", description: "<b>not html</b>" });
    const build = await owner.patch(`/servers/${id}/build`, { memoryLimitBytes: 6 * 1024 ** 3 });
    expect(build.statusCode, build.body).toBe(200);
    const { rows } = await testPool().query("SELECT memory_bytes FROM resource_reservations WHERE server_id = $1", [id]);
    expect(Number(rows[0].memory_bytes)).toBe(6 * 1024 ** 3);
    expect(responseLog.filter((r) => r.url.includes(id)).every((r) => !r.body.includes("forwarding"))).toBe(true);
  });
});
