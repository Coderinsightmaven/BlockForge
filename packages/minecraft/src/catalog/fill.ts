import { z } from "zod";
import type { SoftwareBuild, SoftwareInfo } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { type CatalogContext, assertArtifactUrl, getJson } from "../http.js";
import { requiredJavaMajor } from "../java.js";
import { compareMinecraftVersions, compareSemverLike, parseMinecraftVersion } from "../versions.js";
import { mojangJavaMajor } from "./mojang.js";
import { type CatalogVersion, type ResolvedArtifact, type SoftwareAdapter, safeSegment, toAgentChecksum } from "./types.js";

/**
 * PaperMC "Fill" API v3 — https://fill.papermc.io/v3 (OpenAPI at /openapi.yaml, "PaperMC Fill
 * 3.0.0"). Verified 2026-10-11:
 *  - the v2 API (api.papermc.io/v2) answers `410 Gone` with `sunset: Wed, 1 Jul 2026`;
 *  - GET /v3/projects/{p}/versions → `{versions: [{version: {id, support: {status, end?},
 *    java: {version: {minimum}, flags: {recommended: []}}}, builds: number[]}]}` (the OpenAPI
 *    document claims a bare array — both shapes are accepted);
 *  - GET /v3/projects/{p}/versions/{v}/builds → array of builds, newest first;
 *  - build: `{id, time, channel: ALPHA|BETA|STABLE|RECOMMENDED, commits, downloads:
 *    {"server:default": {name, checksums: {sha256}, size, url}}}`;
 *  - download URLs live on https://fill-data.papermc.io/v1/objects/<sha256>/<name>.
 */
export const FILL_BASE = "https://fill.papermc.io/v3/projects";

const FillChannel = z.enum(["ALPHA", "BETA", "STABLE", "RECOMMENDED"]);
const FillDownload = z.object({
  name: z.string(),
  checksums: z.object({ sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }),
  size: z.number().int().nonnegative().nullable().optional(),
  url: z.string(),
});
const FillBuild = z.object({
  id: z.number().int().nonnegative(),
  time: z.string(),
  channel: FillChannel,
  commits: z.array(z.object({ sha: z.string(), time: z.string().optional(), message: z.string() })).default([]),
  downloads: z.record(z.string(), FillDownload),
});
export type FillBuild = z.infer<typeof FillBuild>;
const FillVersion = z.object({
  version: z.object({
    id: z.string(),
    support: z.object({ status: z.enum(["SUPPORTED", "DEPRECATED", "UNSUPPORTED"]), end: z.string().nullable().optional() }),
    java: z
      .object({
        version: z.object({ minimum: z.number().int() }),
        flags: z.object({ recommended: z.array(z.string()) }).optional(),
      })
      .optional(),
  }),
  builds: z.array(z.number().int()),
});
export type FillVersion = z.infer<typeof FillVersion>;
const FillVersions = z.union([z.object({ versions: z.array(FillVersion) }).transform((x) => x.versions), z.array(FillVersion)]);

export type FillProject = "paper" | "folia" | "velocity";

export function mapFillChannel(c: z.infer<typeof FillChannel>): SoftwareBuild["channel"] {
  return c === "STABLE" || c === "RECOMMENDED" ? "stable" : c === "BETA" ? "beta" : "alpha";
}

function versionChannel(project: FillProject, id: string): CatalogVersion["channel"] {
  if (project === "velocity") return /-SNAPSHOT$/i.test(id) ? "snapshot" : "release";
  const p = parseMinecraftVersion(id);
  return p.kind === "release-like" && p.stage === "release" ? "release" : "snapshot";
}

function compareFor(project: FillProject) {
  return project === "velocity" ? compareSemverLike : compareMinecraftVersions;
}

const SERVER_DOWNLOAD = "server:default";

export async function getFillVersions(ctx: CatalogContext, project: FillProject): Promise<FillVersion[]> {
  return getJson(ctx, `${FILL_BASE}/${project}/versions`, FillVersions);
}

export async function getFillVersion(ctx: CatalogContext, project: FillProject, version: string): Promise<FillVersion> {
  return getJson(ctx, `${FILL_BASE}/${project}/versions/${safeSegment("version", version)}`, FillVersion);
}

export async function getFillBuilds(ctx: CatalogContext, project: FillProject, version: string): Promise<FillBuild[]> {
  const builds = await getJson(ctx, `${FILL_BASE}/${project}/versions/${safeSegment("version", version)}/builds`, z.array(FillBuild));
  return [...builds].sort((a, b) => b.id - a.id);
}

export async function getFillBuild(ctx: CatalogContext, project: FillProject, version: string, build: string): Promise<FillBuild> {
  if (!/^\d{1,9}$/.test(build)) throw new CatalogError("INVALID_ARGUMENT", `invalid build number: ${build}`);
  return getJson(ctx, `${FILL_BASE}/${project}/versions/${safeSegment("version", version)}/builds/${build}`, FillBuild);
}

function commitNotes(b: FillBuild): string[] {
  return b.commits.slice(0, 5).map((c) => (c.message.split("\n")[0] ?? "").slice(0, 200));
}

export function fillBuildToSoftwareBuild(project: FillProject, b: FillBuild, ctx: Pick<CatalogContext, "artifactHosts"> = {}): SoftwareBuild | null {
  const d = b.downloads[SERVER_DOWNLOAD];
  if (!d) return null;
  assertArtifactUrl(ctx, d.url);
  return {
    build: String(b.id),
    channel: mapFillChannel(b.channel),
    downloadUrl: d.url,
    checksum: { algorithm: "sha256", value: d.checksums.sha256.toLowerCase() },
    releasedAt: Number.isFinite(Date.parse(b.time)) ? Date.parse(b.time) : null,
    provenance: `PaperMC Fill API v3 (${project}), SHA-256 published by PaperMC`,
    notes: commitNotes(b),
  };
}

/** Newest STABLE/RECOMMENDED build, else newest build of any channel (with a note). */
export function pickDefaultFillBuild(builds: FillBuild[]): { build: FillBuild; note: string | null } | null {
  const sorted = [...builds].filter((b) => b.downloads[SERVER_DOWNLOAD]).sort((a, b) => b.id - a.id);
  const stable = sorted.find((b) => b.channel === "STABLE" || b.channel === "RECOMMENDED");
  if (stable) return { build: stable, note: null };
  const first = sorted[0];
  if (!first) return null;
  return { build: first, note: `No stable build exists for this version; using the newest ${first.channel.toLowerCase()} build #${first.id}.` };
}

const PAPER_RESTRICTIONS = [
  "Runs Bukkit/Spigot/Paper plugins only; Fabric, Forge and NeoForge mods are not supported.",
  "Changes some vanilla behaviour (fixes and performance changes); a few technical/redstone mechanics differ from vanilla.",
  "Builds for pre-releases/release candidates and early builds of new Minecraft versions are published as alpha/beta.",
  "Downloads the vanilla server jar from Mojang on first start (Paperclip), so the container needs outbound HTTPS once.",
];

export const PAPER_INFO: SoftwareInfo = {
  software: "paper",
  displayName: "Paper",
  kind: "game",
  description: "High-performance Minecraft server with the Bukkit/Spigot/Paper plugin API, maintained by PaperMC.",
  supportsPlugins: true,
  supportsMods: false,
  restrictions: PAPER_RESTRICTIONS,
  source: "https://fill.papermc.io/v3/projects/paper",
};

export const FOLIA_INFO: SoftwareInfo = {
  software: "folia",
  displayName: "Folia",
  kind: "game",
  description: "PaperMC fork with regionised multithreading for very large player counts.",
  supportsPlugins: true,
  supportsMods: false,
  restrictions: [
    "Most Paper/Bukkit plugins are incompatible: Folia only loads plugins that declare `folia-supported: true` in plugin.yml (Folia README).",
    "There is no main thread; plugins must use region/entity schedulers.",
    "Recommended for machines with many cores (Folia README: ideally at least 16 cores) and pre-generated worlds; not a drop-in replacement for Paper.",
    "Only a subset of Minecraft versions is published and builds are usually marked beta.",
    "Downloads the vanilla server jar from Mojang on first start (Paperclip), so the container needs outbound HTTPS once.",
  ],
  source: "https://fill.papermc.io/v3/projects/folia",
};

export const VELOCITY_INFO: SoftwareInfo = {
  software: "velocity",
  displayName: "Velocity",
  kind: "proxy",
  description: "Modern, secure Minecraft proxy by PaperMC for linking multiple backend servers.",
  supportsPlugins: true,
  supportsMods: false,
  restrictions: [
    "Proxy only: it does not run worlds; it needs at least one backend server.",
    "Runs Velocity plugins only (not Bukkit or BungeeCord plugins).",
    "The version list is Velocity's own versioning, not Minecraft versions; each Velocity release supports a range of client versions.",
    "Modern player-info forwarding requires Minecraft 1.13+ backends with a compatible implementation (see the forwarding compatibility matrix).",
  ],
  source: "https://fill.papermc.io/v3/projects/velocity",
};

export function createFillAdapter(project: FillProject): SoftwareAdapter {
  const info = project === "paper" ? PAPER_INFO : project === "folia" ? FOLIA_INFO : VELOCITY_INFO;
  const cmp = compareFor(project);
  return {
    info,

    async listVersions(ctx) {
      const versions = await getFillVersions(ctx, project);
      return versions
        .filter((v) => v.builds.length > 0)
        .map(
          (v): CatalogVersion => ({
            minecraftVersion: v.version.id,
            channel: versionChannel(project, v.version.id),
            javaMajor: v.version.java?.version.minimum ?? null,
            javaSource: v.version.java ? "upstream" : null,
            releasedAt: null,
            support: v.version.support.status.toLowerCase() as CatalogVersion["support"],
            notes: v.version.support.end ? [`PaperMC support ${v.version.support.status === "SUPPORTED" ? "ends" : "ended"} ${v.version.support.end}.`] : [],
          }),
        )
        .sort((a, b) => cmp(b.minecraftVersion, a.minecraftVersion));
    },

    async listBuilds(ctx, version) {
      const builds = await getFillBuilds(ctx, project, version);
      return builds.map((b) => fillBuildToSoftwareBuild(project, b, ctx)).filter((b): b is SoftwareBuild => b !== null);
    },

    async resolve(ctx, version, build) {
      const v = await getFillVersion(ctx, project, version);
      let chosen: FillBuild;
      const notes: string[] = [];
      if (build === null) {
        const pick = pickDefaultFillBuild(await getFillBuilds(ctx, project, version));
        if (!pick) throw new CatalogError("UNAVAILABLE", `${project} ${version} has no downloadable builds`);
        chosen = pick.build;
        if (pick.note) notes.push(pick.note);
      } else {
        chosen = await getFillBuild(ctx, project, version, build);
      }
      const d = chosen.downloads[SERVER_DOWNLOAD];
      if (!d) throw new CatalogError("UNAVAILABLE", `${project} ${version} build ${chosen.id} has no server download`);
      assertArtifactUrl(ctx, d.url);
      if (v.version.support.status !== "SUPPORTED") {
        notes.push(`PaperMC marks ${project} ${version} as ${v.version.support.status.toLowerCase()}${v.version.support.end ? ` (since ${v.version.support.end})` : ""}.`);
      }
      const mojangMajor = project === "velocity" ? null : await mojangJavaMajor(ctx, version);
      const java = requiredJavaMajor({ software: project, version, mojangMajor, upstreamMinimum: v.version.java?.version.minimum ?? null });
      const checksum = { algorithm: "sha256" as const, value: d.checksums.sha256.toLowerCase() };
      const jar = project === "velocity" ? "velocity.jar" : "server.jar";
      const artifact: ResolvedArtifact = {
        software: project,
        version: v.version.id,
        build: String(chosen.id),
        channel: mapFillChannel(chosen.channel),
        releasedAt: Number.isFinite(Date.parse(chosen.time)) ? Date.parse(chosen.time) : null,
        downloads: [
          {
            role: "server",
            url: d.url,
            destPath: jar,
            checksum,
            agentChecksum: toAgentChecksum(checksum),
            sizeBytes: d.size ?? null,
            provenance: `PaperMC Fill API v3: ${project} ${v.version.id} build #${chosen.id} (${chosen.channel}), SHA-256 published by PaperMC`,
          },
        ],
        java: { major: java.major, source: java.source, notes: java.notes },
        install: { kind: "none" },
        launch: { kind: "jar", jar, programArgs: project === "velocity" ? [] : ["--nogui"] },
        requiresNetworkAtFirstStart: project !== "velocity",
        recommendedJvmFlags: v.version.java?.flags?.recommended ?? null,
        provenance: `PaperMC ${info.displayName} via Fill API v3`,
        notes: [...notes, ...commitNotes(chosen).slice(0, 1).map((m) => `Latest change: ${m}`)],
      };
      return artifact;
    },
  };
}
