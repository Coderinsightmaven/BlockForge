import { describe, expect, it } from "vitest";
import {
  ModrinthClient,
  TtlCache,
  checkModrinthUpdates,
  createCatalog,
  identifyModrinthFiles,
  isReleaseVersion,
  lookupMojangProfile,
  modrinthUserAgent,
  planModrinthInstall,
  searchModrinth,
  type CatalogContext,
} from "../src/index.js";

/**
 * Opt-in smoke tests against the real upstream APIs: `BLOCKFORGE_LIVE_TESTS=1 pnpm test`.
 * They verify that today's live responses still match the adapters' schemas and that the
 * resolved primary download URL answers a HEAD request.
 */
const LIVE = process.env["BLOCKFORGE_LIVE_TESTS"] === "1";

const ctx: CatalogContext = {
  fetch: (input, init) => globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
  cache: new TtlCache<string, string>(),
};

async function head(url: string): Promise<number> {
  const res = await globalThis.fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(30_000) });
  return res.status;
}

describe.skipIf(!LIVE)("live upstream smoke tests", () => {
  const catalog = createCatalog();
  const cases = ["vanilla", "paper", "folia", "velocity", "purpur", "fabric", "forge", "neoforge"] as const;

  it.each(cases)("%s: list → resolve newest release → HEAD download", async (software) => {
    const adapter = catalog[software];
    const versions = await adapter.listVersions(ctx);
    expect(versions.length).toBeGreaterThan(0);
    const release = versions.find((v) => (software === "velocity" ? v.channel === "release" : isReleaseVersion(v.minecraftVersion))) ?? versions[0]!;
    const artifact = await adapter.resolve(ctx, release.minecraftVersion, null);
    const primary = artifact.downloads[0]!;
    expect(primary.url).toMatch(/^https:\/\//);
    if (software !== "purpur" && software !== "fabric") expect(primary.agentChecksum).not.toBeNull();
    expect(await head(primary.url)).toBe(200);
    console.warn(
      `[live] ${software} ${artifact.version} build ${artifact.build} (${artifact.channel}) java ${artifact.java.major} ` +
        `checksum ${primary.checksum?.algorithm ?? "none"} launch ${artifact.launch.kind}`,
    );
  }, 120_000);

  it("spigot stays unsupported", async () => {
    await expect(catalog.spigot.resolve(ctx, "1.21.11", null)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe.skipIf(!LIVE)("live Modrinth / Mojang smoke tests", () => {
  const client = new ModrinthClient({
    fetch: (input, init) => globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
    userAgent: modrinthUserAgent("0.1.0", "blockforge live tests"),
    cache: new TtlCache<string, string>(),
  });

  it("search → plan (with dependencies) → HEAD every file → identify → no update for the newest", async () => {
    const hits = await searchModrinth(client, { software: "paper", minecraftVersion: "1.21.11", query: "worldguard", limit: 5 });
    expect(hits.hits.some((h) => h.slug === "worldguard")).toBe(true);
    const plan = await planModrinthInstall(client, { software: "paper", minecraftVersion: "1.21.11", project: "worldguard" });
    expect(plan.installable).toBe(true);
    expect(plan.files.map((f) => f.projectSlug)).toEqual(["worldedit", "worldguard"]);
    for (const f of plan.files) expect(await head(f.url)).toBe(200);
    const installed = plan.files.map((f) => ({ path: f.destPath, sha512: f.sha512 }));
    const ids = await identifyModrinthFiles(client, installed);
    expect(ids.map((i) => i.modrinth?.slug)).toEqual(["worldedit", "worldguard"]);
    const updates = await checkModrinthUpdates(client, { software: "paper", minecraftVersion: "1.21.11" }, installed);
    expect(updates.every((u) => u.current !== null && !u.updateAvailable)).toBe(true); // newest releases installed
    console.warn(`[live] modrinth plan ${plan.files.map((f) => `${f.projectSlug} ${f.versionNumber}`).join(", ")}; updates ${updates.filter((u) => u.updateAvailable).length}; rate limit ${JSON.stringify(client.rateLimit)}`);
  }, 120_000);

  it("Fabric dependencies (Ledger) and Velocity (LuckPerms)", async () => {
    const ledger = await planModrinthInstall(client, { software: "fabric", minecraftVersion: "1.21.1", project: "ledger" });
    expect(ledger.files.map((f) => f.projectSlug)).toEqual(["fabric-api", "fabric-language-kotlin", "ledger"]);
    const velocity = await planModrinthInstall(client, { software: "velocity", minecraftVersion: null, project: "luckperms" });
    expect(velocity.files[0]!.destPath).toMatch(/^plugins\/LuckPerms-Velocity-/);
  }, 120_000);

  it("Mojang profile lookup", async () => {
    expect(await lookupMojangProfile(ctx, "Notch")).toEqual({ uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", name: "Notch", source: "mojang" });
    expect(await lookupMojangProfile(ctx, "bf_nx_q9z2k7w1")).toBeNull();
  }, 60_000);
});
