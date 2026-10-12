import type { SoftwareBuild, SoftwareInfo } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { type CatalogContext, getText, parseMavenMetadataVersions } from "../http.js";
import { javaMajorFromTable, requiredJavaMajor } from "../java.js";
import { compareMinecraftVersions, parseMinecraftVersion } from "../versions.js";
import { compareDotted, fetchMavenChecksum } from "./maven.js";
import { mojangJavaMajor } from "./mojang.js";
import { type CatalogVersion, type ResolvedArtifact, type SoftwareAdapter, toAgentChecksum } from "./types.js";

/**
 * NeoForge (verified 2026-10-11 against maven.neoforged.net and installer `version.json`
 * `inheritsFrom`):
 *  - https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml
 *    • 1.20.2 – 1.21.11 use `<mcMinor>.<mcPatch>.<build>[-beta]`: 20.2.93 → 1.20.2,
 *      21.0.167 → 1.21, 21.1.259 → 1.21.1 (installer inheritsFrom "1.21.1"), 21.11.45 → 1.21.11;
 *    • year-based Minecraft (26.x) uses `<year>.<drop>.<hotfix>.<build>[-beta]`:
 *      26.1.0.19-beta → 26.1, 26.1.2.116 → 26.1.2, 26.3.0.76 → 26.3 (inheritsFrom "26.3");
 *      snapshot builds carry build metadata: `26.1.0.0-alpha.1+snapshot-1` → 26.1-snapshot-1;
 *    • April-fools builds like `0.25w14craftmine.3-beta` are ignored.
 *  - 1.20.1 lives at …/net/neoforged/forge/ as `1.20.1-47.1.x` (one stray `47.1.82` entry is
 *    ignored).
 *  - installer `<v>/neoforge-<v>-installer.jar` with `.sha256/.sha512/.sha1/.md5` sidecars;
 *    `data/run.sh`: `java @user_jvm_args.txt @libraries/net/neoforged/neoforge/<v>/unix_args.txt "$@"`.
 */
export const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
export const NEOFORGE_LEGACY_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/forge";

export interface NeoForgeBuildRef {
  /** Maven version (artifact version). */
  mavenVersion: string;
  /** Build id exposed to users: the NeoForge version (legacy 1.20.1: `47.1.x`). */
  build: string;
  minecraftVersion: string;
  channel: SoftwareBuild["channel"];
  legacy: boolean;
}

const YEAR_BASED = /^(\d{2,})\.(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)(?:\.\d+)?)?(?:\+([A-Za-z0-9.-]+))?$/;
const LEGACY = /^(\d{2})\.(\d+)\.(\d+)(?:-(alpha|beta))?$/;

/** Maps a NeoForge version to its Minecraft version, or null when the scheme is unknown. */
export function neoForgeToMinecraft(v: string): { minecraftVersion: string; channel: SoftwareBuild["channel"] } | null {
  const y = YEAR_BASED.exec(v);
  if (y && Number(y[1]) >= 25) {
    const hotfix = Number(y[3]);
    const base = `${y[1]}.${Number(y[2])}${hotfix > 0 ? `.${hotfix}` : ""}`;
    const meta = y[6] ? /^(snapshot|pre|rc)-(\d+)$/.exec(y[6]) : null;
    if (y[6] && !meta) return null;
    const minecraftVersion = meta ? `${base}-${meta[1]}-${meta[2]}` : base;
    const channel = y[5] === "alpha" ? "alpha" : y[5] === "beta" ? "beta" : "stable";
    return { minecraftVersion, channel };
  }
  const l = LEGACY.exec(v);
  if (l && Number(l[1]) >= 20 && Number(l[1]) <= 21) {
    const patch = Number(l[2]);
    const minecraftVersion = `1.${Number(l[1])}${patch > 0 ? `.${patch}` : ""}`;
    const channel = l[4] === "alpha" ? "alpha" : l[4] === "beta" ? "beta" : "stable";
    return { minecraftVersion, channel };
  }
  return null;
}

export function indexNeoForge(modern: string[], legacy: string[]): Map<string, NeoForgeBuildRef[]> {
  const out = new Map<string, NeoForgeBuildRef[]>();
  const add = (r: NeoForgeBuildRef) => {
    const list = out.get(r.minecraftVersion) ?? [];
    list.push(r);
    out.set(r.minecraftVersion, list);
  };
  for (const v of modern) {
    const m = neoForgeToMinecraft(v);
    if (m) add({ mavenVersion: v, build: v, minecraftVersion: m.minecraftVersion, channel: m.channel, legacy: false });
  }
  for (const v of legacy) {
    const m = /^1\.20\.1-(\d+\.\d+\.\d+)$/.exec(v);
    if (m?.[1]) add({ mavenVersion: v, build: m[1], minecraftVersion: "1.20.1", channel: "stable", legacy: true });
  }
  for (const list of out.values()) {
    list.sort((a, b) => compareDotted(b.build.split("+")[0] ?? b.build, a.build.split("+")[0] ?? a.build));
  }
  return out;
}

async function index(ctx: CatalogContext): Promise<Map<string, NeoForgeBuildRef[]>> {
  const [modern, legacy] = await Promise.all([
    getText(ctx, `${NEOFORGE_MAVEN}/maven-metadata.xml`, "application/xml"),
    getText(ctx, `${NEOFORGE_LEGACY_MAVEN}/maven-metadata.xml`, "application/xml"),
  ]);
  return indexNeoForge(parseMavenMetadataVersions(modern), parseMavenMetadataVersions(legacy));
}

export function neoForgeInstallerUrl(ref: Pick<NeoForgeBuildRef, "mavenVersion" | "legacy">): string {
  const v = encodeURIComponent(ref.mavenVersion);
  return ref.legacy ? `${NEOFORGE_LEGACY_MAVEN}/${v}/forge-${v}-installer.jar` : `${NEOFORGE_MAVEN}/${v}/neoforge-${v}-installer.jar`;
}

export const NEOFORGE_INFO: SoftwareInfo = {
  software: "neoforge",
  displayName: "NeoForge",
  kind: "game",
  description: "Community fork of MinecraftForge (from 1.20.1) with its own mod ecosystem.",
  supportsPlugins: false,
  supportsMods: true,
  restrictions: [
    "Runs NeoForge mods, not Bukkit/Paper plugins; most Forge mods for 1.20.2+ are not compatible.",
    "Installation runs the NeoForge installer (`--installServer`) inside the container first; it downloads the vanilla server and libraries, so outbound HTTPS is required.",
    "Builds marked -beta by NeoForge are offered as beta; new Minecraft versions often only have beta builds at first.",
    "Behind Velocity, forwarding needs an extra mod (e.g. Proxy Compatible Forge) and is not available for every version.",
  ],
  source: `${NEOFORGE_MAVEN}/maven-metadata.xml`,
};

export function createNeoForgeAdapter(): SoftwareAdapter {
  return {
    info: NEOFORGE_INFO,

    async listVersions(ctx) {
      const idx = await index(ctx);
      return [...idx.keys()]
        .map((mc): CatalogVersion => {
          const p = parseMinecraftVersion(mc);
          return {
            minecraftVersion: mc,
            channel: p.kind === "release-like" && p.stage === "release" ? "release" : "snapshot",
            javaMajor: javaMajorFromTable("neoforge", mc),
            javaSource: "table",
            releasedAt: null,
            support: null,
            notes: (idx.get(mc) ?? []).every((r) => r.channel !== "stable") ? ["Only beta/alpha NeoForge builds exist for this version."] : [],
          };
        })
        .sort((a, b) => compareMinecraftVersions(b.minecraftVersion, a.minecraftVersion));
    },

    async listBuilds(ctx, version) {
      const refs = (await index(ctx)).get(version) ?? [];
      return refs.map(
        (r): SoftwareBuild => ({
          build: r.build,
          channel: r.channel,
          downloadUrl: neoForgeInstallerUrl(r),
          checksum: null,
          releasedAt: null,
          provenance: "NeoForged Maven (maven.neoforged.net)",
          notes: ["SHA-256 is read from the NeoForged Maven sidecar at resolve time."],
        }),
      );
    },

    async resolve(ctx, version, build) {
      const refs = (await index(ctx)).get(version) ?? [];
      if (refs.length === 0) throw new CatalogError("NOT_FOUND", `NeoForge has no builds for Minecraft ${version}`);
      const notes: string[] = [];
      let ref: NeoForgeBuildRef | undefined;
      if (build === null) {
        ref = refs.find((r) => r.channel === "stable") ?? refs[0];
        if (ref && ref.channel !== "stable") notes.push(`NeoForge has no stable build for ${version}; using ${ref.channel} build ${ref.build}.`);
      } else {
        ref = refs.find((r) => r.build === build);
        if (!ref) throw new CatalogError("NOT_FOUND", `NeoForge build ${build} does not exist for Minecraft ${version}`);
      }
      if (!ref) throw new CatalogError("NOT_FOUND", `NeoForge has no builds for Minecraft ${version}`);
      const url = neoForgeInstallerUrl(ref);
      const checksum = await fetchMavenChecksum(ctx, url);
      if (!checksum) notes.push("NeoForged Maven publishes no checksum sidecar for this installer.");
      const java = requiredJavaMajor({ software: "neoforge", version, mojangMajor: await mojangJavaMajor(ctx, version) });
      const installer = ref.legacy ? `forge-${ref.mavenVersion}-installer.jar` : `neoforge-${ref.mavenVersion}-installer.jar`;
      const argFile = ref.legacy
        ? `libraries/net/neoforged/forge/${ref.mavenVersion}/unix_args.txt`
        : `libraries/net/neoforged/neoforge/${ref.mavenVersion}/unix_args.txt`;
      if (ref.legacy) notes.push("NeoForge for 1.20.1 is the legacy Forge-derived line; its launch path mirrors Forge 1.20.1 and has not been run by BlockForge.");
      const artifact: ResolvedArtifact = {
        software: "neoforge",
        version,
        build: ref.build,
        channel: ref.channel,
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
              ? `NeoForged Maven installer; ${checksum.algorithm.toUpperCase()} from the Maven sidecar on the same host`
              : "NeoForged Maven installer; no checksum published",
          },
        ],
        java: { major: java.major, source: java.source, notes: java.notes },
        install: {
          kind: "installer",
          javaArgs: ["-jar", installer, "--installServer"],
          expects: [argFile],
          cleanup: [installer, `${installer}.log`],
          requiresNetwork: true,
          notes: ["Run once in a container with the data root as working directory; exit code 0 means success."],
        },
        launch: { kind: "argfile", argFile, programArgs: ["nogui"] },
        requiresNetworkAtFirstStart: false,
        recommendedJvmFlags: null,
        provenance: `NeoForge ${ref.mavenVersion}`,
        notes,
      };
      return artifact;
    },
  };
}
