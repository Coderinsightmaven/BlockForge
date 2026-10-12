import type {
  ExtensionCompatibility as ContractCompatibility,
  ExtensionMetadataView as ContractMetadataView,
  ExtensionUpdateStatus as ContractUpdateStatus,
  ModrinthInstallPlan as ContractInstallPlan,
  ModrinthPlanRequest as ContractPlanRequest,
  ModrinthPlannedFile as ContractPlannedFile,
  ModrinthProjectDetails as ContractProjectDetails,
  ModrinthRef as ContractModrinthRef,
  ModrinthSearchHit as ContractSearchHit,
  ModrinthSearchQuery as ContractSearchQuery,
  ModrinthSearchResult as ContractSearchResult,
  ModrinthVersionSummary as ContractVersionSummary,
  PlanWarning as ContractPlanWarning,
  PlayerActionKind,
  PlayerActionResult as ContractPlayerActionResult,
  PlayerLookupResponse as ContractPlayerLookup,
  PlayersOverview as ContractPlayersOverview,
  ServerSoftware,
} from "@blockforge/contracts";
import { jarCompatibility, type ExtensionMetadata, type ParsedJarMetadata } from "./extensions/metadata.js";
import type { selectExtensionFiles } from "./extensions/scan.js";
import { loaderMatch, modrinthLoaderProfile } from "./modrinth/loaders.js";
import type { InstalledExtensionRef, ModrinthFileIdentity, ModrinthInstallPlan, ModrinthInstallRequest, ModrinthPlannedFile, ModrinthUpdateStatus, ModrinthVersionSummary, PlanWarning } from "./modrinth/plan.js";
import type { ModrinthProjectDetails, ModrinthSearchHit, ModrinthSearchQuery, ModrinthSearchResult } from "./modrinth/search.js";
import type { CommandFeedback, PlayerListOutput } from "./players/commands.js";
import { PLAYER_LIST_FILES, isBanActive, parseBanDate, type PlayerListDocument } from "./players/lists.js";
import type { PlayerProfile } from "./players/mojang.js";
import { isValidPlayerName, normalizeUuid } from "./players/uuid.js";

/**
 * Converters from the library's DTOs to the `@blockforge/contracts` API schemas (Phase 4b). The
 * contract chose a few different representations — epoch-ms timestamps instead of Modrinth date
 * strings, closed version-type enums, no checksum on planned files (always SHA-512), length caps,
 * control-plane fields such as `installed` / `restartRequired` / `extensionId` — and these
 * functions apply exactly those mappings so the control plane never parses strings. Each output is
 * covered by a test that parses it with the contract zod schema.
 */

// --- primitives -------------------------------------------------------------------------------

/** Cuts to `max` UTF-16 code units without leaving a lone high surrogate. */
function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  const t = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t;
}
const capN = (s: string | null | undefined, max: number): string | null => (s === null || s === undefined ? null : cap(s, max));
const capList = (a: readonly string[], items: number, max: number): string[] => a.slice(0, items).map((x) => cap(x, max));

/** Epoch ms of an upstream date string; null when unparsable or before 1970. */
export function epochMsOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isFinite(t) && t >= 0 ? Math.trunc(t) : null;
}

/** Whether a Modrinth version type is one the contract can express. */
export function isContractVersionType(type: string): type is "release" | "beta" | "alpha" {
  return type === "release" || type === "beta" || type === "alpha";
}

/**
 * A known version type, unchanged. Planned files and update targets only ever carry known types
 * (the planner refuses others), so an unknown one here is a bug and throws instead of being remapped.
 */
export function contractVersionType(type: string): "release" | "beta" | "alpha" {
  if (!isContractVersionType(type)) throw new TypeError(`unknown Modrinth version type "${type.slice(0, 32)}"`);
  return type;
}

const MODRINTH_ID = /^[A-Za-z0-9]{1,16}$/;
const idOrNull = (id: string | null | undefined): string | null => (id && MODRINTH_ID.test(id) ? id : null);

function httpsOrNull(url: string | null | undefined, host?: string): string | null {
  if (!url || url.length > 2048) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (host !== undefined && (u.host !== host || u.port !== "")) return null;
    return url;
  } catch {
    return null;
  }
}

// --- jar metadata and compatibility -----------------------------------------------------------

export function toContractExtensionMetadata(m: ExtensionMetadata): ContractMetadataView {
  return {
    format: m.format,
    id: cap(m.id, 128),
    name: cap(m.name, 128),
    version: capN(m.version, 256),
    description: capN(m.description, 1024),
    authors: capList(m.authors, 32, 128),
    environment: m.environment,
    dependencies: m.dependencies.slice(0, 128).map((d) => ({ id: cap(d.id, 128), kind: d.kind, versionRange: capN(d.versionRange, 1024), side: d.side })),
    minecraftVersion: capN(m.minecraftVersion, 1024),
    loaderVersion: capN(m.loaderVersion, 1024),
    foliaSupported: m.foliaSupported,
    entrypoint: capN(m.entrypoint, 512),
    libraries: capList(m.libraries, 64, 256),
    bundledJars: capList(m.bundledJars, 64, 512),
    license: capN(m.license, 256),
    homepage: httpsOrNull(m.homepage),
    warnings: capList(m.warnings, 32, 512),
  };
}

/**
 * `InstalledExtension.metadata` + `.compatibility` for a parsed jar: metadata capped at 32 entries
 * (the index of the selected entry stays valid; it becomes null if it fell beyond the cap).
 */
export function toContractJarInfo(parsed: ParsedJarMetadata, software: ServerSoftware): { metadata: ContractMetadataView[]; compatibility: ContractCompatibility } {
  const compatibility = jarCompatibility(parsed, software);
  const metadata = parsed.extensions.slice(0, 32).map(toContractExtensionMetadata);
  const metadataIndex = compatibility.metadataIndex !== null && compatibility.metadataIndex < metadata.length ? compatibility.metadataIndex : null;
  return { metadata, compatibility: { ...compatibility, metadataIndex } };
}

/** `ExtensionList.skipped`: jar-like entries only (non-jar files are not listed). */
export function toContractSkippedEntries(skipped: ReturnType<typeof selectExtensionFiles>["skipped"]) {
  return skipped
    .filter((s): s is typeof s & { reason: Exclude<typeof s.reason, "not-a-jar"> } => s.reason !== "not-a-jar")
    .slice(0, 256)
    .map((s) => ({ name: cap(s.name, 255), reason: s.reason }));
}

// --- Modrinth ---------------------------------------------------------------------------------

export function toContractSearchHit(hit: ModrinthSearchHit, installed: boolean): ContractSearchHit {
  return {
    projectId: hit.projectId,
    slug: capN(hit.slug, 64),
    title: cap(hit.title, 256),
    description: cap(hit.description, 2048),
    author: cap(hit.author, 128),
    loaders: capList(hit.loaders, 64, 64),
    categories: capList(hit.categories, 64, 64),
    projectTypes: capList(hit.projectTypes, 16, 32),
    downloads: hit.downloads,
    follows: hit.follows,
    iconUrl: httpsOrNull(hit.iconUrl, "cdn.modrinth.com"),
    license: cap(hit.license, 128),
    clientSide: hit.clientSide,
    serverSide: hit.serverSide,
    clientOnly: hit.clientOnly,
    loaderMatch: hit.loaderMatch,
    dateModified: epochMsOf(hit.dateModified),
    latestVersionId: idOrNull(hit.latestVersionId),
    installed,
  };
}

/** `installedProjectIds`: projects an installed extension of the server is identified as. */
export function toContractSearchResult(res: ModrinthSearchResult, installedProjectIds: ReadonlySet<string>): ContractSearchResult {
  return {
    hits: res.hits.slice(0, 50).map((h) => toContractSearchHit(h, installedProjectIds.has(h.projectId))),
    offset: res.offset,
    limit: res.limit,
    totalHits: res.totalHits,
    filteredOut: res.filteredOut,
  };
}

/** API search query → library query (software and Minecraft version come from the server). */
export function fromContractSearchQuery(q: ContractSearchQuery, target: { software: ServerSoftware; minecraftVersion: string | null }): ModrinthSearchQuery {
  return {
    software: target.software,
    minecraftVersion: target.minecraftVersion,
    ...(q.query === undefined ? {} : { query: q.query }),
    ...(q.categories === undefined ? {} : { categories: q.categories }),
    sort: q.sort,
    offset: q.offset,
    limit: q.limit,
  };
}

/** `compatible` is recomputed for `software` when the library result was fetched without it. */
export function toContractProjectDetails(p: ModrinthProjectDetails, software: ServerSoftware): ContractProjectDetails {
  const profile = modrinthLoaderProfile(software);
  return {
    projectId: p.projectId,
    slug: cap(p.slug, 64),
    title: cap(p.title, 256),
    description: cap(p.description, 2048),
    projectType: cap(p.projectType, 32),
    loaders: capList(p.loaders, 64, 64),
    categories: capList(p.categories, 64, 64),
    gameVersions: capList(p.gameVersions, 4096, 64),
    clientSide: p.clientSide,
    serverSide: p.serverSide,
    clientOnly: p.clientOnly,
    status: cap(p.status, 32),
    license: p.license ? { id: cap(p.license.id, 128), name: cap(p.license.name, 256), url: httpsOrNull(p.license.url) } : null,
    downloads: p.downloads,
    followers: p.followers,
    iconUrl: httpsOrNull(p.iconUrl, "cdn.modrinth.com"),
    sourceUrl: httpsOrNull(p.sourceUrl),
    issuesUrl: httpsOrNull(p.issuesUrl),
    wikiUrl: httpsOrNull(p.wikiUrl),
    pageUrl: p.pageUrl,
    published: epochMsOf(p.published),
    updated: epochMsOf(p.updated),
    compatible: p.compatible ?? (profile !== null && loaderMatch(profile, p.loaders) !== "none"),
  };
}

/**
 * Version summary for the contract. `listCompatibleVersions` only returns versions with a known
 * type; for other sources filter with `isContractVersionType` first — an unknown type (`snapshot`, …)
 * throws instead of being remapped.
 */
export function toContractVersionSummary(v: ModrinthVersionSummary): ContractVersionSummary {
  return {
    versionId: v.versionId,
    projectId: v.projectId,
    name: cap(v.name, 256),
    versionNumber: cap(v.versionNumber, 128),
    versionType: contractVersionType(v.versionType),
    status: capN(v.status, 32),
    datePublished: epochMsOf(v.datePublished),
    loaders: capList(v.loaders, 64, 64),
    gameVersions: capList(v.gameVersions, 4096, 64),
    loaderMatch: v.loaderMatch,
    gameVersionMatch: v.gameVersionMatch,
    dependencies: v.dependencies.slice(0, 256).map((d) => ({ type: d.type, projectId: idOrNull(d.projectId), versionId: idOrNull(d.versionId), fileName: capN(d.fileName, 256) })),
    primaryFile: v.primaryFile,
  };
}

/** `InstalledExtension.modrinth` from a hash identification (`identifyModrinthFiles`). */
export function toContractModrinthRef(id: ModrinthFileIdentity): ContractModrinthRef {
  return {
    projectId: id.projectId,
    slug: capN(id.slug, 64),
    title: capN(id.title, 256),
    versionId: id.versionId,
    versionNumber: cap(id.versionNumber, 128),
    // The contract defines this one mapping: unknown upstream types of an installed file → `alpha`.
    versionType: isContractVersionType(id.versionType) ? id.versionType : "alpha",
    iconUrl: httpsOrNull(id.iconUrl, "cdn.modrinth.com"),
    pageUrl: `https://modrinth.com/project/${encodeURIComponent(id.slug ?? id.projectId)}`,
  };
}

/** Planned file without the checksum field (always SHA-512 = `sha512`). */
export function toContractPlannedFile(f: ModrinthPlannedFile): ContractPlannedFile {
  return {
    action: f.action,
    reason: f.reason,
    requiredBy: f.requiredBy.slice(0, 128),
    projectId: f.projectId,
    projectSlug: capN(f.projectSlug, 64),
    projectTitle: capN(f.projectTitle, 256),
    versionId: f.versionId,
    versionNumber: cap(f.versionNumber, 128),
    versionType: contractVersionType(f.versionType),
    loaders: capList(f.loaders, 64, 64),
    filename: f.filename,
    url: f.url,
    sizeBytes: f.sizeBytes,
    sha1: f.sha1,
    sha512: f.sha512,
    destPath: f.destPath,
    replaces: f.replaces.slice(0, 16),
  };
}

export function toContractPlanWarning(w: PlanWarning): ContractPlanWarning {
  return { code: w.code, level: w.level, message: cap(w.message, 1024), projectId: idOrNull(w.projectId), versionId: idOrNull(w.versionId) };
}

export const MAX_CONTRACT_PLAN_WARNINGS = 512;

/**
 * Plan warnings for the contract (≤ 512): errors first, then warnings, then infos (stable within a
 * level), so the reasons for `installable: false` always survive the cap; when anything is cut, the
 * last slot says how many were omitted.
 */
export function contractPlanWarnings(warnings: readonly PlanWarning[]): ContractPlanWarning[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const sorted = warnings.map((w, i) => ({ w, i })).sort((a, b) => rank[a.w.level] - rank[b.w.level] || a.i - b.i).map((x) => x.w);
  if (sorted.length <= MAX_CONTRACT_PLAN_WARNINGS) return sorted.map(toContractPlanWarning);
  const kept = sorted.slice(0, MAX_CONTRACT_PLAN_WARNINGS - 1).map(toContractPlanWarning);
  const omitted = sorted.length - kept.length;
  kept.push({ code: "DEPENDENCY_LIMIT", level: "info", message: `${omitted} more notes were omitted`, projectId: null, versionId: null });
  return kept;
}

/** `restartRequired`: the server is not stopped (files take effect at the next start). */
export function toContractInstallPlan(plan: ModrinthInstallPlan, opts: { restartRequired: boolean }): ContractInstallPlan {
  return {
    software: plan.software,
    minecraftVersion: capN(plan.minecraftVersion, 64),
    installDir: plan.installDir,
    root: { projectId: plan.root.projectId, slug: cap(plan.root.slug, 64), title: cap(plan.root.title, 256), versionId: plan.root.versionId, versionNumber: cap(plan.root.versionNumber, 128) },
    files: plan.files.slice(0, 128).map(toContractPlannedFile),
    alreadyInstalled: plan.alreadyInstalled.slice(0, 128),
    optionalDependencies: plan.optionalDependencies.slice(0, 128).map((o) => ({ projectId: o.projectId, versionId: o.versionId, slug: capN(o.slug, 64), title: capN(o.title, 256), requiredBy: o.requiredBy })),
    warnings: contractPlanWarnings(plan.warnings),
    installable: plan.installable,
    restartRequired: opts.restartRequired,
  };
}

/**
 * API plan/install request → library request. The API defaults `allowPrerelease` to false (the
 * library defaults to true), so it is always passed explicitly.
 */
export function fromContractPlanRequest(
  req: ContractPlanRequest,
  target: { software: ServerSoftware; minecraftVersion: string | null; installed: readonly InstalledExtensionRef[] },
): ModrinthInstallRequest {
  return {
    software: target.software,
    minecraftVersion: target.minecraftVersion,
    installed: target.installed,
    project: req.project,
    versionId: req.versionId ?? null,
    includeOptional: req.includeOptional,
    allowPrerelease: req.allowPrerelease,
    allowIncompatibleVersion: req.allowIncompatibleVersion,
  };
}

export function toContractUpdateStatus(s: ModrinthUpdateStatus, extensionId: string): ContractUpdateStatus {
  return {
    extensionId,
    path: s.path,
    current: s.current ? { projectId: s.current.projectId, versionId: s.current.versionId, versionNumber: cap(s.current.versionNumber, 128), datePublished: epochMsOf(s.current.datePublished) } : null,
    latest: s.latest
      ? {
          projectId: s.latest.projectId,
          versionId: s.latest.versionId,
          versionNumber: cap(s.latest.versionNumber, 128),
          versionType: contractVersionType(s.latest.versionType),
          datePublished: epochMsOf(s.latest.datePublished),
        }
      : null,
    updateAvailable: s.updateAvailable,
    file: s.file ? toContractPlannedFile(s.file) : null,
    problem: s.problem,
  };
}

// --- players ----------------------------------------------------------------------------------

export const MAX_CONTRACT_PLAYER_LIST_ENTRIES = 10_000;

export interface PlayersOverviewInput {
  /** `list` output (complete), an SLP sample (possibly partial), or null when unknown. */
  online:
    | { source: "list"; output: PlayerListOutput; at: number }
    | { source: "slp"; count: number | null; max: number | null; sample: ReadonlyArray<{ name: string; uuid?: string | null }>; at: number }
    | null;
  onlineMode: boolean | null;
  whitelistEnabled: boolean | null;
  whitelistEnforced: boolean | null;
  lists: {
    whitelist?: PlayerListDocument<"whitelist"> | null;
    ops?: PlayerListDocument<"ops"> | null;
    bannedPlayers?: PlayerListDocument<"banned-players"> | null;
    bannedIps?: PlayerListDocument<"banned-ips"> | null;
  };
  /** Files that could not be read at all (missing files are just empty lists). */
  fileErrors?: ReadonlyArray<{ file: "whitelist.json" | "ops.json" | "banned-players.json" | "banned-ips.json" | "server.properties"; message: string }>;
  availableActions: PlayerActionKind[];
  now: Date;
}

/**
 * Builds the contract `PlayersOverview`: ban dates become epoch ms (`forever` / unparsable expiry →
 * null, like the server), `active` is computed for `now`, op levels outside 0–4 are clamped and
 * reported, invalid entries (`issues`) become `listErrors`, lists are cut at 10 000 entries.
 */
export function toContractPlayersOverview(input: PlayersOverviewInput): ContractPlayersOverview {
  type ListError = ContractPlayersOverview["listErrors"][number];
  // Collected in priority order (unreadable files, then values BlockForge changed for display,
  // then per-entry notes) and cut to 64 at the end with a summary, so no class is silently lost.
  const fileErrs: ListError[] = (input.fileErrors ?? []).map((e) => ({ file: e.file, message: cap(e.message, 512) }));
  const clampErrs: ListError[] = [];
  const entryErrs: ListError[] = [];
  const truncated: ContractPlayersOverview["truncated"] = [];
  const err = (file: ListError["file"], message: string) => entryErrs.push({ file, message: cap(message, 512) });
  const take = <T>(kind: ContractPlayersOverview["truncated"][number], items: readonly T[]): T[] => {
    if (items.length > MAX_CONTRACT_PLAYER_LIST_ENTRIES) truncated.push(kind);
    return items.slice(0, MAX_CONTRACT_PLAYER_LIST_ENTRIES);
  };
  const { whitelist, ops, bannedPlayers, bannedIps } = input.lists;
  if (whitelist) for (const i of whitelist.issues) err(PLAYER_LIST_FILES.whitelist as "whitelist.json", i);
  if (ops) for (const i of ops.issues) err("ops.json", i);
  if (bannedPlayers) for (const i of bannedPlayers.issues) err("banned-players.json", i);
  if (bannedIps) for (const i of bannedIps.issues) err("banned-ips.json", i);

  const ban = (b: { created: string; source: string; expires: string; reason: string | null }) => {
    const created = parseBanDate(b.created);
    const expires = b.expires === "forever" ? null : parseBanDate(b.expires);
    const ms = (d: Date | null) => (d && d.getTime() >= 0 ? d.getTime() : null);
    return { createdAt: ms(created), source: cap(b.source, 256), expiresAt: ms(expires), reason: capN(b.reason, 256), active: isBanActive(b, input.now) };
  };

  let online: ContractPlayersOverview["online"] = { count: null, max: null, players: [], skipped: 0, source: null, at: null };
  if (input.online?.source === "list") {
    const o = input.online.output;
    online = { count: o.online, max: o.max, players: o.players.slice(0, 1000), skipped: o.skipped + Math.max(0, o.players.length - 1000), source: "list", at: input.online.at };
  } else if (input.online?.source === "slp") {
    const valid = input.online.sample.filter((p) => isValidPlayerName(p.name));
    online = {
      count: input.online.count,
      max: input.online.max,
      players: valid.slice(0, 1000).map((p) => ({ name: p.name, uuid: p.uuid ? normalizeUuid(p.uuid) : null })),
      skipped: input.online.sample.length - valid.length,
      source: "slp",
      at: input.online.at,
    };
  }

  const overview: ContractPlayersOverview = {
    online,
    onlineMode: input.onlineMode,
    whitelist: {
      enabled: input.whitelistEnabled,
      enforced: input.whitelistEnforced,
      entries: take("whitelist", whitelist?.entries ?? []).map((e) => ({ uuid: e.uuid, name: cap(e.name, 64) })),
    },
    ops: take("ops", ops?.entries ?? []).map((e) => {
      const level = Math.min(4, Math.max(0, e.level));
      if (level !== e.level) clampErrs.push({ file: "ops.json", message: cap(`operator ${cap(e.name, 64)} has level ${e.level}; the server only knows 0–4`, 512) });
      return { uuid: e.uuid, name: cap(e.name, 64), level, bypassesPlayerLimit: e.bypassesPlayerLimit };
    }),
    bannedPlayers: take("bannedPlayers", bannedPlayers?.entries ?? []).map((e) => ({ uuid: e.uuid, name: cap(e.name, 64), ...ban(e) })),
    bannedIps: take("bannedIps", bannedIps?.entries ?? []).map((e) => ({ ip: cap(e.ip, 64), ...ban(e) })),
    truncated,
    listErrors: [],
    availableActions: input.availableActions,
  };
  const all = [...fileErrs, ...clampErrs, ...entryErrs];
  if (all.length <= 64) overview.listErrors = all;
  else {
    const kept = all.slice(0, 63);
    const files = [...new Set(all.slice(63).map((e) => e.file))].join(", ");
    kept.push({ file: all[63]!.file, message: `${all.length - 63} more problems in ${files}` });
    overview.listErrors = kept;
  }
  return overview;
}

/** `PlayerActionResult.feedback` of the console path. */
export function toContractPlayerFeedback(fb: CommandFeedback): NonNullable<ContractPlayerActionResult["feedback"]> {
  return { ok: fb.ok, message: cap(fb.message, 1024) };
}

export function toContractPlayerLookup(p: PlayerProfile): ContractPlayerLookup {
  return { name: p.name, uuid: p.uuid, source: p.source };
}
