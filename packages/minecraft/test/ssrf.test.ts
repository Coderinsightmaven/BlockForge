import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CATALOG_HOSTS,
  FILL_BASE,
  MOJANG_MANIFEST_URL,
  assertAllowedUrl,
  createFillAdapter,
  createVanillaAdapter,
  getJson,
  getText,
  type CatalogContext,
  type Fetch,
} from "../src/index.js";
import { fixture, mojangRoutes } from "./helpers.js";

type Hop = { status: number; location?: string; body?: string };

/** Fetch mock that records every request and its redirect mode. */
function recorder(routes: Record<string, Hop | string>) {
  const calls: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
  const fetch: Fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, redirect: init?.redirect });
    const r = routes[url];
    if (r === undefined) return new Response("nope", { status: 404 });
    if (typeof r === "string") return new Response(r, { status: 200 });
    return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
  };
  return { fetch, calls };
}

describe("catalogue fetch boundary", () => {
  it("only fetches allowlisted HTTPS hosts and never follows redirects automatically", async () => {
    const { fetch, calls } = recorder({ "https://fill.papermc.io/v3/projects": "{}" });
    await getText({ fetch }, "https://fill.papermc.io/v3/projects");
    expect(calls).toEqual([{ url: "https://fill.papermc.io/v3/projects", redirect: "manual" }]);
    for (const bad of ["https://169.254.169.254/latest/meta-data/", "https://10.0.0.1/x", "https://[::1]/x", "http://fill.papermc.io/v3", "https://evil.example.com/x", "https://fill.papermc.io:8443/x", "https://user:pw@fill.papermc.io/x"]) {
      await expect(getText({ fetch }, bad), bad).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    expect(calls).toHaveLength(1);
  });

  it("re-validates every redirect hop and refuses private / link-local targets", async () => {
    for (const target of ["https://169.254.169.254/latest/meta-data/iam", "https://10.1.2.3/x", "https://127.0.0.1/x", "http://piston-meta.mojang.com/x", "https://metadata.google.internal/x"]) {
      const { fetch, calls } = recorder({ [MOJANG_MANIFEST_URL]: { status: 302, location: target } });
      await expect(getText({ fetch }, MOJANG_MANIFEST_URL)).rejects.toMatchObject({ code: "UPSTREAM_ERROR", message: expect.stringMatching(/refusing redirect/) });
      expect(calls.map((c) => c.url)).toEqual([MOJANG_MANIFEST_URL]);
    }
  });

  it("follows redirects that stay on allowlisted hosts (relative and absolute)", async () => {
    const { fetch, calls } = recorder({
      "https://fill.papermc.io/a": { status: 301, location: "/b" },
      "https://fill.papermc.io/b": { status: 307, location: "https://api.purpurmc.org/v2/purpur" },
      "https://api.purpurmc.org/v2/purpur": '{"ok":true}',
    });
    expect(await getJson({ fetch }, "https://fill.papermc.io/a", z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual(["https://fill.papermc.io/a", "https://fill.papermc.io/b", "https://api.purpurmc.org/v2/purpur"]);
  });

  it("stops redirect loops", async () => {
    const { fetch } = recorder({ "https://fill.papermc.io/loop": { status: 302, location: "/loop" } });
    await expect(getText({ fetch }, "https://fill.papermc.io/loop")).rejects.toMatchObject({ message: expect.stringMatching(/too many redirects/) });
    const noLoc = recorder({ "https://fill.papermc.io/x": { status: 302 } });
    await expect(getText({ fetch: noLoc.fetch }, "https://fill.papermc.io/x")).rejects.toMatchObject({ message: expect.stringMatching(/without Location/) });
  });

  it("allows callers to narrow or extend the allowlists", async () => {
    const { fetch } = recorder({ "https://mirror.example.net/m.json": "{}" });
    const ctx: CatalogContext = { fetch, metadataHosts: ["mirror.example.net"] };
    expect(await getText(ctx, "https://mirror.example.net/m.json")).toBe("{}");
    await expect(getText(ctx, MOJANG_MANIFEST_URL)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(() => assertAllowedUrl("https://PISTON-META.mojang.com./x", CATALOG_HOSTS.metadata)).not.toThrow();
  });
});

describe("URLs found in upstream metadata", () => {
  it("refuses a manifest entry pointing at an internal address", async () => {
    const routes: Record<string, string> = { ...mojangRoutes() };
    const manifest = JSON.parse(routes[MOJANG_MANIFEST_URL]!) as { versions: Array<{ id: string; url: string; sha1?: string }> };
    const v = manifest.versions.find((x) => x.id === "26.3")!;
    v.url = "https://169.254.169.254/latest/meta-data/26.3.json";
    delete v.sha1;
    routes[MOJANG_MANIFEST_URL] = JSON.stringify(manifest);
    const { fetch, calls } = recorder(routes);
    await expect(createVanillaAdapter().resolve({ fetch }, "26.3", null)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls.some((c) => c.url.includes("169.254"))).toBe(false);
  });

  it("refuses server download URLs outside the artifact allowlist", async () => {
    const routes: Record<string, string> = { ...mojangRoutes() };
    const manifest = JSON.parse(routes[MOJANG_MANIFEST_URL]!) as { versions: Array<{ id: string; url: string; sha1?: string }> };
    const entry = manifest.versions.find((x) => x.id === "26.3")!;
    delete entry.sha1;
    routes[MOJANG_MANIFEST_URL] = JSON.stringify(manifest);
    routes[entry.url] = routes[entry.url]!.replace("https://piston-data.mojang.com/v1/objects/33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c/server.jar", "https://10.0.0.5/server.jar");
    const { fetch } = recorder(routes);
    await expect(createVanillaAdapter().resolve({ fetch }, "26.3", null)).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    await expect(createVanillaAdapter().listBuilds({ fetch }, "26.3")).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });

  it("refuses Fill builds whose download URL leaves fill-data.papermc.io", async () => {
    const builds = JSON.parse(fixture("fill/paper-1.21.11-builds.json")) as Array<{ downloads: Record<string, { url: string }> }>;
    builds[0]!.downloads["server:default"]!.url = "https://fill-data.papermc.io.evil.example/x.jar";
    const { fetch } = recorder({
      [`${FILL_BASE}/paper/versions/1.21.11/builds`]: JSON.stringify(builds),
    });
    await expect(createFillAdapter("paper").listBuilds({ fetch }, "1.21.11")).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });
});
