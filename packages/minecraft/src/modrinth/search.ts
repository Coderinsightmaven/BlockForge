import type { ServerSoftware } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { assertAllowedUrl } from "../http.js";
import type { ModrinthClient } from "./client.js";
import { isClientOnly, loaderMatch, modrinthLoaderProfile, sideSupport, type ModrinthLoaderProfile, type SideSupport } from "./loaders.js";
import type { ModrinthProjectRaw, ModrinthSearchHitRaw } from "./schemas.js";

export type ModrinthSort = "relevance" | "downloads" | "follows" | "newest" | "updated";

export interface ModrinthSearchQuery {
  software: ServerSoftware;
  /** Server Minecraft version (ignored for Velocity). */
  minecraftVersion?: string | null;
  /** Free text (≤ 256 characters, no control characters). */
  query?: string;
  /** Extra Modrinth category tags, all required (e.g. `["utility"]`). */
  categories?: readonly string[];
  sort?: ModrinthSort;
  /** 0–10 000. */
  offset?: number;
  /** 1–100, default 20. */
  limit?: number;
}

/** Proposed DTO: one search result. Text fields are untrusted upstream text (render as text). */
export interface ModrinthSearchHit {
  projectId: string;
  slug: string | null;
  title: string;
  description: string;
  author: string;
  /** Loader tags among the project's categories (paper, fabric, …). */
  loaders: string[];
  /** Non-loader categories (utility, optimization, …). */
  categories: string[];
  /** Modrinth project types (`mod`, `plugin`, `datapack`, …). */
  projectTypes: string[];
  downloads: number;
  follows: number;
  /** Only kept when hosted on the Modrinth CDN. */
  iconUrl: string | null;
  license: string;
  clientSide: SideSupport;
  serverSide: SideSupport;
  clientOnly: boolean;
  /** "warning" when the project only matches through a loader accepted with a warning (Quilt on Fabric). Hits with no matching loader are filtered out. */
  loaderMatch: "match" | "warning";
  dateModified: string;
  latestVersionId: string | null;
}

export interface ModrinthSearchResult {
  hits: ModrinthSearchHit[];
  offset: number;
  limit: number;
  /** Upstream count (before the local filter below). */
  totalHits: number;
  /** Hits of this page dropped locally: no loader of the server software, or client-only. */
  filteredOut: number;
}

/** Loader tags Modrinth uses as categories (from `GET /v2/tag/loader`, 2026-10-12). */
export const MODRINTH_LOADER_TAGS: readonly string[] = [
  "babric", "bta-babric", "bukkit", "bungeecord", "canvas", "datapack", "fabric", "folia", "forge", "geyser", "iris",
  "java-agent", "legacy-fabric", "liteloader", "minecraft", "modloader", "neoforge", "nilloader", "optifine", "ornithe",
  "paper", "purpur", "quilt", "rift", "spigot", "sponge", "vanilla", "velocity", "waterfall",
];

const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GAME_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export function requireLoaderProfile(software: ServerSoftware): ModrinthLoaderProfile {
  const profile = modrinthLoaderProfile(software);
  if (!profile) throw new CatalogError("UNSUPPORTED", `Modrinth extensions are not supported for ${software} servers`);
  return profile;
}

export function assertGameVersion(v: string): string {
  if (!GAME_VERSION_RE.test(v)) throw new CatalogError("INVALID_ARGUMENT", "invalid Minecraft version");
  return v;
}

/** Facets (OR inside an inner array, AND across arrays) for a server-compatible search. */
export function buildModrinthSearchFacets(q: Pick<ModrinthSearchQuery, "software" | "minecraftVersion" | "categories">): string[][] {
  const profile = requireLoaderProfile(q.software);
  const facets: string[][] = [[`project_type:${profile.projectType}`]];
  facets.push([...profile.loaders, ...profile.loadersWithWarning].map((l) => `categories:${l}`));
  if (profile.filterGameVersion && q.minecraftVersion) facets.push([`versions:${assertGameVersion(q.minecraftVersion)}`]);
  facets.push(["server_side!=unsupported"]);
  for (const c of q.categories ?? []) {
    if (!TAG_RE.test(c)) throw new CatalogError("INVALID_ARGUMENT", "invalid category tag");
    facets.push([`categories:${c}`]);
  }
  if (facets.length > 16) throw new CatalogError("INVALID_ARGUMENT", "too many categories");
  return facets;
}

export function safeIconUrl(url: string | null | undefined, cdnHosts: readonly string[]): string | null {
  if (!url) return null;
  try {
    return assertAllowedUrl(url, cdnHosts, "artifact").href;
  } catch {
    return null;
  }
}

/** A mapped hit before filtering: `loaderMatch` may still be "none". */
export type ModrinthSearchHitCandidate = Omit<ModrinthSearchHit, "loaderMatch"> & { loaderMatch: "match" | "warning" | "none" };

export function mapSearchHit(hit: ModrinthSearchHitRaw, profile: ModrinthLoaderProfile, cdnHosts: readonly string[]): ModrinthSearchHitCandidate {
  const loaders = hit.categories.filter((c) => MODRINTH_LOADER_TAGS.includes(c));
  const match = loaderMatch(profile, loaders);
  return {
    projectId: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    author: hit.author,
    loaders,
    categories: hit.categories.filter((c) => !MODRINTH_LOADER_TAGS.includes(c)),
    projectTypes: hit.all_project_types ?? [hit.project_type],
    downloads: hit.downloads,
    follows: hit.follows,
    iconUrl: safeIconUrl(hit.icon_url, cdnHosts),
    license: hit.license,
    clientSide: sideSupport(hit.client_side),
    serverSide: sideSupport(hit.server_side),
    clientOnly: isClientOnly({ serverSide: hit.server_side, environment: hit.environment ?? null }),
    loaderMatch: match,
    dateModified: hit.date_modified,
    latestVersionId: hit.latest_version ?? null,
  };
}

/** Searches Modrinth for plugins/mods that can run on `software`; hits without a matching loader and client-only hits are dropped (`filteredOut`). */
export async function searchModrinth(client: ModrinthClient, q: ModrinthSearchQuery): Promise<ModrinthSearchResult> {
  const profile = requireLoaderProfile(q.software);
  const query = (q.query ?? "").trim();
  if (query.length > 256 || CONTROL_RE.test(query)) throw new CatalogError("INVALID_ARGUMENT", "invalid search text");
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new CatalogError("INVALID_ARGUMENT", "offset must be 0–10000");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CatalogError("INVALID_ARGUMENT", "limit must be 1–100");
  const sort = q.sort ?? "relevance";
  if (!["relevance", "downloads", "follows", "newest", "updated"].includes(sort)) throw new CatalogError("INVALID_ARGUMENT", "invalid sort");
  const res = await client.search({ query, facets: buildModrinthSearchFacets(q), index: sort, offset, limit });
  // The facets already ask for server-side support and the loaders; re-check locally (upstream data is untrusted).
  const mapped = res.hits.map((h) => mapSearchHit(h, profile, client.cdnHosts));
  const hits = mapped.filter((h): h is ModrinthSearchHit => h.loaderMatch !== "none" && !h.clientOnly);
  return {
    hits,
    filteredOut: mapped.length - hits.length,
    offset: res.offset,
    limit: res.limit,
    totalHits: res.total_hits,
  };
}

/** Proposed DTO: project details. */
export interface ModrinthProjectDetails {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  projectType: string;
  loaders: string[];
  categories: string[];
  gameVersions: string[];
  clientSide: SideSupport;
  serverSide: SideSupport;
  clientOnly: boolean;
  status: string;
  license: { id: string; name: string; url: string | null } | null;
  downloads: number;
  followers: number;
  iconUrl: string | null;
  sourceUrl: string | null;
  issuesUrl: string | null;
  wikiUrl: string | null;
  /** `https://modrinth.com/project/<slug>`. */
  pageUrl: string;
  published: string;
  updated: string;
  /** Whether any loader of the project runs on the requested software (null when not asked). */
  compatible: boolean | null;
}

/** Only https:// links are passed through (no `javascript:` etc.); the UI must still open them with rel=noopener. */
function httpsLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

export function mapProject(p: ModrinthProjectRaw, cdnHosts: readonly string[], software?: ServerSoftware): ModrinthProjectDetails {
  const profile = software ? modrinthLoaderProfile(software) : null;
  return {
    projectId: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    projectType: p.project_type,
    loaders: p.loaders,
    categories: p.categories,
    gameVersions: p.game_versions,
    clientSide: sideSupport(p.client_side),
    serverSide: sideSupport(p.server_side),
    clientOnly: isClientOnly({ serverSide: p.server_side, environment: p.environment ?? null }),
    status: p.status,
    license: p.license ? { id: p.license.id, name: p.license.name, url: httpsLink(p.license.url) } : null,
    downloads: p.downloads,
    followers: p.followers,
    iconUrl: safeIconUrl(p.icon_url, cdnHosts),
    sourceUrl: httpsLink(p.source_url),
    issuesUrl: httpsLink(p.issues_url),
    wikiUrl: httpsLink(p.wiki_url),
    pageUrl: `https://modrinth.com/project/${encodeURIComponent(p.slug)}`,
    published: p.published,
    updated: p.updated,
    compatible: software === undefined ? null : profile !== null && loaderMatch(profile, p.loaders) !== "none",
  };
}

export async function getModrinthProject(client: ModrinthClient, ref: string, software?: ServerSoftware): Promise<ModrinthProjectDetails> {
  return mapProject(await client.getProject(ref), client.cdnHosts, software);
}
