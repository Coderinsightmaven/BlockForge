import type { Template } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCommandError } from "../../src/agents/gateway.js";
import { startWithOwner, type TestApp } from "../support/app.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { connectSimNode, eggFixture, waitJob } from "../support/panel.js";
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

describe("console history backfill after a control-plane restart", () => {
  it("pulls workload.logs.tail once into an empty buffer, masked, with fresh seqs", async () => {
    const r = await startWithOwner({ background: true, serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 } });
    t = r.t;
    const owner = r.owner;
    const SECRET = "Backfill-Secret-123";
    const node = await connectSimNode(r.t, owner, { agents, sim: { installCreates: { "server.jar": "x" } } });
    const imported = await owner.post("/templates/import", { egg: eggFixture("ptero-egg-vanilla-minecraft.json"), category: "Minecraft" });
    const tpl = imported.json().template as Template;
    await owner.patch(`/templates/${tpl.id}`, {
      variables: [...tpl.variables, { envName: "RCON_PASSWORD", name: "RCON", description: "", defaultValue: "", userViewable: false, userEditable: false, rules: "nullable|string", sortOrder: 9 }],
    });
    const created = await owner.post("/servers", {
      name: "Egg",
      slug: "egg-backfill",
      templateId: tpl.id,
      placement: { mode: "auto" },
      memoryLimitBytes: 2 * 1024 ** 3,
      egg: { variables: { VANILLA_VERSION: "1.21.11", RCON_PASSWORD: SECRET }, acceptEula: true },
    });
    const id = created.json().server.id as string;
    expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");

    // Simulate the restart: the in-memory buffer is gone, the agent still has output.
    r.t.ctx.consoles.remove(id);
    node.sim.options = { logTail: ["[12:00:00 INFO]: Starting minecraft server", `[12:00:01 INFO]: rcon password ${SECRET}`, '[12:00:02 INFO]: Done (1.0s)! For help, type "help"'] };
    const tails = () => node.agent.commands.filter((c) => c.type === "workload.logs.tail" && (c.payload as { workloadId: string }).workloadId === id);
    const h = (await owner.get(`/servers/${id}/console/history?lines=5000`)).json() as { lines: { seq: number; line: string; stream: string }[] };
    expect(h.lines.map((l) => l.line)).toEqual(["[12:00:00 INFO]: Starting minecraft server", "[12:00:01 INFO]: rcon password ••••••", '[12:00:02 INFO]: Done (1.0s)! For help, type "help"']);
    expect(h.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(tails()).toHaveLength(1);
    expect((tails()[0]!.payload as { lines: number }).lines).toBe(500);
    // Not repeated, even when the agent would have more.
    node.sim.options = { logTail: ["later line"] };
    await owner.get(`/servers/${id}/console/history?lines=100`);
    expect(tails()).toHaveLength(1);

    // The first console subscription backfills too (buffer dropped again).
    r.t.ctx.consoles.remove(id);
    const ui = await UiSocket.open(r.t, owner);
    sockets.push(ui);
    expect((await ui.subscribe(`console:${id}`)).op).toBe("subscribed");
    expect(tails()).toHaveLength(2);
    const after = (await owner.get(`/servers/${id}/console/history?lines=10`)).json() as { lines: { line: string }[] };
    expect(after.lines.map((l) => l.line)).toEqual(["later line"]);
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });
});

describe("agent results with an unknown error code", () => {
  it("fail the command immediately instead of waiting for the timeout", async () => {
    const r = await startWithOwner();
    t = r.t;
    const node = await connectSimNode(r.t, r.owner, { agents, ports: "", sim: { fail: { "node.ports": { code: "SOMETHING_NEW", message: "unknown code" } } } });
    const started = Date.now();
    const err = await r.t.ctx.gateway.send(node.nodeId, "node.ports", {}, { timeoutMs: 20_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCommandError);
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
