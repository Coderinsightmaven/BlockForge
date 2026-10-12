import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SimNode } from "./sim-node.js";

/**
 * Fake upstreams for Phase 4b tests — the default test run never reaches api.modrinth.com or
 * api.mojang.com:
 *  - recorded Modrinth exchanges from `packages/minecraft/test/fixtures/modrinth/routes.json`
 *    (search / project / versions of LuckPerms for Paper 1.21.11, …), replayed by exact method + URL + body;
 *  - synthetic Modrinth projects whose files are real jars served to the sim node's `artifact.fetch`
 *    (so SHA-512 verification, identification and updates run end to end);
 *  - Mojang profiles (recorded `mojang-profile-*.json` plus extra names), optional 429s.
 */

const FIXTURES = new URL("../../../../packages/minecraft/test/fixtures/", import.meta.url);
const fixture = (path: string) => readFileSync(new URL(path, FIXTURES), "utf8");

interface Recorded {
  method: string;
  url: string;
  body: string | null;
  status: number;
  headers: Record<string, string>;
  file: string | null;
}

export interface FakeVersion {
  id: string;
  projectId: string;
  number: string;
  type: "release" | "beta" | "alpha";
  date: string;
  loaders: string[];
  gameVersions: string[];
  dependencies: { project_id: string | null; version_id: string | null; dependency_type: string }[];
  filename: string;
  jar: Buffer;
  url: string;
  sha1: string;
  sha512: string;
  status?: string;
}

export interface FakeProject {
  id: string;
  slug: string;
  title: string;
  type: "plugin" | "mod";
  loaders: string[];
  gameVersions: string[];
  serverSide: string;
  clientSide: string;
  versions: FakeVersion[];
}

const API = "https://api.modrinth.com/v2";

export class FakeUpstreams {
  readonly recorded: Recorded[] = JSON.parse(fixture("modrinth/routes.json")) as Recorded[];
  readonly projects = new Map<string, FakeProject>();
  readonly calls: { method: string; url: string; body: string | null; userAgent: string | null }[] = [];
  readonly misses: string[] = [];
  /** `X-Ratelimit-*` values sent with the next Modrinth responses (null = the recorded/default headers). */
  rateLimit: { remaining: number; resetSeconds: number } | null = null;
  /** Answer every Modrinth request with HTTP 429. */
  modrinth429 = false;
  /** Mojang profiles by lower-case name (in addition to the recorded Notch fixture). */
  readonly mojangProfiles = new Map<string, { id: string; name: string }>();
  mojang429 = false;
  private sim: SimNode | null = null;

  constructor() {
    const notch = JSON.parse(fixture("players/mojang-profile-Notch.json")) as { id: string; name: string };
    this.mojangProfiles.set(notch.name.toLowerCase(), notch);
  }

  /** Serves the synthetic jars to this sim node's `artifact.fetch`. */
  attach(sim: SimNode): void {
    this.sim = sim;
    for (const p of this.projects.values()) for (const v of p.versions) sim.artifacts.set(v.url, v.jar);
  }

  addProject(p: Omit<FakeProject, "versions" | "clientSide" | "serverSide" | "gameVersions"> & Partial<Pick<FakeProject, "clientSide" | "serverSide" | "gameVersions">>): FakeProject {
    const full: FakeProject = { clientSide: "unsupported", serverSide: "required", gameVersions: ["1.21.11"], ...p, versions: [] };
    this.projects.set(full.id, full);
    return full;
  }

  addVersion(projectId: string, v: { id: string; number: string; jar: Buffer; filename: string; type?: FakeVersion["type"]; date?: string; loaders?: string[]; gameVersions?: string[]; dependencies?: FakeVersion["dependencies"] }): FakeVersion {
    const p = this.projects.get(projectId)!;
    const version: FakeVersion = {
      id: v.id,
      projectId,
      number: v.number,
      type: v.type ?? "release",
      date: v.date ?? new Date(Date.UTC(2026, 0, 1 + p.versions.length)).toISOString(),
      loaders: v.loaders ?? p.loaders,
      gameVersions: v.gameVersions ?? p.gameVersions,
      dependencies: v.dependencies ?? [],
      filename: v.filename,
      jar: v.jar,
      url: `https://cdn.modrinth.com/data/${projectId}/versions/${v.id}/${encodeURIComponent(v.filename)}`,
      sha1: createHash("sha1").update(v.jar).digest("hex"),
      sha512: createHash("sha512").update(v.jar).digest("hex"),
    };
    p.versions.push(version);
    this.sim?.artifacts.set(version.url, version.jar);
    return version;
  }

  private projectRaw(p: FakeProject) {
    return {
      id: p.id,
      slug: p.slug,
      project_type: p.type,
      title: p.title,
      description: `${p.title} (synthetic test project)`,
      categories: ["utility", ...p.loaders],
      loaders: p.loaders,
      game_versions: p.gameVersions,
      versions: p.versions.map((v) => v.id),
      client_side: p.clientSide,
      server_side: p.serverSide,
      status: "approved",
      license: { id: "MIT", name: "MIT License", url: null },
      downloads: 1000,
      followers: 10,
      icon_url: null,
      published: "2026-01-01T00:00:00Z",
      updated: p.versions.at(-1)?.date ?? "2026-01-01T00:00:00Z",
    };
  }

  private versionRaw(v: FakeVersion) {
    return {
      id: v.id,
      project_id: v.projectId,
      name: `${v.number}`,
      version_number: v.number,
      changelog: null,
      date_published: v.date,
      downloads: 1,
      version_type: v.type,
      status: v.status ?? "listed",
      loaders: v.loaders,
      game_versions: v.gameVersions,
      files: [{ hashes: { sha1: v.sha1, sha512: v.sha512 }, url: v.url, filename: v.filename, primary: true, size: v.jar.length, file_type: null }],
      dependencies: v.dependencies,
    };
  }

  private project(ref: string): FakeProject | null {
    return this.projects.get(ref) ?? [...this.projects.values()].find((p) => p.slug === ref) ?? null;
  }

  private versionByHash(hash: string): FakeVersion | null {
    for (const p of this.projects.values()) for (const v of p.versions) if (v.sha512 === hash || v.sha1 === hash) return v;
    return null;
  }

  private modrinthHeaders(recorded?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", ...(recorded ?? { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "299", "x-ratelimit-reset": "60" }) };
    if (this.rateLimit) {
      h["x-ratelimit-limit"] = "300";
      h["x-ratelimit-remaining"] = String(this.rateLimit.remaining);
      h["x-ratelimit-reset"] = String(this.rateLimit.resetSeconds);
    }
    return h;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: this.modrinthHeaders() });
  }

  private synthetic(method: string, u: URL, body: string | null): Response | null {
    const path = u.pathname.replace(/^\/v2/, "");
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/project\/([^/]+)$/.exec(path))) {
      const p = this.project(decodeURIComponent(m[1]!));
      return p ? this.json(this.projectRaw(p)) : null;
    }
    if (method === "GET" && (m = /^\/project\/([^/]+)\/version$/.exec(path))) {
      const p = this.project(decodeURIComponent(m[1]!));
      if (!p) return null;
      const loaders = u.searchParams.get("loaders") ? (JSON.parse(u.searchParams.get("loaders")!) as string[]) : null;
      const games = u.searchParams.get("game_versions") ? (JSON.parse(u.searchParams.get("game_versions")!) as string[]) : null;
      const list = p.versions.filter((v) => (!loaders || v.loaders.some((l) => loaders.includes(l))) && (!games || v.gameVersions.some((g) => games.includes(g))));
      return this.json([...list].reverse().map((v) => this.versionRaw(v)));
    }
    if (method === "GET" && (m = /^\/version\/([^/]+)$/.exec(path))) {
      for (const p of this.projects.values()) for (const v of p.versions) if (v.id === m[1]) return this.json(this.versionRaw(v));
      return null;
    }
    if (method === "GET" && (path === "/versions" || path === "/projects")) {
      const ids = JSON.parse(u.searchParams.get("ids") ?? "[]") as string[];
      if (path === "/projects") {
        const found = ids.map((id) => this.projects.get(id)).filter((p): p is FakeProject => !!p);
        return found.length === ids.length ? this.json(found.map((p) => this.projectRaw(p))) : null;
      }
      const found = ids.flatMap((id) => [...this.projects.values()].flatMap((p) => p.versions.filter((v) => v.id === id)));
      return found.length === ids.length ? this.json(found.map((v) => this.versionRaw(v))) : null;
    }
    if (method === "POST" && path === "/version_files") {
      const req = JSON.parse(body ?? "{}") as { hashes: string[] };
      if (!req.hashes.some((h) => this.versionByHash(h))) return null;
      return this.json(Object.fromEntries(req.hashes.flatMap((h) => (this.versionByHash(h) ? [[h, this.versionRaw(this.versionByHash(h)!)]] : []))));
    }
    if (method === "POST" && path === "/version_files/update") {
      const req = JSON.parse(body ?? "{}") as { hashes: string[]; loaders: string[]; game_versions?: string[]; version_types?: string[] };
      if (!req.hashes.some((h) => this.versionByHash(h))) return null;
      const out: Record<string, unknown> = {};
      for (const h of req.hashes) {
        const cur = this.versionByHash(h);
        if (!cur) continue;
        const candidates = this.projects
          .get(cur.projectId)!
          .versions.filter((v) => v.loaders.some((l) => req.loaders.includes(l)) && (!req.game_versions || v.gameVersions.some((g) => req.game_versions!.includes(g))) && (!req.version_types || req.version_types.includes(v.type)));
        const latest = candidates.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
        if (latest) out[h] = this.versionRaw(latest);
      }
      return this.json(out);
    }
    return null;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    const ua = new Headers(init?.headers).get("user-agent");
    this.calls.push({ method, url, body, userAgent: ua });
    const u = new URL(url);
    if (u.host === "api.mojang.com") {
      if (this.mojang429) return new Response("{}", { status: 429 });
      const name = decodeURIComponent(u.pathname.replace("/users/profiles/minecraft/", "")).toLowerCase();
      const p = this.mojangProfiles.get(name);
      return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response(fixture("players/mojang-profile-404.json"), { status: 404 });
    }
    if (u.host !== "api.modrinth.com") return new Response("unexpected host", { status: 599 });
    if (this.modrinth429) return new Response("{}", { status: 429, headers: this.modrinthHeaders({ "x-ratelimit-limit": "300", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "30" }) });
    const synthetic = this.synthetic(method, u, body);
    if (synthetic) return synthetic;
    const r = this.recorded.find((x) => x.method === method && x.url === url && x.body === body);
    if (r) return new Response(r.file ? fixture(`modrinth/${r.file}`) : null, { status: r.status, headers: this.modrinthHeaders(r.headers) });
    // Unknown hashes: Modrinth answers {} for hash lookups (not a miss); anything else unknown is a 404 miss.
    if (method === "POST" && url.startsWith(`${API}/version_files`)) return this.json({});
    this.misses.push(`${method} ${url} ${body ?? ""}`);
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: this.modrinthHeaders() });
  };
}
