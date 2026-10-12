import { z } from "zod";
import { Bytes, EpochMs, Id, PageQuery, Sha1Hex, Sha512Hex, page } from "../common.js";
import type { Permission } from "../permissions.js";
import { ServerSoftware } from "./servers.js";
import { TransferUrlResponse } from "./files.js";

/**
 * Plugins & mods (Phase 4b): `/servers/:id/extensions/*`.
 *
 * Extensions are the `.jar` files in the server's install directory — `plugins/` (Paper, Purpur, Folia,
 * Spigot, Velocity) or `mods/` (Fabric, Forge, NeoForge); vanilla and non-Minecraft servers have none.
 * `x.jar.disabled` is a disabled extension. The control plane learns what is installed by scanning the
 * directory (`fs.list` → `fs.hash` → `jar.readEntries`, incremental by size + mtime), identifies files on
 * Modrinth by SHA-512, and installs Modrinth files with `artifact.fetch` (SHA-512 verified, CDN allowlist).
 *
 * Trust: every string that comes from Modrinth, from a jar (metadata files) or from the file system is
 * untrusted text — render it as text, never as HTML/Markdown, and open links with `rel="noopener noreferrer"`.
 * The control plane truncates upstream values to the caps below and only passes `https://` links on.
 *
 * Changes never hot-reload anything: plugins/mods load at server start, so a mutation answers
 * `restartRequired: true` whenever the server is not stopped/crashed.
 */

/**
 * Permission checked for extension *reads* (list, search, project, plan, updates, history). Mutations need
 * `servers.extensions.manage`. Proposed: a separate `servers.extensions.view` (would also reach the observer
 * role); switching is a one-line change here.
 */
export const EXTENSIONS_READ_PERMISSION: Permission = "servers.extensions.manage";
export const EXTENSIONS_MANAGE_PERMISSION: Permission = "servers.extensions.manage";

export const ExtensionKind = z.enum(["plugin", "mod"]);
export type ExtensionKind = z.infer<typeof ExtensionKind>;
/** `unknown` = found on disk (file manager, SFTP, a plugin's own updater) and not identified on Modrinth. */
export const ExtensionSource = z.enum(["modrinth", "upload", "unknown"]);
export type ExtensionSource = z.infer<typeof ExtensionSource>;
export const ExtensionInstallDir = z.enum(["plugins", "mods"]);
export type ExtensionInstallDir = z.infer<typeof ExtensionInstallDir>;

/** Path of an installed extension: `plugins/<name>.jar` or `mods/<name>.jar[.disabled]`. */
export const ExtensionPath = z.string().max(300).regex(/^(plugins|mods)\/[^/\\\0]+$/, "plugins/<file> or mods/<file>");

// ---------------------------------------------------------------------------------------------
// Shared primitives

/** Modrinth base62 id (projects, versions); the API uses 8 characters today, the library accepts 1–16. */
export const ModrinthId = z.string().regex(/^[A-Za-z0-9]{1,16}$/, "Modrinth id");
export type ModrinthId = z.infer<typeof ModrinthId>;
/** Project id or slug as accepted in a URL path (same rule as the library's `assertProjectRef`). */
export const ModrinthProjectRef = z
  .string()
  .regex(/^[A-Za-z0-9_!@$()+,'.-]{1,64}$/, "Modrinth project id or slug")
  .refine((s) => !/^\.+$/.test(s), "Modrinth project id or slug");
/** Category tag filter (`utility`, `game-mechanics`, …); a subset of the library's tag grammar. */
export const ModrinthCategoryTag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "category tag");
export const ModrinthVersionType = z.enum(["release", "beta", "alpha"]);
export type ModrinthVersionType = z.infer<typeof ModrinthVersionType>;
/** Modrinth side support (`client_side` / `server_side`); upstream values outside the list → `unknown`. */
export const SideSupport = z.enum(["required", "optional", "unsupported", "unknown"]);

const isHttpsWithoutCredentials = (raw: string, host?: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && (host === undefined || (u.host === host && u.port === ""));
  } catch {
    return false;
  }
};
/** An `https://` link without credentials (upstream homepages, source/issue/wiki links). */
export const HttpsLink = z.string().max(2048).refine((s) => isHttpsWithoutCredentials(s), "https:// link");
/** File or icon URL on the Modrinth CDN (`https://cdn.modrinth.com/…`, default port, no credentials). */
export const ModrinthCdnUrl = z
  .string()
  .max(2048)
  .refine((s) => isHttpsWithoutCredentials(s, "cdn.modrinth.com"), "https://cdn.modrinth.com URL");
/** `https://modrinth.com/…` page link. */
export const ModrinthPageUrl = z
  .string()
  .max(2048)
  .refine((s) => isHttpsWithoutCredentials(s, "modrinth.com"), "https://modrinth.com URL");

/** Path separators, Windows-reserved characters, control/format characters, line/paragraph separators. */
const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/**
 * A `.jar` file name that is a safe single path component on Linux and Windows — the same rule as the
 * library's `isSafeJarFilename` (5–255 characters, no separators/reserved/control characters, no leading
 * `.`, no trailing space or `.`, not a Windows device name such as `CON.jar`).
 */
export const isSafeJarFilename = (name: string): boolean => {
  if (name.length < 5 || name.length > 255 || UNSAFE_FILENAME_CHARS.test(name)) return false;
  if (name.startsWith(".") || name.endsWith(" ") || name.endsWith(".")) return false;
  if (!name.toLowerCase().endsWith(".jar")) return false;
  return !WINDOWS_DEVICE.test(name.split(".")[0]!.trimEnd());
};
export const SafeJarFilename = z.string().max(255).refine(isSafeJarFilename, "a safe .jar file name");

// ---------------------------------------------------------------------------------------------
// Jar metadata and compatibility

export const ExtensionFormat = z.enum(["bukkit", "paper", "velocity", "bungeecord", "fabric", "quilt", "forge", "neoforge"]);
export type ExtensionFormat = z.infer<typeof ExtensionFormat>;
export const ExtensionDependencyKind = z.enum(["required", "optional", "incompatible", "discouraged", "load-before"]);

/**
 * Normalised metadata of one plugin/mod declared inside a jar (`plugin.yml`, `paper-plugin.yml`,
 * `velocity-plugin.json`, `bungee.yml`, `fabric.mod.json`, `quilt.mod.json`, `META-INF/[neoforge.]mods.toml`).
 * All strings are untrusted single-line text; lists are truncated to the caps.
 */
export const ExtensionMetadataView = z.object({
  format: ExtensionFormat,
  /** Plugin name (also what other plugins depend on) or mod id. */
  id: z.string().max(128),
  name: z.string().max(128),
  version: z.string().max(256).nullable(),
  description: z.string().max(1024).nullable(),
  authors: z.array(z.string().max(128)).max(32),
  /** Fabric `environment`; null elsewhere (unknown). */
  environment: z.enum(["client", "server", "both"]).nullable(),
  dependencies: z
    .array(
      z.object({
        id: z.string().max(128),
        kind: ExtensionDependencyKind,
        versionRange: z.string().max(1024).nullable(),
        /** Forge/NeoForge `side`; null elsewhere. */
        side: z.enum(["both", "client", "server"]).nullable(),
      }),
    )
    .max(128),
  /** Bukkit/Paper `api-version`, Fabric `depends.minecraft`, Forge/NeoForge minecraft range. */
  minecraftVersion: z.string().max(1024).nullable(),
  /** Fabric loader / Forge / NeoForge loader ranges. */
  loaderVersion: z.string().max(1024).nullable(),
  /** Bukkit/Paper `folia-supported` (null when absent). */
  foliaSupported: z.boolean().nullable(),
  /** Main class / entrypoint (informational). */
  entrypoint: z.string().max(512).nullable(),
  /** Bukkit `libraries`: Maven coordinates the server downloads when the plugin loads. */
  libraries: z.array(z.string().max(256)).max(64),
  /** Nested jars (Fabric `jars`), already checked to be safe relative paths. */
  bundledJars: z.array(z.string().max(512)).max(64),
  license: z.string().max(256).nullable(),
  homepage: HttpsLink.nullable(),
  /** Parser notes (missing main class, outdated schema, …). */
  warnings: z.array(z.string().max(512)).max(32),
});
export type ExtensionMetadataView = z.infer<typeof ExtensionMetadataView>;

/**
 * Compatibility problem codes (mapped by the control plane from the library's `jarCompatibility` /
 * `parseJarMetadata` results):
 * `NO_METADATA` no plugin/mod metadata in the jar · `WRONG_PLATFORM` built for other formats only ·
 * `FOLIA_UNSUPPORTED` Folia needs `folia-supported: true` · `CLIENT_ONLY` declares a client-only environment ·
 * `LEGACY_MODS_TOML` NeoForge reads `mods.toml` only before 1.20.5 · `METADATA_INVALID` a metadata file
 * could not be parsed · `METADATA_WARNING` parser warning of the selected metadata · `NO_EXTENSION_DIR` the
 * server software loads no plugins/mods.
 */
export const ExtensionProblemCode = z.enum([
  "NO_METADATA",
  "WRONG_PLATFORM",
  "FOLIA_UNSUPPORTED",
  "CLIENT_ONLY",
  "LEGACY_MODS_TOML",
  "METADATA_INVALID",
  "METADATA_WARNING",
  "NO_EXTENSION_DIR",
]);
export type ExtensionProblemCode = z.infer<typeof ExtensionProblemCode>;

export const ExtensionCompatibility = z.object({
  /** False when any problem has level `error`: the server software will not load the jar. */
  loadable: z.boolean(),
  /** Index into `InstalledExtension.metadata` of the entry the server software uses (null = none). */
  metadataIndex: z.number().int().nonnegative().nullable(),
  problems: z
    .array(z.object({ code: ExtensionProblemCode, level: z.enum(["error", "warning"]), message: z.string().max(512) }))
    .max(32),
});
export type ExtensionCompatibility = z.infer<typeof ExtensionCompatibility>;

// ---------------------------------------------------------------------------------------------
// Installed extensions

/** Modrinth identity of an installed file (from the install, or from a SHA-512 lookup during a scan). */
export const ModrinthRef = z.object({
  projectId: ModrinthId,
  /** Null when Modrinth did not return the project (deleted/hidden). */
  slug: z.string().max(64).nullable(),
  title: z.string().max(256).nullable(),
  versionId: ModrinthId,
  versionNumber: z.string().max(128),
  /** Unknown upstream values are reported as `alpha` (least stable). */
  versionType: ModrinthVersionType,
  iconUrl: ModrinthCdnUrl.nullable(),
  /** `https://modrinth.com/project/<slug or id>`. */
  pageUrl: ModrinthPageUrl,
});
export type ModrinthRef = z.infer<typeof ModrinthRef>;

export const InstalledExtension = z.object({
  id: Id,
  serverId: Id,
  kind: ExtensionKind,
  /** Current path (`….jar` or `….jar.disabled`); the id is kept across enable/disable renames. */
  path: ExtensionPath,
  /** File name on disk (untrusted, may be any name the file manager allowed). */
  filename: z.string().max(255),
  enabled: z.boolean(),
  sizeBytes: Bytes,
  /** Null until the file has been hashed. */
  sha512: Sha512Hex.nullable(),
  /** Epoch ms (like `FileEntry.modifiedAt`). */
  mtime: EpochMs,
  source: ExtensionSource,
  /** Every plugin/mod the jar declares (a Forge jar may hold several mods); empty when none was found. */
  metadata: z.array(ExtensionMetadataView).max(32),
  /** Null until the jar has been read. */
  compatibility: ExtensionCompatibility.nullable(),
  modrinth: ModrinthRef.nullable(),
  /** Set when BlockForge installed/uploaded the file; null for files found on disk. */
  installedAt: EpochMs.nullable(),
  installedBy: z.object({ id: Id, name: z.string().max(128) }).nullable(),
  firstSeenAt: EpochMs,
});
export type InstalledExtension = z.infer<typeof InstalledExtension>;

export const ExtensionScanStatus = z.object({
  status: z.enum(["never", "running", "completed", "failed"]),
  /** Completion time of the last successful scan. */
  scannedAt: EpochMs.nullable(),
  /** Running or last scan job. */
  jobId: Id.nullable(),
  error: z.string().max(1024).nullable(),
});
export type ExtensionScanStatus = z.infer<typeof ExtensionScanStatus>;

/** `GET /servers/:id/extensions` — not paginated (bounded by the 4096-file scan cap). */
export const ExtensionList = z.object({
  /** null = the server software loads no extensions (vanilla, non-Minecraft): `items` is empty. */
  installDir: ExtensionInstallDir.nullable(),
  kind: ExtensionKind.nullable(),
  items: z.array(InstalledExtension).max(4096),
  /** Jar-like entries of the install dir that are not listed (and never opened), with the reason. */
  skipped: z
    .array(
      z.object({
        name: z.string().max(255),
        reason: z.enum(["symlink", "not-a-file", "empty", "unsafe-name", "too-many"]),
      }),
    )
    .max(256),
  scan: ExtensionScanStatus,
  /** More than 4096 jars: the list is cut (sorted by file name). */
  truncated: z.boolean(),
});
export type ExtensionList = z.infer<typeof ExtensionList>;

/** `POST /servers/:id/extensions/scan` — incremental unless `full` (re-hash and re-read every file). */
export const ScanExtensionsRequest = z.object({ full: z.boolean().default(false) }).strict();

/** `PATCH /servers/:id/extensions/:extensionId` — renames `x.jar` ⇄ `x.jar.disabled`. */
export const UpdateExtensionRequest = z.object({ enabled: z.boolean() }).strict();
export const UpdateExtensionResponse = z.object({ extension: InstalledExtension, restartRequired: z.boolean() });

/** `DELETE /servers/:id/extensions/:extensionId` (synchronous: one rename into the keep area). */
export const RemoveExtensionResponse = z.object({
  restartRequired: z.boolean(),
  historyEntryId: Id,
  /** Whether the removal can be undone via the history entry (see `ExtensionHistoryEntry.rollback`). */
  rollbackAvailable: z.boolean(),
});

/** 202 body of every job-creating extension route (install, apply updates, scan, rollback). */
export const ExtensionJobResponse = z.object({ jobId: Id });

// ---------------------------------------------------------------------------------------------
// Modrinth browsing

export const ModrinthSortOrder = z.enum(["relevance", "downloads", "follows", "newest", "updated"]);

const splitList = (v: unknown): unknown => {
  if (v === undefined) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === "string" ? x.split(",") : [x]));
  return parts.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "");
};

/**
 * `GET /servers/:id/extensions/modrinth/search` query. Server software and Minecraft version come from the
 * server, never from the query. `categories` accepts a comma list and/or repeated parameters.
 */
export const ModrinthSearchQuery = z.object({
  query: z
    .string()
    .trim()
    .max(256)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, "no control characters")
    .optional(),
  categories: z.preprocess(splitList, z.array(ModrinthCategoryTag).max(8)).optional(),
  sort: ModrinthSortOrder.default("relevance"),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ModrinthSearchQuery = z.infer<typeof ModrinthSearchQuery>;

/** One search result. Hits without a loader of the server software, and client-only hits, are dropped. */
export const ModrinthSearchHit = z.object({
  projectId: ModrinthId,
  slug: z.string().max(64).nullable(),
  title: z.string().max(256),
  description: z.string().max(2048),
  author: z.string().max(128),
  /** Loader tags among the project's categories (paper, fabric, …). */
  loaders: z.array(z.string().max(64)).max(64),
  categories: z.array(z.string().max(64)).max(64),
  projectTypes: z.array(z.string().max(32)).max(16),
  downloads: z.number().int().nonnegative(),
  follows: z.number().int().nonnegative(),
  iconUrl: ModrinthCdnUrl.nullable(),
  license: z.string().max(128),
  clientSide: SideSupport,
  serverSide: SideSupport,
  clientOnly: z.boolean(),
  /** `warning` = only a loader accepted with a warning (Quilt on Fabric). */
  loaderMatch: z.enum(["match", "warning"]),
  /** Epoch ms (null when Modrinth's date is unparsable). */
  dateModified: EpochMs.nullable(),
  latestVersionId: ModrinthId.nullable(),
  /** An installed extension of this server is identified as this project. */
  installed: z.boolean(),
});
export type ModrinthSearchHit = z.infer<typeof ModrinthSearchHit>;

export const ModrinthSearchResult = z.object({
  hits: z.array(ModrinthSearchHit).max(50),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  /** Upstream count (before the local filter). */
  totalHits: z.number().int().nonnegative(),
  /** Hits of this page dropped locally (no loader of the server software, or client-only). */
  filteredOut: z.number().int().nonnegative(),
});
export type ModrinthSearchResult = z.infer<typeof ModrinthSearchResult>;

export const ModrinthProjectDetails = z.object({
  projectId: ModrinthId,
  slug: z.string().max(64),
  title: z.string().max(256),
  /** Short summary (Modrinth `description`); the long body is not proxied. */
  description: z.string().max(2048),
  projectType: z.string().max(32),
  loaders: z.array(z.string().max(64)).max(64),
  categories: z.array(z.string().max(64)).max(64),
  gameVersions: z.array(z.string().max(64)).max(4096),
  clientSide: SideSupport,
  serverSide: SideSupport,
  clientOnly: z.boolean(),
  status: z.string().max(32),
  license: z.object({ id: z.string().max(128), name: z.string().max(256), url: HttpsLink.nullable() }).nullable(),
  downloads: z.number().int().nonnegative(),
  followers: z.number().int().nonnegative(),
  iconUrl: ModrinthCdnUrl.nullable(),
  sourceUrl: HttpsLink.nullable(),
  issuesUrl: HttpsLink.nullable(),
  wikiUrl: HttpsLink.nullable(),
  pageUrl: ModrinthPageUrl,
  published: EpochMs.nullable(),
  updated: EpochMs.nullable(),
  /** Whether any loader of the project runs on this server's software. */
  compatible: z.boolean(),
});
export type ModrinthProjectDetails = z.infer<typeof ModrinthProjectDetails>;

export const ModrinthDependencyType = z.enum(["required", "optional", "incompatible", "embedded", "unknown"]);

export const ModrinthVersionSummary = z.object({
  versionId: ModrinthId,
  projectId: ModrinthId,
  name: z.string().max(256),
  versionNumber: z.string().max(128),
  versionType: ModrinthVersionType,
  status: z.string().max(32).nullable(),
  datePublished: EpochMs.nullable(),
  loaders: z.array(z.string().max(64)).max(64),
  gameVersions: z.array(z.string().max(64)).max(4096),
  /** Compatibility with this server (`none` versions are listed after compatible ones, if at all). */
  loaderMatch: z.enum(["match", "warning", "none"]),
  gameVersionMatch: z.boolean(),
  dependencies: z
    .array(
      z.object({
        type: ModrinthDependencyType,
        projectId: ModrinthId.nullable(),
        versionId: ModrinthId.nullable(),
        /** External (non-Modrinth) file name, untrusted. */
        fileName: z.string().max(256).nullable(),
      }),
    )
    .max(256),
  /** Null when the version has no installable primary jar (no jar, unsafe name, off-CDN URL, too large, no SHA-512). */
  primaryFile: z.object({ filename: SafeJarFilename, sizeBytes: Bytes, sha1: Sha1Hex, sha512: Sha512Hex }).nullable(),
});
export type ModrinthVersionSummary = z.infer<typeof ModrinthVersionSummary>;

/** `GET /servers/:id/extensions/modrinth/projects/:project` (`:project` = `ModrinthProjectRef`). */
export const ModrinthProjectResponse = z.object({
  project: ModrinthProjectDetails,
  /** ≤ 100 versions, compatible ones first, newest first within each group. */
  versions: z.array(ModrinthVersionSummary).max(100),
  /** Installed extensions of this server identified as this project. */
  installed: z.array(z.object({ extensionId: Id, versionId: ModrinthId, path: ExtensionPath })).max(16),
});
export type ModrinthProjectResponse = z.infer<typeof ModrinthProjectResponse>;

// ---------------------------------------------------------------------------------------------
// Install plans

/**
 * Plan warning codes (closed: the control plane maps library output through this enum). `error`-level
 * warnings make a plan not installable. Messages are built from upstream text (single line, bounded).
 */
export const PlanWarningCode = z.enum([
  "CLIENT_ONLY",
  "QUILT_ON_FABRIC",
  "PRERELEASE",
  "NOT_LISTED",
  "VERSION_MISMATCH",
  "ALREADY_INSTALLED",
  "REPLACES_INSTALLED",
  "FILE_CONFLICT",
  "UNSAFE_INSTALLED_PATH",
  "INCOMPATIBLE_INSTALLED",
  "INCOMPATIBLE_IN_PLAN",
  "DEPENDENCY_UNRESOLVED",
  "DEPENDENCY_EXTERNAL_FILE",
  "DEPENDENCY_LIMIT",
  "DEPENDENCY_PIN_IGNORED",
  "DEPENDENCY_PIN_CONFLICT",
  "DEPENDENCY_ALREADY_INSTALLED",
  "DEPENDENCY_INSTALLED_UNKNOWN",
  "OPTIONAL_DEPENDENCY",
  "EMBEDDED_DEPENDENCY",
  "UNKNOWN_DEPENDENCY_TYPE",
  "NO_SHA512",
  "NO_INSTALLABLE_FILE",
]);
export type PlanWarningCode = z.infer<typeof PlanWarningCode>;

export const PlanWarning = z.object({
  code: PlanWarningCode,
  level: z.enum(["info", "warning", "error"]),
  message: z.string().max(1024),
  projectId: ModrinthId.nullable(),
  versionId: ModrinthId.nullable(),
});
export type PlanWarning = z.infer<typeof PlanWarning>;

/**
 * One file of a plan (the control plane turns it into an `artifact.fetch` with a SHA-512 checksum; no
 * checksum field is exposed here). Files without SHA-512 never become planned files (`NO_SHA512` error).
 */
export const ModrinthPlannedFile = z
  .object({
    action: z.enum(["install", "replace"]),
    reason: z.enum(["requested", "dependency", "optional-dependency"]),
    /** Project ids that pulled this file in (empty for the requested project). */
    requiredBy: z.array(ModrinthId).max(128),
    projectId: ModrinthId,
    projectSlug: z.string().max(64).nullable(),
    projectTitle: z.string().max(256).nullable(),
    versionId: ModrinthId,
    versionNumber: z.string().max(128),
    versionType: ModrinthVersionType,
    loaders: z.array(z.string().max(64)).max(64),
    filename: SafeJarFilename,
    url: ModrinthCdnUrl,
    sizeBytes: Bytes.min(1).max(2 * 1024 ** 3),
    sha1: Sha1Hex,
    sha512: Sha512Hex,
    /** `<installDir>/<filename>`. */
    destPath: ExtensionPath,
    /** Installed files of the same project deleted after a verified fetch (update/downgrade). */
    replaces: z.array(ExtensionPath).max(16),
  })
  .refine((f) => f.destPath.slice(f.destPath.indexOf("/") + 1) === f.filename, {
    message: "destPath must be <installDir>/<filename>",
    path: ["destPath"],
  });
export type ModrinthPlannedFile = z.infer<typeof ModrinthPlannedFile>;

export const ModrinthInstallPlan = z.object({
  software: ServerSoftware,
  minecraftVersion: z.string().max(64).nullable(),
  installDir: ExtensionInstallDir,
  root: z.object({
    projectId: ModrinthId,
    slug: z.string().max(64),
    title: z.string().max(256),
    versionId: ModrinthId,
    versionNumber: z.string().max(128),
  }),
  /** Files to fetch, dependencies before dependants. */
  files: z.array(ModrinthPlannedFile).max(128),
  /** Planned versions whose exact bytes are already on the server (not re-fetched). */
  alreadyInstalled: z.array(z.object({ projectId: ModrinthId, versionId: ModrinthId, path: ExtensionPath })).max(128),
  /** Optional dependencies neither installed nor planned; opt in with `includeOptional` (project or version id). */
  optionalDependencies: z
    .array(
      z.object({
        projectId: ModrinthId.nullable(),
        versionId: ModrinthId.nullable(),
        slug: z.string().max(64).nullable(),
        title: z.string().max(256).nullable(),
        requiredBy: ModrinthId,
      }),
    )
    .max(128),
  warnings: z.array(PlanWarning).max(512),
  /** False when any warning has level `error`. */
  installable: z.boolean(),
  /** The server is not stopped: the files take effect at the next (re)start. */
  restartRequired: z.boolean(),
});
export type ModrinthInstallPlan = z.infer<typeof ModrinthInstallPlan>;

/** `POST /servers/:id/extensions/modrinth/plan` (read-only: plans against the current scan). */
export const ModrinthPlanRequest = z
  .object({
    project: ModrinthProjectRef,
    /** Pin a version; default: the best compatible version. */
    versionId: ModrinthId.optional(),
    /** Optional dependencies to include (project ids, or version ids when only those are known). */
    includeOptional: z.array(ModrinthId).max(32).default([]),
    /** Allow beta/alpha builds (also when picking dependencies). Default false (the library defaults to true). */
    allowPrerelease: z.boolean().default(false),
    /**
     * Administrator override for an explicit `versionId` that does not list the server's Minecraft version,
     * is unlisted, or is a prerelease without `allowPrerelease` — a warning instead of an error. A loader
     * mismatch is always an error. Same name and meaning as the library option.
     */
    allowIncompatibleVersion: z.boolean().default(false),
  })
  .strict();
export type ModrinthPlanRequest = z.infer<typeof ModrinthPlanRequest>;

/**
 * `POST /servers/:id/extensions/modrinth/install` (202, `Idempotency-Key`). The control plane re-plans at
 * install time; when the fresh plan is not installable or its files differ from `expect` (as a set of
 * projectId + versionId + action) it answers 409 `CONFLICT` with `ModrinthPlanChangedDetails`.
 */
export const ModrinthInstallRequest = ModrinthPlanRequest.extend({
  expect: z
    .array(z.object({ projectId: ModrinthId, versionId: ModrinthId, action: z.enum(["install", "replace"]) }).strict())
    .min(1)
    .max(64),
}).strict();
export type ModrinthInstallRequest = z.infer<typeof ModrinthInstallRequest>;
export const ModrinthPlanChangedDetails = z.object({ reason: z.literal("plan_changed"), plan: ModrinthInstallPlan });

// ---------------------------------------------------------------------------------------------
// Updates

/** Why an available update cannot be applied (library `FileProblem`). */
export const ExtensionUpdateProblem = z.enum(["NO_JAR", "UNSAFE_FILENAME", "URL_NOT_ALLOWED", "TOO_LARGE", "NO_SHA512"]);

export const ExtensionUpdateStatus = z.object({
  extensionId: Id,
  path: ExtensionPath,
  /** Null = not identified on Modrinth (uploads, unknown files): no update check possible. */
  current: z
    .object({
      projectId: ModrinthId,
      versionId: ModrinthId,
      versionNumber: z.string().max(128),
      datePublished: EpochMs.nullable(),
    })
    .nullable(),
  latest: z
    .object({
      projectId: ModrinthId,
      versionId: ModrinthId,
      versionNumber: z.string().max(128),
      versionType: ModrinthVersionType,
      datePublished: EpochMs.nullable(),
    })
    .nullable(),
  updateAvailable: z.boolean(),
  /** Ready-to-run replacement when an update is available and installable. */
  file: ModrinthPlannedFile.nullable(),
  problem: ExtensionUpdateProblem.nullable(),
});
export type ExtensionUpdateStatus = z.infer<typeof ExtensionUpdateStatus>;

/**
 * `GET /servers/:id/extensions/updates?allowPrerelease=` — never offers a less stable version type than the
 * installed one unless `allowPrerelease`.
 */
export const ExtensionUpdatesQuery = z.object({ allowPrerelease: z.stringbool().default(false) });
export const ExtensionUpdatesResponse = z.object({
  checkedAt: EpochMs,
  items: z.array(ExtensionUpdateStatus).max(4096),
});
export type ExtensionUpdatesResponse = z.infer<typeof ExtensionUpdatesResponse>;

/**
 * `POST /servers/:id/extensions/updates/apply` (202, `Idempotency-Key`). Each update is re-planned with its
 * target version pinned (new required dependencies are resolved); extensions whose plan is not installable
 * fail individually and are reported in the job result.
 */
export const ApplyExtensionUpdatesRequest = z
  .object({
    extensionIds: z.array(Id).min(1).max(64).refine((ids) => new Set(ids).size === ids.length, "duplicate id"),
    allowPrerelease: z.boolean().default(false),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Uploads

export const MAX_EXTENSION_UPLOAD_BYTES = 256 * 1024 ** 2;

/**
 * `POST /servers/:id/extensions/uploads`. The bytes are PUT to the returned transfer URL and land in the
 * staging file `.blockforge/extensions/uploads/<uploadId>.jar.part` inside the data root — outside the
 * install directory, so no loader can pick it up, and excluded from backups. Staged uploads that are not
 * completed within 1 hour are deleted.
 */
export const ExtensionUploadRequest = z
  .object({
    filename: SafeJarFilename.refine((n) => n.length <= 128, "at most 128 characters"),
    sizeBytes: Bytes.min(1).max(MAX_EXTENSION_UPLOAD_BYTES),
  })
  .strict();
export const ExtensionUploadResponse = TransferUrlResponse.extend({ uploadId: Id });

/** `POST /servers/:id/extensions/uploads/:uploadId/complete` — validates the staged jar and moves it into place. */
export const CompleteExtensionUploadRequest = z
  .object({
    /** Replace an existing file with the same name (it is kept for rollback like a removal). */
    replaceExisting: z.boolean().default(false),
    /** Install even when `compatibility.loadable` is false (never overrides `requireMetadata`). */
    allowIncompatible: z.boolean().default(false),
  })
  .strict();

export const ExtensionUploadWarningCode = z.enum([
  /** A file with the same name was replaced (`replaceExisting`). */
  "REPLACED_EXISTING",
  /** Installed although not loadable (`allowIncompatible`). */
  "INCOMPATIBLE_ALLOWED",
  /** Another installed jar declares the same plugin name / mod id (the server loads only one, or refuses both). */
  "DUPLICATE_ID",
  /** No metadata found; installed because the policy does not require it. */
  "NO_METADATA",
]);
export const CompleteExtensionUploadResponse = z.object({
  extension: InstalledExtension,
  compatibility: ExtensionCompatibility,
  warnings: z
    .array(z.object({ code: ExtensionUploadWarningCode, level: z.enum(["info", "warning"]), message: z.string().max(512) }))
    .max(32),
  restartRequired: z.boolean(),
});

/**
 * `details` of a refused upload: 422 `PRECONDITION_FAILED` for `not_a_jar` (no readable zip central
 * directory), `no_metadata` (policy `requireMetadata`), `incompatible` (not loadable, no `allowIncompatible`),
 * `size_mismatch` (staged size differs from the announced `sizeBytes`), `uploads_disabled` (policy, also on
 * `POST …/uploads`); 409 `CONFLICT` for `exists` (a file with that name exists and `replaceExisting` is false).
 */
export const ExtensionUploadRejectedDetails = z.object({
  reason: z.enum(["not_a_jar", "no_metadata", "incompatible", "size_mismatch", "uploads_disabled", "exists"]),
  compatibility: ExtensionCompatibility.nullable(),
  /** For `exists`. */
  existing: z.object({ extensionId: Id.nullable(), path: ExtensionPath }).nullable(),
});

/**
 * Global policy for the upload route (`GET|PUT /settings/extensions.uploads`, settings.manage). It governs
 * only `/extensions/uploads`: holders of `servers.files.write` / SFTP can still place jars directly; such
 * files appear as `source: "unknown"` after the next scan.
 */
export const EXTENSION_UPLOAD_SETTINGS_KEY = "extensions.uploads";
export const ExtensionUploadSettings = z.object({
  allowed: z.boolean().default(true),
  /** Refuse jars without any plugin/mod metadata (`no_metadata`). */
  requireMetadata: z.boolean().default(true),
});
export type ExtensionUploadSettings = z.infer<typeof ExtensionUploadSettings>;

// ---------------------------------------------------------------------------------------------
// History and rollback

export const ExtensionHistoryAction = z.enum(["install", "update", "remove", "rollback", "enable", "disable", "upload"]);
export type ExtensionHistoryAction = z.infer<typeof ExtensionHistoryAction>;

/** State of an extension before (`from`) or after (`to`) a change. */
export const ExtensionFileSnapshot = z.object({
  source: ExtensionSource,
  path: ExtensionPath,
  projectId: ModrinthId.nullable(),
  versionId: ModrinthId.nullable(),
  versionNumber: z.string().max(256).nullable(),
  sha512: Sha512Hex.nullable(),
  sizeBytes: Bytes.nullable(),
});
export type ExtensionFileSnapshot = z.infer<typeof ExtensionFileSnapshot>;

export const ExtensionHistoryActor = z.object({
  type: z.enum(["user", "api_token", "schedule", "system"]),
  /** User id (also for API tokens: the owning user), schedule id, or null for the system. */
  id: Id.nullable(),
  name: z.string().max(128).nullable(),
});

export const ExtensionHistoryEntry = z.object({
  id: Id,
  serverId: Id,
  action: ExtensionHistoryAction,
  /** Null once the extension row is gone (removed and not restored). */
  extensionId: Id.nullable(),
  /** Display name at the time (metadata name, Modrinth title or file name; untrusted). */
  extensionName: z.string().max(256),
  path: ExtensionPath,
  /** Null for install/upload of a new file. */
  from: ExtensionFileSnapshot.nullable(),
  /** Null for remove. */
  to: ExtensionFileSnapshot.nullable(),
  actor: ExtensionHistoryActor,
  at: EpochMs,
  jobId: Id.nullable(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().max(1024).nullable(),
  /**
   * Whether `POST …/history/:entryId/rollback` can restore `from` (or remove `to` when `from` is null).
   * Only the latest succeeded entry of an extension path can be rolled back (`superseded` otherwise);
   * enable/disable are undone with PATCH (`not_supported`); a kept file that expired or no longer matches
   * its SHA-512 makes a non-Modrinth `from` unrestorable (`file_unavailable`).
   */
  rollback: z.object({
    available: z.boolean(),
    reason: z.enum(["not_supported", "failed_entry", "superseded", "file_unavailable"]).nullable(),
  }),
});
export type ExtensionHistoryEntry = z.infer<typeof ExtensionHistoryEntry>;

/** `GET /servers/:id/extensions/history?limit&cursor&extensionId` → `Page<ExtensionHistoryEntry>`, newest first. */
export const ExtensionHistoryQuery = PageQuery.extend({ extensionId: Id.optional() });
export const ExtensionHistoryPage = page(ExtensionHistoryEntry);

/** `details` of 409 `CONFLICT` when a rollback is not (or no longer) possible. */
export const ExtensionRollbackUnavailableDetails = z.object({
  reason: z.literal("rollback_unavailable"),
  cause: z.enum(["not_supported", "failed_entry", "superseded", "file_unavailable"]),
});

// ---------------------------------------------------------------------------------------------
// Realtime

/**
 * `extensions.updated` on `server:<id>`: the extension list (or the scan status) changed. `changed` lists
 * the affected extension ids (re-read them with `GET …/extensions/:extensionId`; 404 = removed); null means
 * "many / unknown" — refetch the whole list. History changes are covered by the same event.
 */
export const ExtensionsUpdatedEvent = z.object({
  serverId: Id,
  scan: ExtensionScanStatus,
  changed: z.array(Id).max(256).nullable(),
});
export type ExtensionsUpdatedEvent = z.infer<typeof ExtensionsUpdatedEvent>;
