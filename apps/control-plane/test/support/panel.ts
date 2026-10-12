import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeFacts } from "@blockforge/contracts";
import { expect } from "vitest";
import type { LookupFn } from "../../src/notifications/ssrf.js";
import type { ApiClient, TestApp } from "./app.js";
import { FakeAgent, FIXTURE_FACTS } from "./fake-agent.js";
import { SimNode, type SimOptions } from "./sim-node.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const MC_FIXTURES = join(ROOT, "packages", "minecraft", "test", "fixtures");
const EGG_FIXTURES = join(ROOT, "packages", "eggs", "test", "fixtures", "eggs");

export const SFTP_FACT = { port: 2022, hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" };
export const PANEL_FACTS: NodeFacts = { ...FIXTURE_FACTS, sftp: SFTP_FACT };

export function eggFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(EGG_FIXTURES, name), "utf8")) as Record<string, unknown>;
}

const mcFixture = (path: string) => readFileSync(join(MC_FIXTURES, path), "utf8");
const FILL = "https://fill.papermc.io/v3/projects";
const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/**
 * Real upstream responses captured by `@blockforge/minecraft` (Fill v3 for Paper, the Mojang
 * manifest), served by URL to the control plane's safe fetch. Unknown URLs answer 404.
 */
export function catalogRoutes(): Record<string, string | number> {
  const routes: Record<string, string | number> = {
    // Simulated upstream outage.
    "https://api.purpurmc.org/v2/purpur": 503,
  };
  const manifestText = mcFixture("mojang/version_manifest_v2.json");
  routes[MANIFEST] = manifestText;
  for (const v of (JSON.parse(manifestText) as { versions: { id: string; url: string }[] }).versions) routes[v.url] = mcFixture(`mojang/versions/${v.id}.json`);
  const versions = mcFixture("fill/paper-versions.json");
  routes[`${FILL}/paper/versions`] = versions;
  for (const v of (JSON.parse(versions) as { versions: { version: { id: string } }[] }).versions) {
    routes[`${FILL}/paper/versions/${encodeURIComponent(v.version.id)}`] = JSON.stringify(v);
  }
  routes[`${FILL}/paper/versions/1.21.11`] = mcFixture("fill/paper-version-1.21.11.json");
  const builds = mcFixture("fill/paper-1.21.11-builds.json");
  routes[`${FILL}/paper/versions/1.21.11/builds`] = builds;
  for (const b of JSON.parse(builds) as { id: number }[]) routes[`${FILL}/paper/versions/1.21.11/builds/${b.id}`] = JSON.stringify(b);
  const vVersions = mcFixture("fill/velocity-versions.json");
  routes[`${FILL}/velocity/versions`] = vVersions;
  for (const v of (JSON.parse(vVersions) as { versions: { version: { id: string } }[] }).versions) {
    routes[`${FILL}/velocity/versions/${encodeURIComponent(v.version.id)}`] = JSON.stringify(v);
  }
  const vBuilds = mcFixture("fill/velocity-4.2.0-builds.json");
  routes[`${FILL}/velocity/versions/4.2.0/builds`] = vBuilds;
  for (const b of JSON.parse(vBuilds) as { id: number }[]) routes[`${FILL}/velocity/versions/4.2.0/builds/${b.id}`] = JSON.stringify(b);
  return routes;
}

export function catalogFetch(routes = catalogRoutes(), fallbackStatus = 404): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const body = routes[url];
    if (typeof body === "number") return new Response("upstream error", { status: body });
    return body === undefined ? new Response("unavailable", { status: fallbackStatus }) : new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Public addresses for every catalogue host (the SSRF check runs on the resolved address). */
export const publicLookup: LookupFn = async () => [{ address: "151.101.1.1", family: 4 }];

/** Catalogue options for `startWithOwner`. */
export function catalogOptions(fallbackStatus = 404) {
  const f = catalogFetch(catalogRoutes(), fallbackStatus);
  return { catalog: { fetchImpl: f.fetchImpl, lookup: publicLookup }, calls: f.calls };
}

export interface SimNodeHandle {
  agent: FakeAgent;
  sim: SimNode;
  nodeId: string;
}

/** Enrolls a fake agent, connects it with SFTP-capable facts and attaches an in-memory node. */
export async function connectSimNode(
  t: TestApp,
  owner: ApiClient,
  opts: { sim?: SimOptions; facts?: NodeFacts; ports?: string; ip?: string; agents?: FakeAgent[]; name?: string } = {},
): Promise<SimNodeHandle> {
  const created = await owner.post("/nodes/enrollment-tokens", { label: "sim node", requiresApproval: false });
  expect(created.statusCode).toBe(201);
  const agent = new FakeAgent(t.baseUrl, t.wsBaseUrl);
  opts.agents?.push(agent);
  const res = await agent.enroll(created.json().secretToken, { nodeName: opts.name ?? `sim-${randomUUID().slice(0, 8)}`, facts: opts.facts ?? PANEL_FACTS });
  expect(res.status).toBe(201);
  const sim = new SimNode(agent, opts.sim);
  await agent.connect();
  await agent.hello([], opts.facts ?? PANEL_FACTS);
  const nodeId = agent.nodeId as string;
  if (opts.ports !== "") {
    const alloc = await owner.post(`/nodes/${nodeId}/allocations`, { ip: opts.ip ?? "10.0.0.5", ports: opts.ports ?? "25565-25570" });
    expect(alloc.statusCode, alloc.body).toBe(201);
  }
  return { agent, sim, nodeId };
}

export async function poll<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Waits until a job reaches a terminal status and returns it. */
export async function waitJob(client: ApiClient, jobId: string, timeoutMs = 20_000): Promise<Record<string, unknown> & { status: string }> {
  return poll(async () => {
    const r = await client.get(`/jobs/${jobId}`);
    const j = r.json();
    return ["succeeded", "failed", "cancelled"].includes(j.status) ? j : null;
  }, timeoutMs);
}

/** Minimal Paper create request (catalogue fixtures: Paper 1.21.11). */
export function paperRequest(templateId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Survival",
    slug: `survival-${randomUUID().slice(0, 6)}`,
    templateId,
    placement: { mode: "auto", preferTags: [] },
    memoryLimitBytes: 4 * 1024 ** 3,
    minecraft: { software: "paper", version: "1.21.11", acceptEula: true },
    ...over,
  };
}

export async function templateIdByKey(client: ApiClient, key: string): Promise<string> {
  const list = (await client.get("/templates")).json() as { id: string; key: string }[];
  const t = list.find((x) => x.key === key);
  if (!t) throw new Error(`template ${key} not found`);
  return t.id;
}
