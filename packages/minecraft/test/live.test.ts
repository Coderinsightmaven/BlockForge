import { describe, expect, it } from "vitest";
import { TtlCache, createCatalog, isReleaseVersion, type CatalogContext } from "../src/index.js";

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
