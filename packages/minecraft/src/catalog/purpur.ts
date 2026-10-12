import { z } from "zod";
import type { SoftwareBuild, SoftwareInfo } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { type CatalogContext, getJson } from "../http.js";
import { javaMajorFromTable, requiredJavaMajor } from "../java.js";
import { compareMinecraftVersions, parseMinecraftVersion } from "../versions.js";
import { mojangJavaMajor } from "./mojang.js";
import { type CatalogVersion, type ResolvedArtifact, type SoftwareAdapter, safeSegment } from "./types.js";

/**
 * Purpur API v2 — https://api.purpurmc.org/v2/purpur (verified 2026-10-11):
 *  - GET /v2/purpur → `{project, metadata: {current}, versions: string[]}` (oldest first);
 *  - GET /v2/purpur/{v}?detailed=true → `{builds: {latest: Build, all: Build[]}}`;
 *  - Build: `{build, result: SUCCESS|FAILURE, timestamp (ms), commits, metadata: {type?:
 *    "experimental"}, md5: string|null}` — **only MD5 is published** (no SHA-*);
 *  - jar: GET /v2/purpur/{v}/{build}/download (served directly, `content-disposition` filename).
 */
export const PURPUR_BASE = "https://api.purpurmc.org/v2/purpur";

const PurpurProject = z.object({ project: z.literal("purpur"), versions: z.array(z.string()) });
const PurpurBuild = z.object({
  project: z.string().optional(),
  version: z.string(),
  build: z.string().regex(/^\d+$/),
  result: z.string(),
  timestamp: z.number().int().nonnegative().nullable().optional(),
  commits: z.array(z.object({ description: z.string().optional(), hash: z.string().optional() })).default([]),
  metadata: z.object({ type: z.string().optional() }).catchall(z.unknown()).default({}),
  md5: z.string().regex(/^[a-fA-F0-9]{32}$/).nullable().optional(),
});
type PurpurBuild = z.infer<typeof PurpurBuild>;
const PurpurDetailed = z.object({ version: z.string(), builds: z.object({ latest: PurpurBuild.nullable().optional(), all: z.array(PurpurBuild) }) });

export const PURPUR_INFO: SoftwareInfo = {
  software: "purpur",
  displayName: "Purpur",
  kind: "game",
  description: "Paper fork with extra gameplay configuration options.",
  supportsPlugins: true,
  supportsMods: false,
  restrictions: [
    "Runs Bukkit/Spigot/Paper plugins only; Fabric, Forge and NeoForge mods are not supported.",
    "PurpurMC publishes only MD5 checksums. MD5 detects corruption but is not collision-resistant, and the BlockForge agent cannot verify it yet — downloads rely on HTTPS transport integrity.",
    "Many builds are flagged experimental by PurpurMC; failed CI builds are never offered.",
    "Downloads the vanilla server jar from Mojang on first start (Paperclip), so the container needs outbound HTTPS once.",
  ],
  source: PURPUR_BASE,
};

function channelOf(b: PurpurBuild): SoftwareBuild["channel"] {
  return b.metadata.type === "experimental" ? "experimental" : "stable";
}

function downloadUrl(version: string, build: string): string {
  return `${PURPUR_BASE}/${safeSegment("version", version)}/${safeSegment("build", build)}/download`;
}

async function successfulBuilds(ctx: CatalogContext, version: string): Promise<PurpurBuild[]> {
  const d = await getJson(ctx, `${PURPUR_BASE}/${safeSegment("version", version)}?detailed=true`, PurpurDetailed);
  return d.builds.all.filter((b) => b.result === "SUCCESS").sort((a, b) => Number(b.build) - Number(a.build));
}

export function createPurpurAdapter(): SoftwareAdapter {
  return {
    info: PURPUR_INFO,

    async listVersions(ctx) {
      const p = await getJson(ctx, PURPUR_BASE, PurpurProject);
      return p.versions
        .map((id): CatalogVersion => {
          const parsed = parseMinecraftVersion(id);
          return {
            minecraftVersion: id,
            channel: parsed.kind === "release-like" && parsed.stage === "release" ? "release" : "snapshot",
            javaMajor: javaMajorFromTable("purpur", id),
            javaSource: "table",
            releasedAt: null,
            support: null,
            notes: [],
          };
        })
        .sort((a, b) => compareMinecraftVersions(b.minecraftVersion, a.minecraftVersion));
    },

    async listBuilds(ctx, version) {
      const builds = await successfulBuilds(ctx, version);
      return builds.map(
        (b): SoftwareBuild => ({
          build: b.build,
          channel: channelOf(b),
          downloadUrl: downloadUrl(version, b.build),
          checksum: null,
          releasedAt: b.timestamp ?? null,
          provenance: "PurpurMC API v2",
          notes: [
            b.md5 ? `PurpurMC publishes only an MD5 checksum (${b.md5.toLowerCase()}).` : "No checksum published.",
            ...b.commits.slice(0, 3).map((c) => (c.description ?? "").split("\n")[0]?.slice(0, 200) ?? ""),
          ].filter((n) => n !== ""),
        }),
      );
    },

    async resolve(ctx, version, build) {
      const notes: string[] = [];
      let chosen: PurpurBuild | undefined;
      if (build === null) {
        const builds = await successfulBuilds(ctx, version);
        chosen = builds.find((b) => channelOf(b) === "stable") ?? builds[0];
        if (chosen && channelOf(chosen) !== "stable") {
          notes.push(`No non-experimental Purpur build exists for ${version}; using experimental build ${chosen.build}.`);
        }
        if (!chosen) throw new CatalogError("UNAVAILABLE", `Purpur ${version} has no successful builds`);
      } else {
        if (!/^\d{1,9}$/.test(build)) throw new CatalogError("INVALID_ARGUMENT", `invalid Purpur build: ${build}`);
        chosen = await getJson(ctx, `${PURPUR_BASE}/${safeSegment("version", version)}/${build}`, PurpurBuild);
        if (chosen.result !== "SUCCESS") throw new CatalogError("UNAVAILABLE", `Purpur ${version} build ${build} did not build successfully (${chosen.result})`);
      }
      const mojangMajor = await mojangJavaMajor(ctx, version);
      const java = requiredJavaMajor({ software: "purpur", version, mojangMajor });
      const md5 = chosen.md5 ? chosen.md5.toLowerCase() : null;
      const artifact: ResolvedArtifact = {
        software: "purpur",
        version,
        build: chosen.build,
        channel: channelOf(chosen),
        releasedAt: chosen.timestamp ?? null,
        downloads: [
          {
            role: "server",
            url: downloadUrl(version, chosen.build),
            destPath: "server.jar",
            checksum: md5 ? { algorithm: "md5", value: md5 } : null,
            agentChecksum: null,
            sizeBytes: null,
            provenance: md5
              ? "PurpurMC API v2; upstream publishes MD5 only, which the agent cannot verify (HTTPS transport integrity only)"
              : "PurpurMC API v2; no checksum published (HTTPS transport integrity only)",
          },
        ],
        java: { major: java.major, source: java.source, notes: java.notes },
        install: { kind: "none" },
        launch: { kind: "jar", jar: "server.jar", programArgs: ["--nogui"] },
        requiresNetworkAtFirstStart: true,
        recommendedJvmFlags: null,
        provenance: "PurpurMC API v2",
        notes,
      };
      return artifact;
    },
  };
}
