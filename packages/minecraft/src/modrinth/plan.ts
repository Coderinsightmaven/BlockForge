import type { Checksum, ServerSoftware } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { assertAllowedUrl } from "../http.js";
import { MODRINTH_HOSTS, assertModrinthId, versionHasFileHash, type ModrinthClient, type UpdateFilter, type VersionType } from "./client.js";
import { isClientOnly, loaderMatch, sideSupport, type ModrinthLoaderProfile, type SideSupport } from "./loaders.js";
import type { ModrinthFileRaw, ModrinthProjectRaw, ModrinthVersionRaw } from "./schemas.js";
import { assertGameVersion, requireLoaderProfile, safeIconUrl } from "./search.js";

/** Largest file the agent's `artifact.fetch` accepts. */
export const MAX_EXTENSION_FILE_BYTES = 2 * 1024 ** 3;
/** Dependency entries looked at per version; more is treated as hostile/broken metadata. */
export const MAX_DEPENDENCIES_PER_VERSION = 64;

export type DependencyType = "required" | "optional" | "incompatible" | "embedded" | "unknown";

export function dependencyType(raw: string): DependencyType {
  return raw === "required" || raw === "optional" || raw === "incompatible" || raw === "embedded" ? raw : "unknown";
}

/** Upstream text for messages: one line, no control/format characters, bounded. */
export function displayText(value: string, max = 128): string {
  const s = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Proposed DTO: a version as shown in a version picker. */
export interface ModrinthVersionSummary {
  versionId: string;
  projectId: string;
  name: string;
  versionNumber: string;
  versionType: string;
  status: string | null;
  datePublished: string;
  loaders: string[];
  gameVersions: string[];
  /** Compatibility with the requested server. */
  loaderMatch: "match" | "warning" | "none";
  gameVersionMatch: boolean;
  dependencies: Array<{ type: DependencyType; projectId: string | null; versionId: string | null; fileName: string | null }>;
  /** Null when the version has no installable primary jar (see `primaryJarFile`). */
  primaryFile: { filename: string; sizeBytes: number; sha1: string; sha512: string } | null;
}

export interface CompatibilityTarget {
  software: ServerSoftware;
  /** Required unless the software is Velocity. */
  minecraftVersion: string | null;
}

export interface VersionCompatibility {
  loader: "match" | "warning" | "none";
  gameVersion: boolean;
  /** Only `status: "listed"` counts; a missing status is treated as unlisted. */
  listed: boolean;
}

export function versionCompatibility(v: ModrinthVersionRaw, profile: ModrinthLoaderProfile, minecraftVersion: string | null): VersionCompatibility {
  return {
    loader: loaderMatch(profile, v.loaders),
    gameVersion: !profile.filterGameVersion || minecraftVersion === null || v.game_versions.includes(minecraftVersion),
    listed: v.status === "listed",
  };
}

const TYPE_RANK: Record<string, number> = { release: 0, beta: 1, alpha: 2 };

/**
 * Whether a version may be selected automatically (or honoured as a dependency pin): a loader of
 * the server software, the server's game version, listed, a known version type, and a release
 * unless prereleases are allowed.
 */
export function isSelectableVersion(v: ModrinthVersionRaw, profile: ModrinthLoaderProfile, minecraftVersion: string | null, allowPrerelease = true): boolean {
  const c = versionCompatibility(v, profile, minecraftVersion);
  if (c.loader === "none" || !c.gameVersion || !c.listed) return false;
  if (TYPE_RANK[v.version_type] === undefined) return false;
  return allowPrerelease || v.version_type === "release";
}

/**
 * Best version for the server among the selectable ones; prefers a full loader match over a
 * warning match, then releases over betas over alphas, then the newest.
 */
export function pickModrinthVersion(
  versions: readonly ModrinthVersionRaw[],
  profile: ModrinthLoaderProfile,
  minecraftVersion: string | null,
  opts: { allowPrerelease?: boolean } = {},
): ModrinthVersionRaw | null {
  const allowPre = opts.allowPrerelease ?? true;
  const candidates = versions.filter((v) => isSelectableVersion(v, profile, minecraftVersion, allowPre));
  const time = (v: ModrinthVersionRaw) => {
    const t = Date.parse(v.date_published);
    return Number.isFinite(t) ? t : 0;
  };
  candidates.sort((a, b) => {
    const la = loaderMatch(profile, a.loaders) === "match" ? 0 : 1;
    const lb = loaderMatch(profile, b.loaders) === "match" ? 0 : 1;
    if (la !== lb) return la - lb;
    const ta = TYPE_RANK[a.version_type]!;
    const tb = TYPE_RANK[b.version_type]!;
    if (ta !== tb) return ta - tb;
    return time(b) - time(a);
  });
  return candidates[0] ?? null;
}

/** Path separators, Windows-reserved characters, control, format (bidi overrides) and line/paragraph separators. */
const UNSAFE_FILENAME = /[/\\:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Windows device names, which stay devices with any extension (`CON.jar`, `nul.txt.jar`). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Whether a path component is a Windows device name (`CON`, `nul.txt`, `COM1.jar`, …): checked on the part before the first dot. */
export function isWindowsReservedName(component: string): boolean {
  return WINDOWS_DEVICE.test(component.split(".")[0]!.trimEnd());
}

/** A Modrinth filename that is safe as a single path component on Linux and Windows and is a `.jar`. */
export function isSafeJarFilename(name: string): boolean {
  if (name.length < 5 || name.length > 255 || UNSAFE_FILENAME.test(name) || name.startsWith(".") || name.endsWith(" ") || name.endsWith(".")) return false;
  if (!name.toLowerCase().endsWith(".jar")) return false;
  return !isWindowsReservedName(name);
}

/**
 * An installed extension path this library may ask the agent to delete/replace:
 * `<installDir>/<safe jar name>` (also `….jar.disabled`), nothing else.
 */
export function isSafeInstalledExtensionPath(path: string, installDir: "plugins" | "mods"): boolean {
  if (!path.startsWith(`${installDir}/`)) return false;
  let name = path.slice(installDir.length + 1);
  if (name.toLowerCase().endsWith(".jar.disabled")) name = name.slice(0, -".disabled".length);
  return isSafeJarFilename(name);
}

export type FileProblem = "NO_JAR" | "UNSAFE_FILENAME" | "URL_NOT_ALLOWED" | "TOO_LARGE" | "NO_SHA512";
/** Why an available update cannot be applied: a problem with the new file, or an installed path that is not safe to replace. */
export type UpdateProblem = FileProblem | "UNSAFE_INSTALLED_PATH";
/** Most installed files of one project a plan replaces (the contract's `replaces` cap). */
export const MAX_REPLACED_FILES = 16;

export interface InstallableFile {
  file: ModrinthFileRaw;
  /** WHATWG-normalised URL that passed the CDN allowlist (store this, never the raw string). */
  url: string;
  sha512: string;
}

/**
 * The file Modrinth's download button serves — the one flagged `primary`, or the only file of a
 * single-file version — provided it is an installable jar: safe filename, cdn.modrinth.com URL,
 * ≤ 2 GiB and a SHA-512 (the agent verifies every download with it). No fallback to other jars.
 */
export function primaryJarFile(v: ModrinthVersionRaw, cdnHosts: readonly string[]): InstallableFile | { problem: FileProblem } {
  const file = v.files.find((f) => f.primary) ?? (v.files.length === 1 ? v.files[0] : undefined);
  if (!file || !file.filename.toLowerCase().endsWith(".jar")) return { problem: "NO_JAR" };
  if (!isSafeJarFilename(file.filename)) return { problem: "UNSAFE_FILENAME" };
  let url: string;
  try {
    url = assertAllowedUrl(file.url, cdnHosts, "artifact").href;
  } catch {
    return { problem: "URL_NOT_ALLOWED" };
  }
  if (file.size > MAX_EXTENSION_FILE_BYTES) return { problem: "TOO_LARGE" };
  if (file.size < 1) return { problem: "NO_JAR" }; // an empty file is not a jar
  if (!file.hashes.sha512) return { problem: "NO_SHA512" };
  return { file, url, sha512: file.hashes.sha512 };
}

export function summarizeVersion(v: ModrinthVersionRaw, profile: ModrinthLoaderProfile, minecraftVersion: string | null, cdnHosts: readonly string[]): ModrinthVersionSummary {
  const c = versionCompatibility(v, profile, minecraftVersion);
  const f = primaryJarFile(v, cdnHosts);
  return {
    versionId: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    versionType: v.version_type,
    status: v.status ?? null,
    datePublished: v.date_published,
    loaders: v.loaders,
    gameVersions: v.game_versions,
    loaderMatch: c.loader,
    gameVersionMatch: c.gameVersion,
    dependencies: v.dependencies.slice(0, MAX_DEPENDENCIES_PER_VERSION).map((d) => ({
      type: dependencyType(d.dependency_type),
      projectId: d.project_id ?? null,
      versionId: d.version_id ?? null,
      fileName: d.file_name ? displayText(d.file_name) : null,
    })),
    primaryFile: "file" in f ? { filename: f.file.filename, sizeBytes: f.file.size, sha1: f.file.hashes.sha1, sha512: f.sha512 } : null,
  };
}

function targetVersion(target: CompatibilityTarget, profile: ModrinthLoaderProfile): string | null {
  if (!profile.filterGameVersion) return null;
  if (!target.minecraftVersion) throw new CatalogError("INVALID_ARGUMENT", `a Minecraft version is required for ${target.software}`);
  return assertGameVersion(target.minecraftVersion);
}

function versionFilter(profile: ModrinthLoaderProfile, mc: string | null): { loaders: string[]; gameVersions?: string[] } {
  const loaders = [...profile.loaders, ...profile.loadersWithWarning];
  return mc === null ? { loaders } : { loaders, gameVersions: [mc] };
}

/**
 * Versions of a project the installer would accept (newest first), for a version picker: the same
 * `isSelectableVersion` policy as the planner (listed, compatible, known type, prereleases only
 * with `allowPrerelease` — default true like the planner; the API passes its own default, false).
 */
export async function listCompatibleVersions(
  client: ModrinthClient,
  project: string,
  target: CompatibilityTarget,
  opts: { allowPrerelease?: boolean } = {},
): Promise<ModrinthVersionSummary[]> {
  const profile = requireLoaderProfile(target.software);
  const mc = targetVersion(target, profile);
  const allowPre = opts.allowPrerelease ?? true;
  const versions = await client.listVersions(project, versionFilter(profile, mc));
  return versions
    .filter((v) => isSelectableVersion(v, profile, mc, allowPre))
    .map((v) => summarizeVersion(v, profile, mc, client.cdnHosts))
    .sort((a, b) => (Date.parse(b.datePublished) || 0) - (Date.parse(a.datePublished) || 0));
}

// ---------------------------------------------------------------------------------------------
// Install plan

/** A file already present on the server (from a directory listing + agent-computed hashes). */
export interface InstalledExtensionRef {
  /** Path relative to the data root, e.g. `plugins/LuckPerms-Bukkit-5.5.70.jar`. */
  path: string;
  sha1?: string | null;
  sha512?: string | null;
  /** Set when the file was identified on Modrinth (`identifyModrinthFiles`). */
  projectId?: string | null;
  versionId?: string | null;
}

export type PlanWarningCode =
  | "CLIENT_ONLY"
  | "QUILT_ON_FABRIC"
  | "PRERELEASE"
  | "NOT_LISTED"
  | "VERSION_MISMATCH"
  | "ALREADY_INSTALLED"
  | "REPLACES_INSTALLED"
  | "FILE_CONFLICT"
  | "UNSAFE_INSTALLED_PATH"
  | "INCOMPATIBLE_INSTALLED"
  | "INCOMPATIBLE_IN_PLAN"
  | "DEPENDENCY_UNRESOLVED"
  | "DEPENDENCY_EXTERNAL_FILE"
  | "DEPENDENCY_LIMIT"
  | "DEPENDENCY_PIN_IGNORED"
  | "DEPENDENCY_PIN_CONFLICT"
  | "DEPENDENCY_ALREADY_INSTALLED"
  | "DEPENDENCY_INSTALLED_UNKNOWN"
  | "OPTIONAL_DEPENDENCY"
  | "EMBEDDED_DEPENDENCY"
  | "UNKNOWN_DEPENDENCY_TYPE"
  | "NO_SHA512"
  | "NO_INSTALLABLE_FILE";

/** `error` blocks the plan (`installable: false`); `warning` needs the administrator's attention. */
export interface PlanWarning {
  code: PlanWarningCode;
  level: "info" | "warning" | "error";
  /** Built from upstream text via `displayText` (single line, bounded). */
  message: string;
  projectId: string | null;
  versionId: string | null;
}

/** Proposed DTO: one file of an install plan (maps 1:1 to an `artifact.fetch` command). */
export interface ModrinthPlannedFile {
  action: "install" | "replace";
  reason: "requested" | "dependency" | "optional-dependency";
  /** Project ids that pulled this file in (empty for the requested project). */
  requiredBy: string[];
  projectId: string;
  projectSlug: string | null;
  projectTitle: string | null;
  versionId: string;
  versionNumber: string;
  versionType: string;
  loaders: string[];
  filename: string;
  /** Normalised cdn.modrinth.com URL. */
  url: string;
  sizeBytes: number;
  sha1: string;
  sha512: string;
  /** Checksum for `artifact.fetch` (always SHA-512). */
  checksum: Checksum;
  /** `plugins/<filename>` or `mods/<filename>`. */
  destPath: string;
  /** Installed files of the same project to delete after a successful fetch (safe `<dir>/<jar>` paths only). */
  replaces: string[];
}

/** Proposed DTO: the result of planning an installation. */
export interface ModrinthInstallPlan {
  software: ServerSoftware;
  minecraftVersion: string | null;
  installDir: "plugins" | "mods";
  root: { projectId: string; slug: string; title: string; versionId: string; versionNumber: string };
  /** Files to fetch, dependencies before dependants. */
  files: ModrinthPlannedFile[];
  /** Planned files whose exact bytes are already on the server (not re-fetched). */
  alreadyInstalled: Array<{ projectId: string; versionId: string; path: string }>;
  /**
   * Optional dependencies that are neither installed nor planned (offer them in the UI; opt in via
   * `includeOptional` with the project id, or the version id when only that is known).
   */
  optionalDependencies: Array<{ projectId: string | null; versionId: string | null; slug: string | null; title: string | null; requiredBy: string }>;
  warnings: PlanWarning[];
  /** False when any warning has level `error`. */
  installable: boolean;
}

export interface ModrinthInstallRequest extends CompatibilityTarget {
  /** Project id or slug. */
  project: string;
  /** Pin a version id; default: best compatible version. */
  versionId?: string | null;
  /**
   * Administrator override for an explicit `versionId` that does not list the server's Minecraft
   * version, is not listed on Modrinth, or is a prerelease while `allowPrerelease` is false — the
   * plan then carries a warning instead of an error. Default false. Never overrides a wrong loader.
   */
  allowIncompatibleVersion?: boolean;
  installed?: readonly InstalledExtensionRef[];
  /** Optional dependencies the administrator opted into (project ids or version ids). */
  includeOptional?: readonly string[];
  /** Default true: fall back to beta/alpha builds when there is no compatible release. */
  allowPrerelease?: boolean;
  /** Maximum number of files in the plan (requested project + dependencies). Default 32. */
  maxFiles?: number;
  /** Maximum dependency depth. Default 8. */
  maxDepth?: number;
}

interface Node {
  projectId: string;
  version: ModrinthVersionRaw;
  reason: ModrinthPlannedFile["reason"];
  requiredBy: Set<string>;
  depth: number;
}

/** Whether an installed file's hash is one of the version's files (`unknown` when the ref carries no hash). */
function installedHashState(i: InstalledExtensionRef, v: ModrinthVersionRaw): "match" | "mismatch" | "unknown" {
  if (i.sha512) return versionHasFileHash(v, i.sha512, "sha512") ? "match" : "mismatch";
  if (i.sha1) return versionHasFileHash(v, i.sha1, "sha1") ? "match" : "mismatch";
  return "unknown";
}

function hashesOf(i: InstalledExtensionRef): string[] {
  const out: string[] = [];
  if (i.sha1) out.push(i.sha1.toLowerCase());
  if (i.sha512) out.push(i.sha512.toLowerCase());
  return out;
}

/**
 * Plans the installation of a Modrinth project on a server: picks the version, resolves required
 * dependencies for the same loader/game version (cycle-safe; bounded by `maxFiles`, `maxDepth`,
 * `MAX_DEPENDENCIES_PER_VERSION` and a request budget; version ids are only fetched for
 * dependencies that are actually selected), honours dependency pins only when they pass the same
 * listed/type/compatibility policy as automatic selection, flags conflicting pins and installed
 * versions that do not satisfy them, validates every file (primary jar, cdn.modrinth.com,
 * SHA-512, safe name, size), and reports client-only, incompatible and unresolved items.
 */
export async function planModrinthInstall(client: ModrinthClient, req: ModrinthInstallRequest): Promise<ModrinthInstallPlan> {
  const profile = requireLoaderProfile(req.software);
  const mc = targetVersion(req, profile);
  const maxFiles = Math.min(Math.max(req.maxFiles ?? 32, 1), 128);
  const maxDepth = Math.min(Math.max(req.maxDepth ?? 8, 0), 16);
  const includeOptional = new Set(req.includeOptional ?? []);
  const installed = req.installed ?? [];
  const filter = versionFilter(profile, mc);
  const allowPre = req.allowPrerelease ?? true;
  const selectable = (v: ModrinthVersionRaw) => isSelectableVersion(v, profile, mc, allowPre);
  let budget = maxFiles * 2 + 16; // dependency API requests (version fetches + version lists)

  const warnings: PlanWarning[] = [];
  const warn = (code: PlanWarningCode, level: PlanWarning["level"], message: string, projectId: string | null = null, versionId: string | null = null) => {
    if (!warnings.some((w) => w.code === code && w.projectId === projectId && w.versionId === versionId)) warnings.push({ code, level, message, projectId, versionId });
  };

  const installedByProject = new Map<string, InstalledExtensionRef[]>();
  const installedHashes = new Map<string, InstalledExtensionRef>();
  for (const i of installed) {
    if (i.projectId) installedByProject.set(i.projectId, [...(installedByProject.get(i.projectId) ?? []), i]);
    for (const h of hashesOf(i)) installedHashes.set(h, i);
  }

  const rootProject = await client.getProject(req.project);
  const projects = new Map<string, ModrinthProjectRaw>([[rootProject.id, rootProject]]);
  const label = (projectId: string) => displayText(projects.get(projectId)?.title ?? projectId);
  const vlabel = (v: ModrinthVersionRaw) => displayText(v.version_number, 64);
  const versionCache = new Map<string, ModrinthVersionRaw | null>();
  const deferred: Array<() => void> = [];
  const later = (fn: () => void) => deferred.push(fn);
  let budgetReported = false;
  const spend = (): boolean => {
    if (budget > 0) {
      budget--;
      return true;
    }
    if (!budgetReported) {
      budgetReported = true;
      later(() => warn("DEPENDENCY_LIMIT", "error", "dependency resolution stopped: too many Modrinth requests for one plan", null, null));
    }
    return false;
  };
  /** Version by id (cached; NOT_FOUND → null; undefined when the request budget is exhausted). */
  const fetchVersion = async (id: string): Promise<ModrinthVersionRaw | null | undefined> => {
    if (versionCache.has(id)) return versionCache.get(id)!;
    if (!spend()) return undefined;
    let v: ModrinthVersionRaw | null;
    try {
      v = await client.getVersion(assertModrinthId(id, "version id"));
    } catch (err) {
      if (err instanceof CatalogError && (err.code === "NOT_FOUND" || err.code === "INVALID_ARGUMENT")) v = null;
      else throw err;
    }
    versionCache.set(id, v);
    return v;
  };

  // Installed versions (identification results): needed for pins and incompatibility checks.
  const installedVersions = new Map<string, ModrinthVersionRaw>();
  const installedVersionIds = [...new Set(installed.map((i) => i.versionId).filter((id): id is string => !!id))];
  for (let i = 0; i < installedVersionIds.length; i += 100) {
    if (!spend()) break; // counted like every other request; unknown installed versions are reported below
    for (const iv of await client.getVersions(installedVersionIds.slice(i, i + 100))) installedVersions.set(iv.id, iv);
  }

  // --- root version
  let rootVersion: ModrinthVersionRaw;
  if (req.versionId) {
    const pinned = await client.getVersion(assertModrinthId(req.versionId, "version id"));
    versionCache.set(pinned.id, pinned);
    if (pinned.project_id !== rootProject.id) throw new CatalogError("INVALID_ARGUMENT", "the version does not belong to the project");
    rootVersion = pinned;
    const c = versionCompatibility(pinned, profile, mc);
    const overridable = req.allowIncompatibleVersion === true ? "warning" : "error";
    const what = `${label(rootProject.id)} ${vlabel(pinned)}`;
    if (c.loader === "none") warn("VERSION_MISMATCH", "error", `${what} is not built for ${req.software} (${displayText(pinned.loaders.join(", "))})`, rootProject.id, pinned.id);
    else if (!c.gameVersion) warn("VERSION_MISMATCH", overridable, `${what} does not list Minecraft ${mc}`, rootProject.id, pinned.id);
    if (!c.listed) warn("NOT_LISTED", overridable, `${what} is ${displayText(pinned.status ?? "not listed", 32)} on Modrinth`, rootProject.id, pinned.id);
    if (TYPE_RANK[pinned.version_type] === undefined) warn("VERSION_MISMATCH", "error", `${what} has the unknown version type "${displayText(pinned.version_type, 16)}"`, rootProject.id, pinned.id);
    else if (!allowPre && pinned.version_type !== "release") warn("PRERELEASE", overridable, `${what} is a ${displayText(pinned.version_type, 16)} build and prereleases are not allowed`, rootProject.id, pinned.id);
  } else {
    const picked = pickModrinthVersion(await client.listVersions(rootProject.id, filter), profile, mc, { allowPrerelease: allowPre });
    if (!picked) throw new CatalogError("UNAVAILABLE", `${label(rootProject.id)} has no version for ${req.software}${mc ? ` ${mc}` : ""}`);
    rootVersion = picked;
  }

  const nodes = new Map<string, Node>();
  const order: Node[] = [];
  const optional = new Map<string, { projectId: string | null; versionId: string | null; requiredBy: string }>();
  const incompatible: Array<{ by: string; projectId: string }> = [];
  /** Incompatibilities with one specific version: compared by id, never fetched. */
  const incompatibleVersions: Array<{ by: string; versionId: string }> = [];
  const mentioned = new Set<string>();

  /** A pinned version honoured only when it belongs to the project and passes the selection policy. */
  const honourPin = async (projectId: string, pinned: string): Promise<ModrinthVersionRaw | null> => {
    const pv = await fetchVersion(pinned);
    if (pv && pv.project_id === projectId && selectable(pv)) return pv;
    const what = pv && pv.project_id === projectId ? `${vlabel(pv)} (${displayText(pv.version_type, 16)}, ${displayText(pv.status ?? "unlisted", 16)})` : pinned;
    later(() => warn("DEPENDENCY_PIN_IGNORED", "warning", `the pinned version ${what} of ${label(projectId)} does not fit this server or the release policy; using the newest compatible version instead`, projectId, pinned));
    return null;
  };

  const newestCompatible = async (projectId: string): Promise<ModrinthVersionRaw | null> => {
    if (!spend()) return null;
    return pickModrinthVersion(await client.listVersions(projectId, filter), profile, mc, { allowPrerelease: allowPre });
  };

  const visit = async (node: Node): Promise<void> => {
    let deps = node.version.dependencies;
    if (deps.length > MAX_DEPENDENCIES_PER_VERSION) {
      const dropped = deps.slice(MAX_DEPENDENCIES_PER_VERSION);
      const level = dropped.some((d) => dependencyType(d.dependency_type) === "required") ? "error" : "warning";
      later(() => warn("DEPENDENCY_LIMIT", level, `${label(node.projectId)} ${vlabel(node.version)} declares ${node.version.dependencies.length} dependencies; only the first ${MAX_DEPENDENCIES_PER_VERSION} were considered`, node.projectId, node.version.id));
      deps = deps.slice(0, MAX_DEPENDENCIES_PER_VERSION);
    }
    for (const dep of deps) {
      const type = dependencyType(dep.dependency_type);
      let projectId = dep.project_id ?? null;
      const pinned = dep.version_id ?? null;
      if (type === "unknown") {
        later(() => warn("UNKNOWN_DEPENDENCY_TYPE", "info", `unknown dependency type "${displayText(dep.dependency_type, 32)}"`, projectId, pinned));
        continue;
      }
      if (type === "embedded") {
        // Bundled inside the jar: nothing to fetch or install.
        if (projectId) mentioned.add(projectId);
        later(() => warn("EMBEDDED_DEPENDENCY", "info", `${label(node.projectId)} bundles ${projectId ? label(projectId) : `version ${pinned ?? "?"}`}; nothing to install`, projectId, pinned));
        continue;
      }
      if (!projectId && !pinned) {
        const fileName = dep.file_name ? displayText(dep.file_name) : null;
        if (fileName && (type === "required" || type === "optional")) {
          later(() => warn("DEPENDENCY_EXTERNAL_FILE", type === "required" ? "warning" : "info", `${label(node.projectId)} needs a file that is not on Modrinth (${fileName}); install it manually`, node.projectId, node.version.id));
        }
        continue;
      }
      if (projectId === node.projectId) continue;
      if (type === "optional" && !((projectId && includeOptional.has(projectId)) || (pinned && includeOptional.has(pinned)))) {
        // Not selected: record it, fetch nothing.
        const key = projectId ?? `version:${pinned}`;
        if (!optional.has(key)) optional.set(key, { projectId, versionId: projectId ? null : pinned, requiredBy: node.projectId });
        if (projectId) mentioned.add(projectId);
        continue;
      }
      if (type === "incompatible") {
        if (pinned) incompatibleVersions.push({ by: node.projectId, versionId: pinned });
        else if (projectId) {
          mentioned.add(projectId);
          incompatible.push({ by: node.projectId, projectId });
        }
        continue;
      }

      // Required, or an optional dependency the administrator opted into.
      const level = type === "required" ? "error" : "warning";
      const existing = projectId ? nodes.get(projectId) : undefined;
      if (!existing && (node.depth + 1 > maxDepth || nodes.size >= maxFiles)) {
        const reached = node.depth + 1 > maxDepth ? `depth ${maxDepth}` : `${maxFiles} files`;
        const what = projectId ?? `version ${pinned}`;
        later(() => warn("DEPENDENCY_LIMIT", level, `dependency resolution stopped at ${reached}; ${projectId ? label(projectId) : what} was not added`, projectId, pinned));
        continue;
      }
      if (!projectId) {
        const pv = await fetchVersion(pinned!);
        if (!pv) {
          if (pv === null) later(() => warn("DEPENDENCY_UNRESOLVED", level, `${label(node.projectId)} needs version ${pinned}, which does not exist on Modrinth`, null, pinned));
          continue;
        }
        projectId = pv.project_id;
        if (projectId === node.projectId) continue;
      }
      const pid = projectId;
      mentioned.add(pid);

      const already = nodes.get(pid);
      if (already) {
        if (already.reason !== "requested") already.requiredBy.add(node.projectId);
        if (pinned && pinned !== already.version.id) {
          const pv = await fetchVersion(pinned);
          if (pv && pv.project_id === pid && selectable(pv)) {
            const chosen = already.version;
            later(() =>
              warn(
                "DEPENDENCY_PIN_CONFLICT",
                "error",
                `${label(node.projectId)} requires ${label(pid)} ${vlabel(pv)}, but the plan already uses ${vlabel(chosen)}`,
                pid,
                pinned,
              ),
            );
          } else {
            later(() => warn("DEPENDENCY_PIN_IGNORED", "warning", `${label(node.projectId)} pins ${label(pid)} to ${pv ? vlabel(pv) : pinned}, which does not fit this server; the plan uses ${vlabel(already.version)}`, pid, pinned));
          }
        }
        continue;
      }

      let chosen: ModrinthVersionRaw | null = pinned ? await honourPin(pid, pinned) : null;
      const inst = installedByProject.get(pid);
      if (inst) {
        // Never short-circuit on a path the planner could not replace.
        const unsafe = inst.filter((i) => !isSafeInstalledExtensionPath(i.path, profile.installDir));
        if (unsafe.length > 0) {
          later(() => warn("UNSAFE_INSTALLED_PATH", "error", `the installed ${label(pid)} at ${displayText(unsafe.map((i) => i.path).join(", "))} is not a plain ${profile.installDir}/<name>.jar file; remove it manually`, pid, null));
          continue;
        }
        const instVersions = inst.map((i) => (i.versionId ? installedVersions.get(i.versionId) : undefined));
        if (instVersions.some((v) => v === undefined)) {
          later(() => warn("DEPENDENCY_INSTALLED_UNKNOWN", "error", `${label(node.projectId)} needs ${label(pid)}; the installed copy (${displayText(inst.map((i) => i.path).join(", "))}) cannot be matched to a Modrinth version`, pid, null));
          continue;
        }
        const versions = instVersions as ModrinthVersionRaw[];
        if (chosen) {
          const pin = chosen;
          const same = inst.every((i, k) => versions[k]!.id === pin.id && installedHashState(i, pin) === "match");
          if (same) {
            later(() => warn("DEPENDENCY_ALREADY_INSTALLED", "info", `${label(node.projectId)} needs ${label(pid)} ${vlabel(pin)}, which is installed`, pid, pin.id));
            continue;
          }
          // Other version, other bytes, or bytes we cannot check: download the pin and replace the old jar(s).
        } else if (versions.every((v) => versionCompatibility(v, profile, mc).loader !== "none" && versionCompatibility(v, profile, mc).gameVersion)) {
          const states = inst.map((i, k) => installedHashState(i, versions[k]!));
          if (states.includes("mismatch")) {
            later(() => warn("DEPENDENCY_INSTALLED_UNKNOWN", "error", `${label(node.projectId)} needs ${label(pid)}; the installed file does not match the Modrinth version it was identified as`, pid, null));
            continue;
          }
          if (states.every((st) => st === "match")) {
            later(() => warn("DEPENDENCY_ALREADY_INSTALLED", "info", `${label(node.projectId)} needs ${label(pid)}, which is installed (${displayText(versions.map((v) => v.version_number).join(", "))})`, pid, null));
            continue;
          }
          later(() => warn("REPLACES_INSTALLED", "warning", `the installed ${label(pid)} cannot be verified (no hash) and will be replaced`, pid, null));
        } else {
          later(() => warn("REPLACES_INSTALLED", "warning", `the installed ${label(pid)} does not fit this server and will be replaced`, pid, null));
        }
      }
      chosen ??= await newestCompatible(pid);
      if (!chosen) {
        later(() => warn("DEPENDENCY_UNRESOLVED", level, `${label(node.projectId)} needs ${label(pid)}, which has no version for ${req.software}${mc ? ` ${mc}` : ""}`, pid, null));
        continue;
      }
      const child: Node = { projectId: pid, version: chosen, reason: type === "required" ? "dependency" : "optional-dependency", requiredBy: new Set([node.projectId]), depth: node.depth + 1 };
      nodes.set(pid, child);
      await visit(child);
    }
    order.push(node);
  };

  const root: Node = { projectId: rootProject.id, version: rootVersion, reason: "requested", requiredBy: new Set(), depth: 0 };
  nodes.set(root.projectId, root);
  await visit(root);

  // Metadata for everything else we mention (titles, client-only flags), batched.
  const missing = [...new Set([...nodes.keys(), ...mentioned])].filter((id) => !projects.has(id));
  if (missing.length > 0) for (const p of await client.getProjects(missing)) projects.set(p.id, p);
  for (const fn of deferred) fn();

  // Installed extensions that declare themselves incompatible with something in the plan.
  for (const iv of installedVersions.values()) {
    if (nodes.has(iv.project_id)) continue; // being replaced by the plan
    for (const d of iv.dependencies.slice(0, MAX_DEPENDENCIES_PER_VERSION)) {
      if (dependencyType(d.dependency_type) === "incompatible" && d.project_id && nodes.has(d.project_id)) incompatible.push({ by: iv.project_id, projectId: d.project_id });
    }
  }
  for (const { by, versionId } of incompatibleVersions) {
    const planned = [...nodes.values()].find((n) => n.version.id === versionId);
    const inst = installed.find((i) => i.versionId === versionId);
    if (planned && planned.projectId !== by) warn("INCOMPATIBLE_IN_PLAN", "error", `${label(by)} is incompatible with ${label(planned.projectId)} ${vlabel(planned.version)}`, planned.projectId, versionId);
    else if (inst && inst.projectId !== by && !nodes.has(inst.projectId ?? "")) warn("INCOMPATIBLE_INSTALLED", "error", `${label(by)} is incompatible with the installed ${displayText(inst.path)}`, inst.projectId ?? null, versionId);
  }
  for (const { by, projectId } of incompatible) {
    if (installedByProject.has(projectId) || (installedByProject.has(by) && nodes.has(projectId))) {
      const path = (installedByProject.get(projectId) ?? installedByProject.get(by))![0]!.path;
      warn("INCOMPATIBLE_INSTALLED", "error", `${label(by)} is incompatible with ${label(projectId)} (installed: ${displayText(path)})`, projectId, null);
    } else if (nodes.has(projectId) && nodes.has(by)) {
      warn("INCOMPATIBLE_IN_PLAN", "error", `${label(by)} is incompatible with ${label(projectId)}`, projectId, null);
    }
  }

  const files: ModrinthPlannedFile[] = [];
  const alreadyInstalled: ModrinthInstallPlan["alreadyInstalled"] = [];
  const destPaths = new Set<string>();
  for (const node of order) {
    const v = node.version;
    const project = projects.get(node.projectId) ?? null;
    const what = `${label(node.projectId)} ${vlabel(v)}`;
    if (isClientOnly({ serverSide: project?.server_side ?? null, environment: v.environment ?? null })) {
      warn("CLIENT_ONLY", "warning", `${label(node.projectId)} is marked client-side only on Modrinth and may crash or do nothing on a server`, node.projectId, v.id);
    }
    if (loaderMatch(profile, v.loaders) === "warning") {
      warn("QUILT_ON_FABRIC", "warning", `${what} is built for ${displayText(v.loaders.join(", "))}; Fabric cannot load Quilt-only mods`, node.projectId, v.id);
    }
    if (TYPE_RANK[v.version_type] === undefined) {
      warn("VERSION_MISMATCH", "error", `${what} has the unknown version type "${displayText(v.version_type, 16)}"`, node.projectId, v.id);
      continue;
    }
    if (v.version_type !== "release") warn("PRERELEASE", "info", `${what} is a ${displayText(v.version_type, 16)} build`, node.projectId, v.id);

    const picked = primaryJarFile(v, client.cdnHosts);
    if ("problem" in picked) {
      if (picked.problem === "NO_SHA512") warn("NO_SHA512", "error", `${what}: Modrinth publishes no SHA-512 for the file, so the download cannot be verified`, node.projectId, v.id);
      else warn("NO_INSTALLABLE_FILE", "error", `${what} has no installable primary jar (${picked.problem})`, node.projectId, v.id);
      continue;
    }
    const f = picked.file;
    const hit = installedHashes.get(picked.sha512) ?? installedHashes.get(f.hashes.sha1);
    if (hit) {
      alreadyInstalled.push({ projectId: node.projectId, versionId: v.id, path: hit.path });
      warn("ALREADY_INSTALLED", "info", `${what} is already installed (${displayText(hit.path)})`, node.projectId, v.id);
      continue;
    }
    const destPath = `${profile.installDir}/${f.filename}`;
    if (destPaths.has(destPath.toLowerCase())) {
      warn("FILE_CONFLICT", "error", `two planned files are named ${displayText(f.filename)}`, node.projectId, v.id);
      continue;
    }
    destPaths.add(destPath.toLowerCase());
    const replaces: string[] = [];
    for (const i of installedByProject.get(node.projectId) ?? []) {
      if (i.path === destPath) continue;
      if (isSafeInstalledExtensionPath(i.path, profile.installDir)) replaces.push(i.path);
      else warn("UNSAFE_INSTALLED_PATH", "error", `the installed ${label(node.projectId)} at ${displayText(i.path)} is not a plain ${profile.installDir}/<name>.jar file; remove it manually`, node.projectId, v.id);
    }
    if (replaces.length > MAX_REPLACED_FILES) {
      warn("REPLACES_INSTALLED", "error", `${replaces.length} installed copies of ${label(node.projectId)} would have to be replaced (at most ${MAX_REPLACED_FILES}); remove the extra ones first`, node.projectId, v.id);
      continue;
    }
    if (replaces.length > 0) warn("REPLACES_INSTALLED", "info", `${label(node.projectId)} replaces ${displayText(replaces.join(", "))}`, node.projectId, v.id);
    const clash = installed.find((i) => i.path.toLowerCase() === destPath.toLowerCase() && i.projectId !== node.projectId);
    if (clash) warn("FILE_CONFLICT", "warning", `${destPath} already exists and belongs to another extension; it would be overwritten`, node.projectId, v.id);
    files.push({
      action: installedByProject.has(node.projectId) ? "replace" : "install",
      reason: node.reason,
      requiredBy: [...node.requiredBy],
      projectId: node.projectId,
      projectSlug: project?.slug ?? null,
      projectTitle: project?.title ?? null,
      versionId: v.id,
      versionNumber: v.version_number,
      versionType: v.version_type,
      loaders: v.loaders,
      filename: f.filename,
      url: picked.url,
      sizeBytes: f.size,
      sha1: f.hashes.sha1,
      sha512: picked.sha512,
      checksum: { algorithm: "sha512", value: picked.sha512 },
      destPath,
      replaces,
    });
  }

  const optionalDependencies = [...optional.values()]
    .filter((o) => !(o.projectId && (nodes.has(o.projectId) || installedByProject.has(o.projectId))))
    .map((o) => ({ ...o, slug: o.projectId ? (projects.get(o.projectId)?.slug ?? null) : null, title: o.projectId ? (projects.get(o.projectId)?.title ?? null) : null }));
  for (const o of optionalDependencies) {
    warn("OPTIONAL_DEPENDENCY", "info", `${label(o.requiredBy)} can use ${o.projectId ? label(o.projectId) : `version ${o.versionId}`} (optional)`, o.projectId, o.versionId);
  }

  return {
    software: req.software,
    minecraftVersion: mc,
    installDir: profile.installDir,
    root: { projectId: rootProject.id, slug: rootProject.slug, title: rootProject.title, versionId: rootVersion.id, versionNumber: rootVersion.version_number },
    files,
    alreadyInstalled,
    optionalDependencies,
    warnings,
    installable: !warnings.some((w) => w.level === "error"),
  };
}

/**
 * `artifact.fetch` payload for a planned file (the control plane adds nothing but the workload id).
 * The URL is re-validated and stored in its normalised form.
 */
export function modrinthFetchPayload(file: ModrinthPlannedFile, workloadId: string, cdnHosts: readonly string[] = MODRINTH_HOSTS.cdn) {
  const url = assertAllowedUrl(file.url, cdnHosts, "artifact").href;
  return { workloadId, url, destPath: file.destPath, checksum: file.checksum, maxBytes: file.sizeBytes, cache: true };
}

// ---------------------------------------------------------------------------------------------
// Identification and update checks

/** Proposed DTO: a Modrinth identification of an installed file. */
export interface ModrinthFileIdentity {
  projectId: string;
  slug: string | null;
  title: string | null;
  versionId: string;
  versionNumber: string;
  versionType: string;
  loaders: string[];
  gameVersions: string[];
  serverSide: SideSupport;
  clientOnly: boolean;
  /** Project icon on the Modrinth CDN (null when absent or elsewhere). */
  iconUrl: string | null;
}

export interface IdentifiedFile {
  path: string;
  /** Hash used for the lookup. */
  hash: { algorithm: "sha1" | "sha512"; value: string } | null;
  modrinth: ModrinthFileIdentity | null;
}

function lookupHash(i: InstalledExtensionRef): { algorithm: "sha1" | "sha512"; value: string } | null {
  if (i.sha512) return { algorithm: "sha512", value: i.sha512.toLowerCase() };
  if (i.sha1) return { algorithm: "sha1", value: i.sha1.toLowerCase() };
  return null;
}

/**
 * Identifies installed jars by hash (`POST /version_files`, SHA-512 preferred, SHA-1 otherwise)
 * and adds project titles (`GET /projects`). A response entry only counts when the returned
 * version really lists the queried hash (`ModrinthClient.versionsFromHashes`). Unknown files
 * (uploads, other sources) get `null`.
 */
export async function identifyModrinthFiles(client: ModrinthClient, files: readonly InstalledExtensionRef[]): Promise<IdentifiedFile[]> {
  const byAlg = { sha1: [] as string[], sha512: [] as string[] };
  for (const f of files) {
    const h = lookupHash(f);
    if (h) byAlg[h.algorithm].push(h.value);
  }
  const found = new Map<string, ModrinthVersionRaw>();
  for (const alg of ["sha512", "sha1"] as const) {
    if (byAlg[alg].length === 0) continue;
    for (const [h, v] of await client.versionsFromHashes(byAlg[alg], alg)) found.set(h, v);
  }
  const projectIds = [...new Set([...found.values()].map((v) => v.project_id))];
  const projects = new Map((projectIds.length > 0 ? await client.getProjects(projectIds) : []).map((p) => [p.id, p]));
  return files.map((f) => {
    const hash = lookupHash(f);
    const v = hash ? found.get(hash.value) : undefined;
    if (!v) return { path: f.path, hash, modrinth: null };
    const p = projects.get(v.project_id);
    return {
      path: f.path,
      hash,
      modrinth: {
        projectId: v.project_id,
        slug: p?.slug ?? null,
        title: p?.title ?? null,
        versionId: v.id,
        versionNumber: v.version_number,
        versionType: v.version_type,
        loaders: v.loaders,
        gameVersions: v.game_versions,
        serverSide: sideSupport(p?.server_side),
        clientOnly: isClientOnly({ serverSide: p?.server_side ?? null, environment: v.environment ?? null }),
        iconUrl: safeIconUrl(p?.icon_url, client.cdnHosts),
      },
    };
  });
}

/** Proposed DTO: update status of one installed file. */
export interface ModrinthUpdateStatus {
  path: string;
  current: { projectId: string; versionId: string; versionNumber: string; datePublished: string } | null;
  latest: { projectId: string; versionId: string; versionNumber: string; versionType: string; datePublished: string } | null;
  updateAvailable: boolean;
  /** Ready-to-run replacement when an update is available and installable. */
  file: ModrinthPlannedFile | null;
  problem: UpdateProblem | null;
}

/** Version types an update may have: never less stable than what is installed (unless `allowPrerelease`). */
export function allowedUpdateTypes(currentType: string, allowPrerelease = false): VersionType[] | undefined {
  if (allowPrerelease) return undefined;
  if (currentType === "release") return ["release"];
  if (currentType === "beta") return ["release", "beta"];
  return undefined;
}

/**
 * Update check for installed files (`POST /version_files` + `POST /version_files/update` with the
 * server's loaders, game version and — unless `allowPrerelease` — version types no less stable
 * than the installed one, so a release is never "updated" to a beta). The installed version is
 * only trusted when it lists the queried hash; the offered update must be a listed, compatible
 * version of the same project, newer than the installed one, with an installable primary jar.
 * Dependencies of the new version are not resolved here; run `planModrinthInstall` with
 * `versionId` for that.
 */
export async function checkModrinthUpdates(
  client: ModrinthClient,
  target: CompatibilityTarget,
  files: readonly InstalledExtensionRef[],
  opts: { allowPrerelease?: boolean } = {},
): Promise<ModrinthUpdateStatus[]> {
  const profile = requireLoaderProfile(target.software);
  const mc = targetVersion(target, profile);
  const current = new Map<string, ModrinthVersionRaw>();
  const latest = new Map<string, ModrinthVersionRaw>();
  for (const alg of ["sha512", "sha1"] as const) {
    const hashes = files.map(lookupHash).filter((h): h is NonNullable<typeof h> => h?.algorithm === alg).map((h) => h.value);
    if (hashes.length === 0) continue;
    for (const [h, v] of await client.versionsFromHashes(hashes, alg)) current.set(h, v);
    // One update request per stability group (release-only / release+beta / any).
    const groups = new Map<string, { types: VersionType[] | undefined; hashes: string[] }>();
    for (const h of hashes) {
      const cur = current.get(h);
      if (!cur) continue;
      const types = allowedUpdateTypes(cur.version_type, opts.allowPrerelease);
      const key = types ? types.join(",") : "*";
      const g = groups.get(key) ?? { types, hashes: [] };
      g.hashes.push(h);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const filter: UpdateFilter = { loaders: [...profile.loaders], ...(mc === null ? {} : { gameVersions: [mc] }), ...(g.types ? { versionTypes: g.types } : {}) };
      for (const [h, v] of await client.latestVersionsFromHashes(g.hashes, alg, filter)) latest.set(h, v);
    }
  }
  return files.map((f) => {
    const h = lookupHash(f);
    const cur = h ? current.get(h.value) : undefined;
    let lat = h && cur ? latest.get(h.value) : undefined;
    if (lat && cur && lat.project_id !== cur.project_id) lat = undefined;
    if (lat) {
      const types = cur ? allowedUpdateTypes(cur.version_type, opts.allowPrerelease) : undefined;
      if (!isSelectableVersion(lat, profile, mc, true) || (types && !types.includes(lat.version_type as VersionType))) lat = undefined;
    }
    const newer = !!(cur && lat && lat.id !== cur.id && (Date.parse(lat.date_published) || 0) > (Date.parse(cur.date_published) || 0));
    let file: ModrinthPlannedFile | null = null;
    let problem: UpdateProblem | null = null;
    if (newer && lat) {
      const picked = primaryJarFile(lat, client.cdnHosts);
      if ("problem" in picked) problem = picked.problem;
      else if (!isSafeInstalledExtensionPath(f.path, profile.installDir)) problem = "UNSAFE_INSTALLED_PATH";
      else {
        const pf = picked.file;
        const destPath = `${profile.installDir}/${pf.filename}`;
        file = {
          action: "replace",
          reason: "requested",
          requiredBy: [],
          projectId: lat.project_id,
          projectSlug: null,
          projectTitle: null,
          versionId: lat.id,
          versionNumber: lat.version_number,
          versionType: lat.version_type,
          loaders: lat.loaders,
          filename: pf.filename,
          url: picked.url,
          sizeBytes: pf.size,
          sha1: pf.hashes.sha1,
          sha512: picked.sha512,
          checksum: { algorithm: "sha512", value: picked.sha512 },
          destPath,
          replaces: f.path === destPath ? [] : [f.path],
        };
      }
    }
    return {
      path: f.path,
      current: cur ? { projectId: cur.project_id, versionId: cur.id, versionNumber: cur.version_number, datePublished: cur.date_published } : null,
      latest: lat ? { projectId: lat.project_id, versionId: lat.id, versionNumber: lat.version_number, versionType: lat.version_type, datePublished: lat.date_published } : null,
      updateAvailable: newer && file !== null,
      file,
      problem,
    };
  });
}
