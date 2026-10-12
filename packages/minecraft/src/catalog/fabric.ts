import { z } from "zod";
import type { SoftwareBuild, SoftwareInfo } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { type CatalogContext, assertArtifactUrl, getJson } from "../http.js";
import { javaMajorFromTable, requiredJavaMajor } from "../java.js";
import { getMojangVersion } from "./mojang.js";
import { type CatalogVersion, type ResolvedArtifact, type SoftwareAdapter, safeSegment, toAgentChecksum } from "./types.js";

/**
 * Fabric meta API v2 — https://meta.fabricmc.net/v2/versions (verified 2026-10-11):
 *  - /game → `[{version, stable}]` newest first; /loader → `[{version, stable, build, maven}]`;
 *    /installer → `[{version, stable, url, maven}]`; /loader/{game} → `[{loader, intermediary,
 *    launcherMeta}]`;
 *  - the server launcher jar `/loader/{game}/{loader}/{installer}/server/jar` is generated on
 *    demand (chunked, no Content-Length) and **no checksum is published** for it;
 *  - the launcher (fabric-installer `ServerLauncher`) looks for the vanilla jar at
 *    `.fabric/server/<game>-server.jar` and downloads it from Mojang only when missing
 *    (fabric-installer src/main/java/net/fabricmc/installer/ServerLauncher.java), and installs
 *    Fabric's libraries from maven.fabricmc.net on first start.
 * BlockForge therefore pre-places the Mojang server jar (SHA-1 verified) so the only unverified
 * download is the small launcher jar plus the libraries it fetches.
 */
export const FABRIC_META = "https://meta.fabricmc.net/v2/versions";

const Game = z.array(z.object({ version: z.string(), stable: z.boolean() }));
const Installer = z.array(z.object({ version: z.string(), stable: z.boolean(), url: z.string().optional() }));
const LoaderForGame = z.array(
  z.object({
    loader: z.object({ version: z.string(), stable: z.boolean(), build: z.number().int().optional() }),
    intermediary: z.object({ version: z.string() }).optional(),
    launcherMeta: z.object({ min_java_version: z.number().int().optional() }).catchall(z.unknown()).optional(),
  }),
);

const LAUNCHER_JAR = "fabric-server-launcher.jar";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export const FABRIC_INFO: SoftwareInfo = {
  software: "fabric",
  displayName: "Fabric",
  kind: "game",
  description: "Lightweight mod loader; runs Fabric (and many Quilt-compatible) mods.",
  supportsPlugins: false,
  supportsMods: true,
  restrictions: [
    "Runs Fabric mods, not Bukkit/Paper plugins; most server-side mods also need Fabric API.",
    "Mods must match the exact Minecraft version; clients usually need the same mods installed.",
    "Fabric's server launcher jar is generated on demand and has no published checksum; it downloads Fabric libraries from maven.fabricmc.net on first start (outbound HTTPS required).",
    "Behind Velocity, modern forwarding requires the FabricProxy-Lite mod.",
  ],
  source: FABRIC_META,
};

export function fabricServerJarUrl(game: string, loader: string, installer: string): string {
  return `${FABRIC_META}/loader/${safeSegment("version", game)}/${safeSegment("build", loader)}/${safeSegment("build", installer)}/server/jar`;
}

async function latestInstaller(ctx: CatalogContext): Promise<string> {
  const installers = await getJson(ctx, `${FABRIC_META}/installer`, Installer);
  const pick = installers.find((i) => i.stable) ?? installers[0];
  if (!pick) throw new CatalogError("UNAVAILABLE", "Fabric meta lists no installer versions");
  return pick.version;
}

async function loadersFor(ctx: CatalogContext, game: string) {
  return getJson(ctx, `${FABRIC_META}/loader/${safeSegment("version", game)}`, LoaderForGame);
}

export function createFabricAdapter(): SoftwareAdapter {
  return {
    info: FABRIC_INFO,

    async listVersions(ctx) {
      const games = await getJson(ctx, `${FABRIC_META}/game`, Game);
      return games.map(
        (g): CatalogVersion => ({
          minecraftVersion: g.version,
          channel: g.stable ? "release" : "snapshot",
          javaMajor: javaMajorFromTable("fabric", g.version),
          javaSource: "table",
          releasedAt: null,
          support: null,
          notes: [],
        }),
      );
    },

    async listBuilds(ctx, version) {
      const [loaders, installer] = await Promise.all([loadersFor(ctx, version), latestInstaller(ctx)]);
      return loaders.map(
        (l): SoftwareBuild => ({
          build: l.loader.version,
          channel: l.loader.stable ? "stable" : "beta",
          downloadUrl: fabricServerJarUrl(version, l.loader.version, installer),
          checksum: null,
          releasedAt: null,
          provenance: `Fabric meta API v2 (loader ${l.loader.version}, installer ${installer})`,
          notes: ["Fabric's server launcher jar is generated on demand; no checksum is published."],
        }),
      );
    },

    async resolve(ctx, version, build) {
      let loaderVersion: string | null = null;
      let installerVersion: string | null = null;
      if (build !== null) {
        const [l, i, ...rest] = build.split("/");
        if (!l || !TOKEN.test(l) || rest.length > 0 || (i !== undefined && !TOKEN.test(i))) {
          throw new CatalogError("INVALID_ARGUMENT", `invalid Fabric build "${build}" (expected "<loader>" or "<loader>/<installer>")`);
        }
        loaderVersion = l;
        installerVersion = i ?? null;
      }
      const loaders = await loadersFor(ctx, version);
      if (loaders.length === 0) throw new CatalogError("NOT_FOUND", `Fabric does not support Minecraft ${version}`);
      const notes: string[] = [];
      const chosen = loaderVersion === null ? (loaders.find((l) => l.loader.stable) ?? loaders[0]) : loaders.find((l) => l.loader.version === loaderVersion);
      if (!chosen) throw new CatalogError("NOT_FOUND", `Fabric loader ${loaderVersion} is not available for Minecraft ${version}`);
      if (!chosen.loader.stable) notes.push(`Fabric loader ${chosen.loader.version} is not marked stable.`);
      const installer = installerVersion ?? (await latestInstaller(ctx));
      const mojang = await getMojangVersion(ctx, version);
      const server = mojang.downloads["server"];
      if (!server) throw new CatalogError("UNAVAILABLE", `Mojang publishes no server download for ${version}`);
      assertArtifactUrl(ctx, server.url);
      const java = requiredJavaMajor({ software: "fabric", version, mojangMajor: mojang.javaVersion?.majorVersion ?? null });
      const vanillaSum = { algorithm: "sha1" as const, value: server.sha1 };
      const build_ = `${chosen.loader.version}/${installer}`;
      const artifact: ResolvedArtifact = {
        software: "fabric",
        version,
        build: build_,
        channel: chosen.loader.stable ? "stable" : "beta",
        releasedAt: null,
        downloads: [
          {
            role: "launcher",
            url: fabricServerJarUrl(version, chosen.loader.version, installer),
            destPath: LAUNCHER_JAR,
            checksum: null,
            agentChecksum: null,
            sizeBytes: null,
            provenance: "Fabric meta API v2 server launcher (generated on demand; no checksum published — HTTPS transport integrity only)",
          },
          {
            role: "vanilla-server",
            url: server.url,
            destPath: `.fabric/server/${version}-server.jar`,
            checksum: vanillaSum,
            agentChecksum: toAgentChecksum(vanillaSum),
            sizeBytes: server.size,
            provenance: "Mojang piston-meta downloads.server (SHA-1), pre-placed where Fabric's launcher expects it",
          },
        ],
        java: { major: java.major, source: java.source, notes: java.notes },
        install: { kind: "none" },
        launch: { kind: "jar", jar: LAUNCHER_JAR, programArgs: ["nogui"] },
        requiresNetworkAtFirstStart: true,
        recommendedJvmFlags: null,
        provenance: `Fabric loader ${chosen.loader.version} with installer ${installer} (meta.fabricmc.net)`,
        notes,
      };
      return artifact;
    },
  };
}
