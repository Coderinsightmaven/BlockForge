import { describe, expect, it } from "vitest";
import {
  FABRIC_META,
  FORGE_MAVEN,
  FORGE_PROMOTIONS,
  NEOFORGE_LEGACY_MAVEN,
  NEOFORGE_MAVEN,
  PURPUR_BASE,
  createCatalog,
  createFabricAdapter,
  createForgeAdapter,
  createNeoForgeAdapter,
  createPurpurAdapter,
  createSpigotAdapter,
  forgeInstallerUrl,
  indexForgeVersions,
  listSoftwareInfo,
  neoForgeToMinecraft,
} from "../src/index.js";
import { SoftwareBuild, SoftwareInfo, SoftwareVersion } from "@blockforge/contracts";
import { ctxFor, fixture, mojangRoutes } from "./helpers.js";

describe("Purpur (API v2, fixtures captured 2026-10-11)", () => {
  const purpur = createPurpurAdapter();
  const routes = () => ({
    ...mojangRoutes(),
    [PURPUR_BASE]: fixture("purpur/project.json"),
    [`${PURPUR_BASE}/26.3?detailed=true`]: fixture("purpur/26.3-detailed.json"),
    [`${PURPUR_BASE}/1.21.11/2568`]: fixture("purpur/1.21.11-2568.json"),
    [`${PURPUR_BASE}/1.21.11/2536`]: fixture("purpur/1.21.11-2536-failed.json"),
  });

  it("lists versions newest first", async () => {
    const v = await purpur.listVersions(ctxFor(routes()));
    expect(v.slice(0, 4).map((x) => x.minecraftVersion)).toEqual(["26.3", "26.2", "26.1.2", "1.21.11"]);
    expect(v.at(-1)?.minecraftVersion).toBe("1.14.1");
  });

  it("exposes MD5 only as a note and never as an agent checksum", async () => {
    const builds = await purpur.listBuilds(ctxFor(routes()), "26.3");
    expect(builds[0]).toMatchObject({ build: "2647", channel: "experimental", checksum: null });
    expect(builds[0]!.notes[0]).toContain("95a58b3088cac65601f6cab363c2315b");
    const a = await purpur.resolve(ctxFor(routes()), "1.21.11", "2568");
    expect(a.downloads[0]).toMatchObject({
      url: "https://api.purpurmc.org/v2/purpur/1.21.11/2568/download",
      checksum: { algorithm: "md5", value: "b8d5402ef8e38bf60cabc6eeddb3fa18" },
      agentChecksum: null,
    });
    expect(a.downloads[0]!.provenance).toMatch(/MD5/);
    expect(a.java.major).toBe(21);
  });

  it("uses the newest experimental build with a note when nothing else exists", async () => {
    const a = await purpur.resolve(ctxFor(routes()), "26.3", null);
    expect(a).toMatchObject({ build: "2647", channel: "experimental" });
    expect(a.notes.join(" ")).toMatch(/experimental/);
  });

  it("refuses failed CI builds", async () => {
    await expect(purpur.resolve(ctxFor(routes()), "1.21.11", "2536")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("Fabric (meta v2)", () => {
  const fabric = createFabricAdapter();
  const routes = () => ({
    ...mojangRoutes(),
    [`${FABRIC_META}/game`]: fixture("fabric/game.json"),
    [`${FABRIC_META}/installer`]: fixture("fabric/installer.json"),
    [`${FABRIC_META}/loader/1.21.11`]: fixture("fabric/loader-1.21.11.json"),
    [`${FABRIC_META}/loader/9.9`]: "[]",
  });

  it("lists game versions with stable → release", async () => {
    const v = await fabric.listVersions(ctxFor(routes()));
    expect(v[0]).toMatchObject({ minecraftVersion: "26.4-snapshot-3", channel: "snapshot" });
    expect(v.find((x) => x.minecraftVersion === "26.3")).toMatchObject({ channel: "release", javaMajor: 25 });
  });

  it("lists loader builds without checksums", async () => {
    const b = await fabric.listBuilds(ctxFor(routes()), "1.21.11");
    expect(b[0]).toMatchObject({
      build: "0.19.5",
      channel: "stable",
      checksum: null,
      downloadUrl: "https://meta.fabricmc.net/v2/versions/loader/1.21.11/0.19.5/1.1.2/server/jar",
    });
    expect(b[1]!.channel).toBe("beta");
  });

  it("pre-places the SHA-1-verified vanilla jar where the launcher expects it", async () => {
    const a = await fabric.resolve(ctxFor(routes()), "1.21.11", null);
    expect(a.build).toBe("0.19.5/1.1.2");
    expect(a.downloads).toEqual([
      expect.objectContaining({ role: "launcher", destPath: "fabric-server-launcher.jar", checksum: null, agentChecksum: null }),
      expect.objectContaining({
        role: "vanilla-server",
        destPath: ".fabric/server/1.21.11-server.jar",
        agentChecksum: { algorithm: "sha1", value: "64bb6d763bed0a9f1d632ec347938594144943ed" },
      }),
    ]);
    expect(a.launch).toEqual({ kind: "jar", jar: "fabric-server-launcher.jar", programArgs: ["nogui"] });
    expect(a.requiresNetworkAtFirstStart).toBe(true);
    const pinned = await fabric.resolve(ctxFor(routes()), "1.21.11", "0.19.4/1.1.1");
    expect(pinned.downloads[0]!.url).toBe("https://meta.fabricmc.net/v2/versions/loader/1.21.11/0.19.4/1.1.1/server/jar");
    expect(pinned.notes.join(" ")).toMatch(/not marked stable/);
  });

  it("rejects bad build strings and unsupported versions", async () => {
    await expect(fabric.resolve(ctxFor(routes()), "1.21.11", "0.19.5/../x")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(fabric.resolve(ctxFor(routes()), "1.21.11", "0.0.1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fabric.resolve(ctxFor(routes()), "9.9", null)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Forge (maven + promotions)", () => {
  const forge = createForgeAdapter();
  const installer = forgeInstallerUrl("1.21.11-61.2.0");
  const routes = () => ({
    ...mojangRoutes(),
    [`${FORGE_MAVEN}/maven-metadata.xml`]: fixture("forge/maven-metadata.xml"),
    [FORGE_PROMOTIONS]: fixture("forge/promotions_slim.json"),
    [`${installer}.sha256`]: fixture("forge/forge-1.21.11-61.2.0-installer.jar.sha256"),
  });

  it("indexes maven versions including legacy branch suffixes", () => {
    const idx = indexForgeVersions(["1.21.11-61.2.0", "1.21.11-61.10.1", "1.21.11-61.2.1", "1.7.10-10.13.4.1614-1.7.10", "junk"]);
    expect(idx.byMinecraft.get("1.21.11")).toEqual(["61.10.1", "61.2.1", "61.2.0"]);
    expect(idx.byMinecraft.get("1.7.10")).toEqual(["10.13.4.1614-1.7.10"]);
  });

  it("lists versions and marks only the recommended build stable", async () => {
    const v = await forge.listVersions(ctxFor(routes()));
    expect(v.slice(0, 3).map((x) => x.minecraftVersion)).toEqual(["26.3", "26.2", "1.21.11"]);
    expect(v.find((x) => x.minecraftVersion === "1.7.10")?.notes.join(" ")).toMatch(/Legacy/);
    const b = await forge.listBuilds(ctxFor(routes()), "1.21.11");
    const rec = b.find((x) => x.build === "61.2.0");
    expect(rec).toMatchObject({ channel: "stable" });
    expect(b.find((x) => x.build === "61.2.1")).toMatchObject({ channel: "beta" });
    expect(b[0]!.build).toBe("61.2.1");
  });

  it("resolves the recommended build with the Maven SHA-256 sidecar and an argfile launch", async () => {
    const a = await forge.resolve(ctxFor(routes()), "1.21.11", null);
    expect(a).toMatchObject({ build: "61.2.0", channel: "stable" });
    expect(a.downloads[0]).toMatchObject({
      url: "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.11-61.2.0/forge-1.21.11-61.2.0-installer.jar",
      destPath: "forge-1.21.11-61.2.0-installer.jar",
      agentChecksum: { algorithm: "sha256", value: "86744ab72e70da23ed4aa213068ebf15841ff2575522b406dffa66a93cf7dcce" },
    });
    expect(a.install).toMatchObject({
      kind: "installer",
      javaArgs: ["-jar", "forge-1.21.11-61.2.0-installer.jar", "--installServer"],
      expects: ["libraries/net/minecraftforge/forge/1.21.11-61.2.0/unix_args.txt"],
      requiresNetwork: true,
    });
    expect(a.launch).toEqual({ kind: "argfile", argFile: "libraries/net/minecraftforge/forge/1.21.11-61.2.0/unix_args.txt", programArgs: ["nogui"] });
  });

  it("falls back to SHA-1 when no SHA-256/512 sidecar exists", async () => {
    const r: Record<string, string> = { ...routes() };
    delete r[`${installer}.sha256`];
    r[`${installer}.sha1`] = fixture("forge/forge-1.21.11-61.2.0-installer.jar.sha1");
    const a = await forge.resolve(ctxFor(r), "1.21.11", "61.2.0");
    expect(a.downloads[0]!.agentChecksum).toEqual({ algorithm: "sha1", value: "ca682f0d537c65e9a112e1e7ab337095d486298f" });
  });

  it("uses the latest promotion when no recommended build exists (26.3)", async () => {
    const r = { ...routes(), [`${forgeInstallerUrl("26.3-66.0.10")}.sha256`]: "a".repeat(64) };
    const a = await forge.resolve(ctxFor(r), "26.3", null);
    expect(a).toMatchObject({ build: "66.0.10", channel: "beta" });
    expect(a.notes.join(" ")).toMatch(/no recommended build/);
    expect(a.java.major).toBe(25);
  });

  it("uses jar candidates before 1.17", async () => {
    const r = { ...routes(), [`${forgeInstallerUrl("1.16.5-36.2.34")}.sha256`]: "b".repeat(64), [`${forgeInstallerUrl("1.12.2-14.23.5.2859")}.sha256`]: "c".repeat(64) };
    const a = await forge.resolve(ctxFor(r), "1.16.5", null);
    expect(a.launch).toEqual({ kind: "jar-candidates", candidates: ["forge-1.16.5-36.2.34.jar", "forge-1.16.5-36.2.34-universal.jar"], programArgs: ["nogui"] });
    expect(a.java.major).toBe(8);
    const old = await forge.resolve(ctxFor(r), "1.12.2", "14.23.5.2859");
    expect(old.launch.kind).toBe("jar-candidates");
  });

  it("rejects unknown builds", async () => {
    await expect(forge.resolve(ctxFor(routes()), "1.21.11", "99.0.0")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(forge.resolve(ctxFor(routes()), "0.1", null)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("NeoForge (maven.neoforged.net)", () => {
  const neo = createNeoForgeAdapter();
  const routes = () => ({
    ...mojangRoutes(),
    [`${NEOFORGE_MAVEN}/maven-metadata.xml`]: fixture("neoforge/maven-metadata.xml"),
    [`${NEOFORGE_LEGACY_MAVEN}/maven-metadata.xml`]: fixture("neoforge/forge-1.20.1-maven-metadata.xml"),
    [`${NEOFORGE_MAVEN}/26.3.0.76/neoforge-26.3.0.76-installer.jar.sha256`]: "d".repeat(64),
    [`${NEOFORGE_MAVEN}/21.1.259/neoforge-21.1.259-installer.jar.sha256`]: "e".repeat(64),
    [`${NEOFORGE_MAVEN}/26.1.0.19-beta/neoforge-26.1.0.19-beta-installer.jar.sha256`]: "f".repeat(64),
    [`${NEOFORGE_LEGACY_MAVEN}/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar.sha256`]: "0".repeat(64),
  });

  it.each([
    ["20.2.93", "1.20.2", "stable"],
    ["20.2.3-beta", "1.20.2", "beta"],
    ["20.4.251", "1.20.4", "stable"],
    ["21.0.167", "1.21", "stable"],
    ["21.1.259", "1.21.1", "stable"],
    ["21.11.45", "1.21.11", "stable"],
    ["26.1.0.19-beta", "26.1", "beta"],
    ["26.1.2.116", "26.1.2", "stable"],
    ["26.2.0.90", "26.2", "stable"],
    ["26.3.0.76", "26.3", "stable"],
    ["26.1.0.0-alpha.1+snapshot-1", "26.1-snapshot-1", "alpha"],
  ])("maps NeoForge %s → Minecraft %s (%s)", (v, mc, channel) => {
    expect(neoForgeToMinecraft(v)).toEqual({ minecraftVersion: mc, channel });
  });

  it("ignores unknown schemes", () => {
    expect(neoForgeToMinecraft("0.25w14craftmine.3-beta")).toBeNull();
    expect(neoForgeToMinecraft("47.1.82")).toBeNull();
  });

  it("lists Minecraft versions including the legacy 1.20.1 line", async () => {
    const v = await neo.listVersions(ctxFor(routes()));
    const ids = v.map((x) => x.minecraftVersion);
    expect(ids.slice(0, 4)).toEqual(["26.3", "26.2", "26.1.2", "26.1"]);
    expect(ids).toContain("1.20.1");
    expect(ids).toContain("26.1-snapshot-1");
    expect(v.find((x) => x.minecraftVersion === "26.1")?.notes.join(" ")).toMatch(/Only beta/);
  });

  it("resolves stable builds with an argfile launch and the Maven checksum", async () => {
    const a = await neo.resolve(ctxFor(routes()), "26.3", null);
    expect(a).toMatchObject({ build: "26.3.0.76", channel: "stable" });
    expect(a.java.major).toBe(25);
    expect(a.launch).toEqual({ kind: "argfile", argFile: "libraries/net/neoforged/neoforge/26.3.0.76/unix_args.txt", programArgs: ["nogui"] });
    expect(a.downloads[0]!.url).toBe("https://maven.neoforged.net/releases/net/neoforged/neoforge/26.3.0.76/neoforge-26.3.0.76-installer.jar");
    const b = await neo.resolve(ctxFor(routes()), "21.1".replace("21.1", "1.21.1"), null);
    expect(b.build).toBe("21.1.259");
  });

  it("falls back to beta and supports the legacy 1.20.1 artifact", async () => {
    const beta = await neo.resolve(ctxFor(routes()), "26.1", null);
    expect(beta).toMatchObject({ build: "26.1.0.19-beta", channel: "beta" });
    const legacy = await neo.resolve(ctxFor(routes()), "1.20.1", null);
    expect(legacy.build).toBe("47.1.106");
    expect(legacy.downloads[0]!.url).toBe("https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar");
    expect(legacy.launch).toMatchObject({ argFile: "libraries/net/neoforged/forge/1.20.1-47.1.106/unix_args.txt" });
  });
});

describe("Spigot", () => {
  it("refuses to provision and explains BuildTools", async () => {
    const spigot = createSpigotAdapter();
    expect(await spigot.listVersions(ctxFor({}))).toEqual([]);
    await expect(spigot.resolve(ctxFor({}), "1.21.11", null)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(spigot.info.restrictions[0]).toMatch(/BuildTools/);
  });
});

describe("catalogue contract conformance", () => {
  it("every SoftwareInfo matches the contract schema", () => {
    const infos = listSoftwareInfo(createCatalog());
    expect(infos.map((i) => i.software).sort()).toEqual(["fabric", "folia", "forge", "neoforge", "paper", "purpur", "spigot", "vanilla", "velocity"]);
    for (const i of infos) {
      expect(SoftwareInfo.parse(i)).toEqual(i);
      expect(i.restrictions.length).toBeGreaterThan(0);
    }
  });

  it("listed versions and builds parse as contract types", async () => {
    const catalog = createCatalog();
    const ctx = ctxFor({
      ...mojangRoutes(),
      [`${FORGE_MAVEN}/maven-metadata.xml`]: fixture("forge/maven-metadata.xml"),
      [FORGE_PROMOTIONS]: fixture("forge/promotions_slim.json"),
    });
    for (const v of await catalog.vanilla.listVersions(ctx)) SoftwareVersion.parse(v);
    for (const b of await catalog.forge.listBuilds(ctx, "1.21.11")) SoftwareBuild.parse(b);
    for (const b of await catalog.vanilla.listBuilds(ctx, "26.3")) SoftwareBuild.parse(b);
  });
});
