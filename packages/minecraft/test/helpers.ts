import { readFileSync } from "node:fs";
import type { CatalogContext, Fetch } from "../src/index.js";

/** Reads a fixture as raw text (fixtures are byte-exact; see test/fixtures/README.md). */
export function fixture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
}

export type Route = string | { status: number; body?: string };

/** Fetch mock serving fixtures by exact URL; unknown URLs return 404 and are recorded. */
export function mockFetch(routes: Record<string, Route>): { fetch: Fetch; calls: string[]; misses: string[] } {
  const calls: string[] = [];
  const misses: string[] = [];
  const fetch: Fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const r = routes[url];
    if (r === undefined) {
      misses.push(url);
      return new Response("not found", { status: 404 });
    }
    if (typeof r === "string") return new Response(r, { status: 200 });
    return new Response(r.body ?? "", { status: r.status });
  };
  return { fetch, calls, misses };
}

export function ctxFor(routes: Record<string, Route>): CatalogContext & { calls: string[]; misses: string[] } {
  const m = mockFetch(routes);
  return { fetch: m.fetch, calls: m.calls, misses: m.misses };
}

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/** Routes for the Mojang manifest + every per-version fixture. */
export function mojangRoutes(): Record<string, string> {
  const manifestText = fixture("mojang/version_manifest_v2.json");
  const manifest = JSON.parse(manifestText) as { versions: Array<{ id: string; url: string }> };
  const routes: Record<string, string> = { [MANIFEST]: manifestText };
  for (const v of manifest.versions) routes[v.url] = fixture(`mojang/versions/${v.id}.json`);
  return routes;
}
