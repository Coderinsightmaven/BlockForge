import { z } from "zod";
import type { SoftwareBuild, SoftwareInfo } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { type CatalogContext, getJson, getText, parseMavenMetadataVersions } from "../http.js";
import { javaMajorFromTable, requiredJavaMajor } from "../java.js";
import { compareMinecraftVersions, isAtLeast, parseMinecraftVersion } from "../versions.js";
import { compareDotted, fetchMavenChecksum } from "./maven.js";
import { mojangJavaMajor } from "./mojang.js";
import { type CatalogVersion, type LaunchTarget, type ResolvedArtifact, type SoftwareAdapter, toAgentChecksum } from "./types.js";

/**
 * MinecraftForge (verified 2026-10-11):
 *  - builds: https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml,
 *    `<mc>-<forge>` (old ones carry a branch suffix, e.g. `1.7.10-10.13.4.1614-1.7.10`);
 *  - promotions: https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json
 *    `{promos: {"<mc>-recommended": "<forge>", "<mc>-latest": "<forge>"}}`; Forge does not label
 *    other builds, so only the promoted "recommended" build is treated as stable;
 *  - installer jar `<v>/forge-<v>-installer.jar` with `.sha256/.sha512/.sha1/.md5` sidecars;
 *  - launch, from the installer's own `data/run.sh` + `data/unix_args.txt`:
 *      MC >= 1.17 (Forge 37+):   java @user_jvm_args.txt @libraries/net/minecraftforge/forge/<v>/unix_args.txt "$@"
 *        (1.20.3+ installers add `forge-<v>-shim.jar`; unix_args.txt then just contains
 *        `-jar forge-<v>-shim.jar` plus JVM flags, so the argfile launch stays uniform);
 *      MC <  1.17: the installer writes an executable jar `forge-<v>.jar` (very old installers:
 *        `forge-<v>-universal.jar`) that is started with `java -jar`.
 * BlockForge does not use user_jvm_args.txt: JVM flags come from the launch builder.
 */
export const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
export const FORGE_PROMOTIONS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

const Promotions = z.object({ promos: z.record(z.string(), z.string()) });
const BUILD_TOKEN = /^[0-9][A-Za-z0-9._-]{0,63}$/;

export const FORGE_INFO: SoftwareInfo = {
  software: "forge",
  displayName: "Forge",
  kind: "game",
  description: "MinecraftForge mod loader.",
  supportsPlugins: false,
  supportsMods: true,
  restrictions: [
    "Runs Forge mods, not Bukkit/Paper plugins; mods are tied to an exact Minecraft version.",
    "Installation runs the Forge installer (`--installServer`) inside the container first; it downloads the vanilla server and libraries, so outbound HTTPS is required.",
    "Forge does not label build stability: only the promoted \"recommended\" build is treated as stable, everything else as beta.",
    "Behind Velocity, forwarding needs an extra mod (e.g. Proxy Compatible Forge) and is not available for every version.",
    "Versions older than 1.12.2 use legacy installers that BlockForge has not tested.",
  ],
  source: FORGE_PROMOTIONS,
};

export interface MavenVersionIndex {
  /** Minecraft version → build ids (without the `<mc>-` prefix), newest first. */
  byMinecraft: Map<string, string[]>;
}

export function indexForgeVersions(mavenVersions: string[]): MavenVersionIndex {
  const byMinecraft = new Map<string, string[]>();
  for (const v of mavenVersions) {
    const i = v.indexOf("-");
    if (i <= 0) continue;
    const mc = v.slice(0, i);
    const build = v.slice(i + 1);
    if (!/^\d/.test(mc) || !BUILD_TOKEN.test(build)) continue;
    const list = byMinecraft.get(mc) ?? [];
    list.push(build);
    byMinecraft.set(mc, list);
  }
  for (const list of byMinecraft.values()) list.sort((a, b) => compareDotted(b, a));
  return { byMinecraft };
}

async function forgeIndex(ctx: CatalogContext): Promise<MavenVersionIndex> {
  return indexForgeVersions(parseMavenMetadataVersions(await getText(ctx, `${FORGE_MAVEN}/maven-metadata.xml`, "application/xml")));
}

export function forgeInstallerUrl(mavenVersion: string): string {
  return `${FORGE_MAVEN}/${encodeURIComponent(mavenVersion)}/forge-${encodeURIComponent(mavenVersion)}-installer.jar`;
}

export function forgeLaunchTarget(minecraftVersion: string, mavenVersion: string): LaunchTarget {
  if (isAtLeast(minecraftVersion, "1.17") === true) {
    return { kind: "argfile", argFile: `libraries/net/minecraftforge/forge/${mavenVersion}/unix_args.txt`, programArgs: ["nogui"] };
  }
  return { kind: "jar-candidates", candidates: [`forge-${mavenVersion}.jar`, `forge-${mavenVersion}-universal.jar`], programArgs: ["nogui"] };
}

export function createForgeAdapter(): SoftwareAdapter {
  return {
    info: FORGE_INFO,

    async listVersions(ctx) {
      const idx = await forgeIndex(ctx);
      return [...idx.byMinecraft.keys()]
        .map((mc): CatalogVersion => {
          const p = parseMinecraftVersion(mc);
          return {
            minecraftVersion: mc,
            channel: p.kind === "release-like" && p.stage === "release" ? "release" : "snapshot",
            javaMajor: p.kind === "release-like" ? javaMajorFromTable("forge", mc) : null,
            javaSource: p.kind === "release-like" ? "table" : null,
            releasedAt: null,
            support: null,
            notes: isAtLeast(mc, "1.12.2") === false ? ["Legacy Forge installer; not tested by BlockForge."] : [],
          };
        })
        .sort((a, b) => compareMinecraftVersions(b.minecraftVersion, a.minecraftVersion));
    },

    async listBuilds(ctx, version) {
      const [idx, promos] = await Promise.all([forgeIndex(ctx), getJson(ctx, FORGE_PROMOTIONS, Promotions)]);
      const builds = idx.byMinecraft.get(version) ?? [];
      const rec = promos.promos[`${version}-recommended`];
      const latest = promos.promos[`${version}-latest`];
      return builds.map((b): SoftwareBuild => {
        const notes: string[] = [];
        if (b === rec) notes.push("Promoted as recommended by Forge.");
        if (b === latest) notes.push("Promoted as latest by Forge.");
        notes.push("SHA-256 is read from the Forge Maven sidecar at resolve time.");
        return {
          build: b,
          channel: b === rec ? "stable" : "beta",
          downloadUrl: forgeInstallerUrl(`${version}-${b}`),
          checksum: null,
          releasedAt: null,
          provenance: "MinecraftForge Maven (maven.minecraftforge.net)",
          notes,
        };
      });
    },

    async resolve(ctx, version, build) {
      const [idx, promos] = await Promise.all([forgeIndex(ctx), getJson(ctx, FORGE_PROMOTIONS, Promotions)]);
      const builds = idx.byMinecraft.get(version);
      if (!builds || builds.length === 0) throw new CatalogError("NOT_FOUND", `Forge has no builds for Minecraft ${version}`);
      const notes: string[] = [];
      let chosen: string;
      const rec = promos.promos[`${version}-recommended`];
      if (build === null) {
        const latest = promos.promos[`${version}-latest`];
        if (rec && builds.includes(rec)) chosen = rec;
        else {
          chosen = latest && builds.includes(latest) ? latest : builds[0]!;
          notes.push(`Forge has no recommended build for ${version}; using ${chosen} (not promoted as recommended).`);
        }
      } else {
        if (!BUILD_TOKEN.test(build) || !builds.includes(build)) throw new CatalogError("NOT_FOUND", `Forge build ${build} does not exist for Minecraft ${version}`);
        chosen = build;
      }
      const mavenVersion = `${version}-${chosen}`;
      const url = forgeInstallerUrl(mavenVersion);
      const checksum = await fetchMavenChecksum(ctx, url);
      if (!checksum) notes.push("Forge Maven publishes no checksum sidecar for this installer.");
      const java = requiredJavaMajor({ software: "forge", version, mojangMajor: await mojangJavaMajor(ctx, version) });
      const installer = `forge-${mavenVersion}-installer.jar`;
      const launch = forgeLaunchTarget(version, mavenVersion);
      if (isAtLeast(version, "1.12.2") === false) notes.push("Legacy Forge installer; not tested by BlockForge.");
      const artifact: ResolvedArtifact = {
        software: "forge",
        version,
        build: chosen,
        channel: chosen === rec ? "stable" : "beta",
        releasedAt: null,
        downloads: [
          {
            role: "installer",
            url,
            destPath: installer,
            checksum,
            agentChecksum: toAgentChecksum(checksum),
            sizeBytes: null,
            provenance: checksum
              ? `MinecraftForge Maven installer; ${checksum.algorithm.toUpperCase()} from the Maven sidecar on the same host`
              : "MinecraftForge Maven installer; no checksum published",
          },
        ],
        java: { major: java.major, source: java.source, notes: java.notes },
        install: {
          kind: "installer",
          javaArgs: ["-jar", installer, "--installServer"],
          expects: launch.kind === "argfile" ? [launch.argFile] : [],
          cleanup: [installer, `${installer}.log`],
          requiresNetwork: true,
          notes: [
            "Run once in a container with the data root as working directory; exit code 0 means success.",
            ...(launch.kind === "jar-candidates" ? ["After install, launch the first existing candidate jar."] : []),
          ],
        },
        launch,
        requiresNetworkAtFirstStart: false,
        recommendedJvmFlags: null,
        provenance: `MinecraftForge ${mavenVersion}`,
        notes,
      };
      return artifact;
    },
  };
}
