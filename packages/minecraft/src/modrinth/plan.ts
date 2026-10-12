import type { Checksum, ServerSoftware } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import { assertAllowedUrl } from "../http.js";
import { assertModrinthId, type ModrinthClient, type UpdateFilter, type VersionType } from "./client.js";
import { isClientOnly, loaderMatch, sideSupport, type ModrinthLoaderProfile, type SideSupport } from "./loaders.js";
import type { ModrinthFileRaw, ModrinthProjectRaw, ModrinthVersionRaw } from "./schemas.js";
import { assertGameVersion, requireLoaderProfile } from "./search.js";

/** Largest file the agent's `artifact.fetch` accepts. */
export const MAX_EXTENSION_FILE_BYTES = 2 * 1024 ** 3;

export type DependencyType = "required" | "optional" | "incompatible" | "embedded" | "unknown";

export function dependencyType(raw: string): DependencyType {
  return raw === "required" || raw === "optional" || raw === "incompatible" || raw === "embedded" ? raw : "unknown";
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
  primaryFile: { filename: string; sizeBytes: number; sha1: string; sha512: string | null } | null;
}

export interface CompatibilityTarget {
  software: ServerSoftware;
  /** Required unless the software is Velocity. */
  minecraftVersion: string | null;
}

export interface VersionCompatibility {
  loader: "match" | "warning" | "none";
  gameVersion: boolean;
  listed: boolean;
}

export function versionCompatibility(v: ModrinthVersionRaw, profile: ModrinthLoaderProfile, minecraftVersion: string | null): VersionCompatibility {
  return {
    loader: loaderMatch(profile, v.loaders),
    gameVersion: !profile.filterGameVersion || minecraftVersion === null || v.game_versions.includes(minecraftVersion),
    listed: v.status === undefined || v.status === "listed",
  };
}

const TYPE_RANK: Record<string, number> = { release: 0, beta: 1, alpha: 2 };

/**
 * Best version for the server: compatible loader and game version, listed; prefers a full loader
 * match over a warning match, then releases over betas over alphas, then the newest.
 */
export function pickModrinthVersion(
  versions: readonly ModrinthVersionRaw[],
  profile: ModrinthLoaderProfile,
  minecraftVersion: string | null,
  opts: { allowPrerelease?: boolean } = {},
): ModrinthVersionRaw | null {
  const allowPre = opts.allowPrerelease ?? true;
  const candidates = versions.filter((v) => {
    const c = versionCompatibility(v, profile, minecraftVersion);
    if (c.loader === "none" || !c.gameVersion || !c.listed) return false;
    if (!allowPre && v.version_type !== "release") return false;
    return TYPE_RANK[v.version_type] !== undefined;
  });
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

/** A Modrinth filename that is safe as a single path component and is a `.jar`. */
export function isSafeJarFilename(name: string): boolean {
  return (
    name.length >= 5 &&
    name.length <= 255 &&
    !UNSAFE_FILENAME.test(name) &&
    !name.startsWith(".") &&
    !name.endsWith(" ") &&
    name.toLowerCase().endsWith(".jar")
  );
}

export type FileProblem = "NO_JAR" | "UNSAFE_FILENAME" | "URL_NOT_ALLOWED" | "TOO_LARGE";

/** Primary `.jar` of a version (the only jar when none is flagged primary), validated. */
export function primaryJarFile(v: ModrinthVersionRaw, cdnHosts: readonly string[]): { file: ModrinthFileRaw } | { problem: FileProblem } {
  const jars = v.files.filter((f) => f.filename.toLowerCase().endsWith(".jar"));
  const file = v.files.find((f) => f.primary && jars.includes(f)) ?? (jars.length === 1 ? jars[0] : undefined) ?? jars.find((f) => f.file_type === null || f.file_type === undefined);
  if (!file) return { problem: "NO_JAR" };
  if (!isSafeJarFilename(file.filename)) return { problem: "UNSAFE_FILENAME" };
  try {
    assertAllowedUrl(file.url, cdnHosts, "artifact");
  } catch {
    return { problem: "URL_NOT_ALLOWED" };
  }
  if (file.size > MAX_EXTENSION_FILE_BYTES) return { problem: "TOO_LARGE" };
  return { file };
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
    dependencies: v.dependencies.map((d) => ({
      type: dependencyType(d.dependency_type),
      projectId: d.project_id ?? null,
      versionId: d.version_id ?? null,
      fileName: d.file_name ?? null,
    })),
    primaryFile: "file" in f ? { filename: f.file.filename, sizeBytes: f.file.size, sha1: f.file.hashes.sha1, sha512: f.file.hashes.sha512 ?? null } : null,
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

/** Versions of a project that can run on the server (newest first), for a version picker. */
export async function listCompatibleVersions(client: ModrinthClient, project: string, target: CompatibilityTarget): Promise<ModrinthVersionSummary[]> {
  const profile = requireLoaderProfile(target.software);
  const mc = targetVersion(target, profile);
  const versions = await client.listVersions(project, versionFilter(profile, mc));
  return versions
    .map((v) => summarizeVersion(v, profile, mc, client.cdnHosts))
    .filter((s) => s.loaderMatch !== "none" && s.gameVersionMatch)
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
  | "INCOMPATIBLE_INSTALLED"
  | "INCOMPATIBLE_IN_PLAN"
  | "DEPENDENCY_UNRESOLVED"
  | "DEPENDENCY_EXTERNAL_FILE"
  | "DEPENDENCY_LIMIT"
  | "DEPENDENCY_PIN_IGNORED"
  | "DEPENDENCY_ALREADY_INSTALLED"
  | "OPTIONAL_DEPENDENCY"
  | "EMBEDDED_DEPENDENCY"
  | "UNKNOWN_DEPENDENCY_TYPE"
  | "NO_SHA512"
  | "NO_INSTALLABLE_FILE";

/** `error` blocks the plan (`installable: false`); `warning` needs the administrator's attention. */
export interface PlanWarning {
  code: PlanWarningCode;
  level: "info" | "warning" | "error";
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
  /** cdn.modrinth.com URL. */
  url: string;
  sizeBytes: number;
  sha1: string;
  sha512: string | null;
  /** Checksum for `artifact.fetch` (SHA-512, SHA-1 only when Modrinth has no SHA-512). */
  checksum: Checksum;
  /** `plugins/<filename>` or `mods/<filename>`. */
  destPath: string;
  /** Installed files of the same project to delete after a successful fetch (update/downgrade). */
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
  /** Optional dependencies that are neither installed nor planned (offer them in the UI). */
  optionalDependencies: Array<{ projectId: string; slug: string | null; title: string | null; requiredBy: string }>;
  warnings: PlanWarning[];
  /** False when any warning has level `error`. */
  installable: boolean;
}

export interface ModrinthInstallRequest extends CompatibilityTarget {
  /** Project id or slug. */
  project: string;
  /** Pin a version id; default: best compatible version. */
  versionId?: string | null;
  installed?: readonly InstalledExtensionRef[];
  /** Optional dependencies (project ids) the administrator opted into. */
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

function hashesOf(i: InstalledExtensionRef): string[] {
  const out: string[] = [];
  if (i.sha1) out.push(i.sha1.toLowerCase());
  if (i.sha512) out.push(i.sha512.toLowerCase());
  return out;
}

/**
 * Plans the installation of a Modrinth project on a server: picks the version, resolves required
 * dependencies for the same loader/game version (cycle-safe, bounded by `maxFiles`/`maxDepth`),
 * validates every file (cdn.modrinth.com, safe `.jar` filename, size), and reports client-only,
 * incompatible, already-installed and unresolved items.
 */
export async function planModrinthInstall(client: ModrinthClient, req: ModrinthInstallRequest): Promise<ModrinthInstallPlan> {
  const profile = requireLoaderProfile(req.software);
  const mc = targetVersion(req, profile);
  const maxFiles = Math.min(Math.max(req.maxFiles ?? 32, 1), 128);
  const maxDepth = Math.min(Math.max(req.maxDepth ?? 8, 0), 16);
  const includeOptional = new Set(req.includeOptional ?? []);
  const installed = req.installed ?? [];
  const filter = versionFilter(profile, mc);
  const pickOpts = req.allowPrerelease === undefined ? {} : { allowPrerelease: req.allowPrerelease };

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
  const label = (projectId: string) => projects.get(projectId)?.title ?? projectId;
  const versionCache = new Map<string, ModrinthVersionRaw>();
  const fetchVersion = async (id: string) => {
    const hit = versionCache.get(id);
    if (hit) return hit;
    const v = await client.getVersion(id);
    versionCache.set(id, v);
    return v;
  };

  const fetchVersionOrNull = async (id: string) => {
    try {
      return await fetchVersion(id);
    } catch (err) {
      if (err instanceof CatalogError && err.code === "NOT_FOUND") return null;
      throw err;
    }
  };

  let rootVersion: ModrinthVersionRaw | null;
  if (req.versionId) {
    rootVersion = await fetchVersion(assertModrinthId(req.versionId, "version id"));
    if (rootVersion.project_id !== rootProject.id) throw new CatalogError("INVALID_ARGUMENT", "the version does not belong to the project");
    const c = versionCompatibility(rootVersion, profile, mc);
    if (c.loader === "none") warn("VERSION_MISMATCH", "error", `${rootProject.title} ${rootVersion.version_number} is not built for ${req.software} (${rootVersion.loaders.join(", ")})`, rootProject.id, rootVersion.id);
    else if (!c.gameVersion) warn("VERSION_MISMATCH", "warning", `${rootProject.title} ${rootVersion.version_number} does not list Minecraft ${mc}`, rootProject.id, rootVersion.id);
  } else {
    rootVersion = pickModrinthVersion(await client.listVersions(rootProject.id, filter), profile, mc, pickOpts);
    if (!rootVersion) throw new CatalogError("UNAVAILABLE", `${rootProject.title} has no version for ${req.software}${mc ? ` ${mc}` : ""}`);
  }

  const nodes = new Map<string, Node>();
  const order: Node[] = [];
  const optional = new Map<string, string>(); // projectId → requiredBy
  const incompatible: Array<{ by: string; projectId: string }> = [];
  const mentioned = new Set<string>();
  const deferred: Array<() => void> = [];
  const later = (fn: () => void) => deferred.push(fn);

  const resolveDependency = async (projectId: string, pinned: string | null): Promise<ModrinthVersionRaw | null> => {
    if (pinned) {
      const v = await fetchVersionOrNull(pinned);
      if (v) {
        const c = versionCompatibility(v, profile, mc);
        if (v.project_id === projectId && c.loader !== "none" && c.gameVersion) return v;
      }
      const pinnedLabel = v ? v.version_number : pinned;
      later(() => warn("DEPENDENCY_PIN_IGNORED", "info", `the pinned version ${pinnedLabel} of ${label(projectId)} does not fit this server; using the newest compatible version instead`, projectId, pinned));
    }
    return pickModrinthVersion(await client.listVersions(projectId, filter), profile, mc, pickOpts);
  };

  const visit = async (node: Node): Promise<void> => {
    for (const dep of node.version.dependencies) {
      const type = dependencyType(dep.dependency_type);
      let projectId = dep.project_id ?? null;
      if (!projectId && dep.version_id) projectId = (await fetchVersionOrNull(dep.version_id))?.project_id ?? null;
      if (!projectId) {
        if (dep.file_name && (type === "required" || type === "optional")) {
          later(() => warn("DEPENDENCY_EXTERNAL_FILE", type === "required" ? "warning" : "info", `${label(node.projectId)} needs a file that is not on Modrinth (${dep.file_name}); install it manually`, node.projectId, node.version.id));
        }
        continue;
      }
      if (projectId === node.projectId) continue;
      mentioned.add(projectId);
      const wanted = type === "required" || (type === "optional" && includeOptional.has(projectId));
      if (type === "embedded") {
        later(() => warn("EMBEDDED_DEPENDENCY", "info", `${label(node.projectId)} bundles ${label(projectId)}; nothing to install`, projectId, dep.version_id ?? null));
        continue;
      }
      if (type === "incompatible") {
        incompatible.push({ by: node.projectId, projectId });
        continue;
      }
      if (type === "unknown") {
        later(() => warn("UNKNOWN_DEPENDENCY_TYPE", "info", `unknown dependency type "${dep.dependency_type.slice(0, 32)}"`, projectId, null));
        continue;
      }
      if (!wanted) {
        if (!installedByProject.has(projectId) && !nodes.has(projectId) && !optional.has(projectId)) optional.set(projectId, node.projectId);
        continue;
      }
      if (installedByProject.has(projectId)) {
        later(() => warn("DEPENDENCY_ALREADY_INSTALLED", "info", `${label(node.projectId)} needs ${label(projectId)}, which is already installed`, projectId, null));
        continue;
      }
      const existing = nodes.get(projectId);
      if (existing) {
        if (existing.reason !== "requested") existing.requiredBy.add(node.projectId);
        continue;
      }
      const level = type === "required" ? "error" : "warning";
      if (node.depth + 1 > maxDepth || nodes.size >= maxFiles) {
        const reached = node.depth + 1 > maxDepth ? `depth ${maxDepth}` : `${maxFiles} files`;
        later(() => warn("DEPENDENCY_LIMIT", level, `dependency resolution stopped at ${reached}; ${label(projectId)} was not added`, projectId, null));
        continue;
      }
      const v = await resolveDependency(projectId, dep.version_id ?? null);
      if (!v) {
        later(() => warn("DEPENDENCY_UNRESOLVED", level, `${label(node.projectId)} needs ${label(projectId)}, which has no version for ${req.software}${mc ? ` ${mc}` : ""}`, projectId, null));
        continue;
      }
      const child: Node = { projectId, version: v, reason: type === "required" ? "dependency" : "optional-dependency", requiredBy: new Set([node.projectId]), depth: node.depth + 1 };
      nodes.set(projectId, child);
      await visit(child);
    }
    order.push(node);
  };

  const root: Node = { projectId: rootProject.id, version: rootVersion, reason: "requested", requiredBy: new Set(), depth: 0 };
  nodes.set(root.projectId, root);
  await visit(root);

  // Metadata for everything else we mention (titles, client-only flags), one batched request.
  const missing = [...new Set([...nodes.keys(), ...mentioned])].filter((id) => !projects.has(id));
  if (missing.length > 0) for (const p of await client.getProjects(missing)) projects.set(p.id, p);
  for (const fn of deferred) fn();

  // Installed extensions that declare themselves incompatible with something in the plan.
  const installedVersionIds = [...new Set(installed.map((i) => i.versionId).filter((id): id is string => !!id))];
  if (installedVersionIds.length > 0) {
    for (const iv of await client.getVersions(installedVersionIds)) {
      if (nodes.has(iv.project_id)) continue; // being replaced by the plan
      for (const d of iv.dependencies) {
        if (dependencyType(d.dependency_type) === "incompatible" && d.project_id && nodes.has(d.project_id)) incompatible.push({ by: iv.project_id, projectId: d.project_id });
      }
    }
  }
  for (const { by, projectId } of incompatible) {
    if (installedByProject.has(projectId) || (installedByProject.has(by) && nodes.has(projectId))) {
      const path = (installedByProject.get(projectId) ?? installedByProject.get(by))![0]!.path;
      warn("INCOMPATIBLE_INSTALLED", "error", `${label(by)} is incompatible with ${label(projectId)} (installed: ${path})`, projectId, null);
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
    if (isClientOnly({ serverSide: project?.server_side ?? null, environment: v.environment ?? null })) {
      warn("CLIENT_ONLY", "warning", `${label(node.projectId)} is marked client-side only on Modrinth and may crash or do nothing on a server`, node.projectId, v.id);
    }
    if (loaderMatch(profile, v.loaders) === "warning") {
      warn("QUILT_ON_FABRIC", "warning", `${label(node.projectId)} ${v.version_number} is built for ${v.loaders.join(", ")}; Fabric cannot load Quilt-only mods`, node.projectId, v.id);
    }
    if (v.version_type !== "release") warn("PRERELEASE", "info", `${label(node.projectId)} ${v.version_number} is a ${v.version_type} build`, node.projectId, v.id);
    if (v.status !== undefined && v.status !== "listed") warn("NOT_LISTED", "warning", `${label(node.projectId)} ${v.version_number} is ${v.status} on Modrinth`, node.projectId, v.id);

    const picked = primaryJarFile(v, client.cdnHosts);
    if ("problem" in picked) {
      warn("NO_INSTALLABLE_FILE", "error", `${label(node.projectId)} ${v.version_number} has no installable jar (${picked.problem})`, node.projectId, v.id);
      continue;
    }
    const f = picked.file;
    const hit = installedHashes.get(f.hashes.sha1) ?? (f.hashes.sha512 ? installedHashes.get(f.hashes.sha512) : undefined);
    if (hit) {
      alreadyInstalled.push({ projectId: node.projectId, versionId: v.id, path: hit.path });
      warn("ALREADY_INSTALLED", "info", `${label(node.projectId)} ${v.version_number} is already installed (${hit.path})`, node.projectId, v.id);
      continue;
    }
    const destPath = `${profile.installDir}/${f.filename}`;
    if (destPaths.has(destPath.toLowerCase())) {
      warn("FILE_CONFLICT", "error", `two planned files are named ${f.filename}`, node.projectId, v.id);
      continue;
    }
    destPaths.add(destPath.toLowerCase());
    const replaces = (installedByProject.get(node.projectId) ?? []).map((i) => i.path).filter((p) => p !== destPath);
    if (replaces.length > 0) warn("REPLACES_INSTALLED", "info", `${label(node.projectId)} replaces ${replaces.join(", ")}`, node.projectId, v.id);
    const clash = installed.find((i) => i.path.toLowerCase() === destPath.toLowerCase() && i.projectId !== node.projectId);
    if (clash) warn("FILE_CONFLICT", "warning", `${destPath} already exists and belongs to another extension; it would be overwritten`, node.projectId, v.id);
    if (!f.hashes.sha512) warn("NO_SHA512", "info", `${label(node.projectId)} ${v.version_number}: Modrinth has no SHA-512; verifying with SHA-1`, node.projectId, v.id);
    files.push({
      action: replaces.length > 0 || installedByProject.has(node.projectId) ? "replace" : "install",
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
      url: f.url,
      sizeBytes: f.size,
      sha1: f.hashes.sha1,
      sha512: f.hashes.sha512 ?? null,
      checksum: f.hashes.sha512 ? { algorithm: "sha512", value: f.hashes.sha512 } : { algorithm: "sha1", value: f.hashes.sha1 },
      destPath,
      replaces,
    });
  }

  const optionalDependencies = [...optional]
    .filter(([id]) => !nodes.has(id) && !installedByProject.has(id))
    .map(([projectId, requiredBy]) => ({ projectId, slug: projects.get(projectId)?.slug ?? null, title: projects.get(projectId)?.title ?? null, requiredBy }));
  for (const o of optionalDependencies) warn("OPTIONAL_DEPENDENCY", "info", `${label(o.requiredBy)} can use ${o.title ?? o.projectId} (optional)`, o.projectId, null);

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

/** `artifact.fetch` payload for a planned file (the control plane adds nothing but the workload id). */
export function modrinthFetchPayload(file: ModrinthPlannedFile, workloadId: string) {
  return { workloadId, url: file.url, destPath: file.destPath, checksum: file.checksum, maxBytes: file.sizeBytes, cache: true };
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
 * and adds project titles (`GET /projects`). Unknown files (uploads, other sources) get `null`.
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
  problem: FileProblem | null;
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
 * than the installed one, so a release is never "updated" to a beta). An update is offered only
 * when the newest compatible version differs from and is newer than the installed one.
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
    let lat = h ? latest.get(h.value) : undefined;
    if (lat && cur && lat.project_id !== cur.project_id) lat = undefined;
    if (lat) {
      const c = versionCompatibility(lat, profile, mc);
      const types = cur ? allowedUpdateTypes(cur.version_type, opts.allowPrerelease) : undefined;
      if (c.loader === "none" || !c.gameVersion || (types && !types.includes(lat.version_type as VersionType))) lat = undefined;
    }
    const newer = !!(cur && lat && lat.id !== cur.id && (Date.parse(lat.date_published) || 0) > (Date.parse(cur.date_published) || 0));
    let file: ModrinthPlannedFile | null = null;
    let problem: FileProblem | null = null;
    if (newer && lat) {
      const picked = primaryJarFile(lat, client.cdnHosts);
      if ("problem" in picked) problem = picked.problem;
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
          url: pf.url,
          sizeBytes: pf.size,
          sha1: pf.hashes.sha1,
          sha512: pf.hashes.sha512 ?? null,
          checksum: pf.hashes.sha512 ? { algorithm: "sha512", value: pf.hashes.sha512 } : { algorithm: "sha1", value: pf.hashes.sha1 },
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
