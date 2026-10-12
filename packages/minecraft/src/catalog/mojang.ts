import { z } from "zod";
import type { SoftwareBuild, SoftwareInfo } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { type CatalogContext, assertHttpsUrl, getJson, getText, parseJson } from "../http.js";
import { javaMajorFromTable, requiredJavaMajor } from "../java.js";
import { isAtLeast, parseMinecraftVersion } from "../versions.js";
import { type CatalogVersion, type ResolvedArtifact, type SoftwareAdapter, toAgentChecksum } from "./types.js";

/**
 * Mojang launcher metadata (verified 2026-10-11):
 *  - manifest https://piston-meta.mojang.com/mc/game/version_manifest_v2.json lists every version
 *    with `type` (release | snapshot | old_beta | old_alpha), `url` and the SHA-1 of the
 *    per-version JSON;
 *  - per-version JSON carries `downloads.server {url, sha1, size}` and
 *    `javaVersion.majorVersion` (absent for 1.6.x);
 *  - releases 1.0–1.2.4 and all 61 old_alpha/old_beta ids have no server download.
 */
export const MOJANG_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

const ManifestSchema = z.object({
  latest: z.object({ release: z.string(), snapshot: z.string() }),
  versions: z.array(
    z.object({
      id: z.string().min(1).max(64),
      type: z.string(),
      url: z.string(),
      time: z.string(),
      releaseTime: z.string(),
      sha1: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    }),
  ),
});
export type MojangManifest = z.infer<typeof ManifestSchema>;

const DownloadSchema = z.object({ sha1: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().nonnegative(), url: z.string() });
const VersionSchema = z.object({
  id: z.string(),
  type: z.string(),
  releaseTime: z.string(),
  javaVersion: z.object({ majorVersion: z.number().int().min(5).max(99), component: z.string().optional() }).optional(),
  downloads: z.record(z.string(), DownloadSchema).default({}),
});
export type MojangVersion = z.infer<typeof VersionSchema>;

export async function getMojangManifest(ctx: CatalogContext): Promise<MojangManifest> {
  return getJson(ctx, MOJANG_MANIFEST_URL, ManifestSchema);
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Per-version metadata; the JSON is verified against the SHA-1 listed in the manifest. */
export async function getMojangVersion(ctx: CatalogContext, id: string): Promise<MojangVersion> {
  const manifest = await getMojangManifest(ctx);
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new CatalogError("NOT_FOUND", `unknown Minecraft version: ${id}`);
  assertHttpsUrl(entry.url);
  const text = await getText(ctx, entry.url);
  if (entry.sha1) {
    const actual = await sha1Hex(text);
    if (actual !== entry.sha1) {
      throw new CatalogError("INVALID_UPSTREAM_RESPONSE", `version JSON for ${id} does not match manifest SHA-1`, { url: entry.url });
    }
  }
  return parseJson(text, VersionSchema, entry.url);
}

/** Mojang's Java requirement for a game version, or null when unknown/unavailable. */
export async function mojangJavaMajor(ctx: CatalogContext, id: string): Promise<number | null> {
  try {
    return (await getMojangVersion(ctx, id)).javaVersion?.majorVersion ?? null;
  } catch (e) {
    if (e instanceof CatalogError) return null;
    throw e;
  }
}

export function mapMojangType(type: string): CatalogVersion["channel"] {
  switch (type) {
    case "release":
      return "release";
    case "old_beta":
      return "beta";
    case "old_alpha":
      return "alpha";
    default:
      return "snapshot";
  }
}

function hasNoServerDownloadByPolicy(id: string, type: string): boolean {
  if (type.startsWith("old_")) return true;
  return type === "release" && isAtLeast(id, "1.2.5") === false;
}

export const VANILLA_INFO: SoftwareInfo = {
  software: "vanilla",
  displayName: "Vanilla",
  kind: "game",
  description: "The official Minecraft: Java Edition server published by Mojang.",
  supportsPlugins: false,
  supportsMods: false,
  restrictions: [
    "No plugin or mod loader: plugins (Bukkit/Paper) and mods (Fabric/Forge) cannot be installed.",
    "Cannot validate Velocity player-info forwarding; behind a proxy it only works with forwarding disabled and online-mode=false, which is unsafe unless the backend is unreachable except through the proxy.",
    "Releases before 1.2.5 and pre-release historic versions (alpha/beta) have no server download.",
  ],
  source: "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
};

export function createVanillaAdapter(): SoftwareAdapter {
  return {
    info: VANILLA_INFO,

    async listVersions(ctx) {
      const manifest = await getMojangManifest(ctx);
      return manifest.versions
        .filter((v) => !hasNoServerDownloadByPolicy(v.id, v.type))
        .map((v): CatalogVersion => {
          const releaseLike = parseMinecraftVersion(v.id).kind === "release-like";
          return {
            minecraftVersion: v.id,
            channel: mapMojangType(v.type),
            javaMajor: releaseLike ? javaMajorFromTable("vanilla", v.id) : null,
            javaSource: releaseLike ? "table" : null,
            releasedAt: Number.isFinite(Date.parse(v.releaseTime)) ? Date.parse(v.releaseTime) : null,
            support: null,
            notes: [],
          };
        });
    },

    async listBuilds(ctx, version) {
      const v = await getMojangVersion(ctx, version);
      const server = v.downloads["server"];
      if (!server) return [];
      const build: SoftwareBuild = {
        build: v.id,
        channel: v.type === "release" ? "stable" : "experimental",
        downloadUrl: server.url,
        checksum: { algorithm: "sha1", value: server.sha1 },
        releasedAt: Number.isFinite(Date.parse(v.releaseTime)) ? Date.parse(v.releaseTime) : null,
        provenance: "Mojang piston-meta per-version metadata (downloads.server, SHA-1)",
        notes: [],
      };
      return [build];
    },

    async resolve(ctx, version, build) {
      if (build !== null && build !== version) {
        throw new CatalogError("NOT_FOUND", `vanilla has exactly one build per version (requested ${build} for ${version})`);
      }
      const v = await getMojangVersion(ctx, version);
      const server = v.downloads["server"];
      if (!server) {
        throw new CatalogError("UNAVAILABLE", `Mojang publishes no server download for ${version}`);
      }
      assertHttpsUrl(server.url);
      const java = requiredJavaMajor({ software: "vanilla", version, mojangMajor: v.javaVersion?.majorVersion ?? null });
      const checksum = { algorithm: "sha1" as const, value: server.sha1 };
      const artifact: ResolvedArtifact = {
        software: "vanilla",
        version: v.id,
        build: v.id,
        channel: v.type === "release" ? "stable" : "experimental",
        releasedAt: Number.isFinite(Date.parse(v.releaseTime)) ? Date.parse(v.releaseTime) : null,
        downloads: [
          {
            role: "server",
            url: server.url,
            destPath: "server.jar",
            checksum,
            agentChecksum: toAgentChecksum(checksum),
            sizeBytes: server.size,
            provenance: "Mojang piston-meta: manifest → per-version JSON (SHA-1 verified) → downloads.server SHA-1",
          },
        ],
        java: { major: java.major, source: java.source, notes: java.notes },
        install: { kind: "none" },
        launch: { kind: "jar", jar: "server.jar", programArgs: ["nogui"] },
        requiresNetworkAtFirstStart: false,
        recommendedJvmFlags: null,
        provenance: "Official Mojang server jar",
        notes: v.type === "release" ? [] : [`${v.id} is a ${v.type}, not a release; worlds may not be downgradable.`],
      };
      return artifact;
    },
  };
}
