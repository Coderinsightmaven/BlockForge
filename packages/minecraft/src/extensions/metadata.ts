import type { ExtensionProblemCode, ServerSoftware } from "@blockforge/contracts";
import { parse as parseToml } from "smol-toml";
import { isMap, isScalar, parseDocument, type Document } from "yaml";
import { isSafeJarFilename, isWindowsReservedName } from "../modrinth/plan.js";

/**
 * Parsers for the metadata files inside plugin/mod jars. The control plane reads these small
 * entries from a jar (future agent command) and passes their text here; nothing is executed or
 * loaded. All input is untrusted: sizes are capped, YAML aliases are bounded, unknown shapes
 * produce `warnings` instead of exceptions, and every string is length-limited.
 */

export type ExtensionFormat = "bukkit" | "paper" | "velocity" | "bungeecord" | "fabric" | "quilt" | "forge" | "neoforge";

/** Jar entries worth reading (≤ 256 KiB each) to identify a plugin/mod. */
export const EXTENSION_METADATA_ENTRIES = [
  "paper-plugin.yml",
  "plugin.yml",
  "velocity-plugin.json",
  "bungee.yml",
  "fabric.mod.json",
  "quilt.mod.json",
  "META-INF/neoforge.mods.toml",
  "META-INF/mods.toml",
  "META-INF/MANIFEST.MF",
] as const;

export const MAX_METADATA_BYTES = 256 * 1024;

export type DependencyKind = "required" | "optional" | "incompatible" | "discouraged" | "load-before";

export interface ExtensionDependency {
  /** Plugin name / mod id as written in the file. */
  id: string;
  kind: DependencyKind;
  versionRange: string | null;
  /** Forge/NeoForge `side`; null elsewhere. */
  side: "both" | "client" | "server" | null;
}

/** Proposed DTO: normalised plugin/mod metadata from one jar entry. Strings are untrusted text. */
export interface ExtensionMetadata {
  format: ExtensionFormat;
  /** Plugin name (Bukkit/Paper — also the id other plugins depend on) or mod id. */
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  authors: string[];
  /** Where the code runs: Fabric `environment`, otherwise null (unknown). */
  environment: "client" | "server" | "both" | null;
  dependencies: ExtensionDependency[];
  /** Bukkit/Paper `api-version`, Fabric `depends.minecraft`, Forge/NeoForge minecraft range. */
  minecraftVersion: string | null;
  /** Fabric `fabricloader`, Forge/NeoForge `loaderVersion` + forge/neoforge range. */
  loaderVersion: string | null;
  /** Bukkit/Paper `folia-supported` (null when absent). */
  foliaSupported: boolean | null;
  /** Main class / entrypoint (informational). */
  entrypoint: string | null;
  /** Bukkit `libraries`: Maven coordinates the server downloads at load time. */
  libraries: string[];
  /** Nested jars (Fabric `jars`). */
  bundledJars: string[];
  license: string | null;
  /** https:// link only. */
  homepage: string | null;
  warnings: string[];
}

export class ExtensionMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionMetadataError";
  }
}

const MAX_STR = 1024;
const MAX_LIST = 256;
/** Line-breaking whitespace (CR, LF, TAB, VT, FF, NEL, LS, PS) — replaced by a space. */
const LINE_BREAKS = /[\t\n\r\v\f\u0085\u2028\u2029]+/g;
/** Other control and format (bidi) characters — removed. */
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

function clean(v: unknown, max = MAX_STR): string | null {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    // Single line: metadata text ends up in UI rows and log-like contexts.
    const s = String(v).replace(LINE_BREAKS, " ").replace(CONTROL, "").replace(/ {2,}/g, " ").trim();
    if (s === "") return null;
    return s.length > max ? s.slice(0, max) : s;
  }
  return null;
}

function stringList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out: string[] = [];
  for (const x of arr.slice(0, MAX_LIST)) {
    const s = clean(x);
    if (s) out.push(s);
  }
  return out;
}

function httpsLink(v: unknown): string | null {
  const s = clean(v, 2048);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

function checkSize(text: string): void {
  if (text.length > MAX_METADATA_BYTES) throw new ExtensionMetadataError("metadata file too large");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Own-property read (input objects come from JSON/YAML/TOML parsers; never trust the prototype chain). */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function blank(format: ExtensionFormat, id: string, name: string): ExtensionMetadata {
  return {
    format,
    id,
    name,
    version: null,
    description: null,
    authors: [],
    environment: null,
    dependencies: [],
    minecraftVersion: null,
    loaderVersion: null,
    foliaSupported: null,
    entrypoint: null,
    libraries: [],
    bundledJars: [],
    license: null,
    homepage: null,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------------------------
// YAML (plugin.yml / paper-plugin.yml / bungee.yml)

function parseYaml(text: string): { doc: Document; root: Record<string, unknown> } {
  checkSize(text);
  const doc = parseDocument(text.replace(/^\uFEFF/, ""), { prettyErrors: false, uniqueKeys: false });
  if (doc.errors.length > 0) throw new ExtensionMetadataError(`invalid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  let root: unknown;
  try {
    root = doc.toJS({ maxAliasCount: 64 }) as unknown;
  } catch {
    throw new ExtensionMetadataError("YAML aliases expand too much (possible resource exhaustion)");
  }
  if (!isRecord(root)) throw new ExtensionMetadataError("the YAML document is not a mapping");
  return { doc, root };
}

/**
 * Scalar as written in the file: `version: 1.10` stays "1.10" (a YAML float would read 1.1).
 */
function sourceScalar(doc: Document, key: string): string | null {
  const contents = doc.contents;
  if (!isMap(contents)) return null;
  const node = contents.get(key, true);
  if (!isScalar(node)) return null;
  const src = typeof node.source === "string" ? node.source : node.value;
  return clean(src);
}

/** `plugin.yml` (Bukkit/Spigot/Paper legacy plugins). */
export function parsePluginYml(text: string): ExtensionMetadata {
  const { doc, root } = parseYaml(text);
  const name = clean(own(root, "name"), 128);
  if (!name) throw new ExtensionMetadataError("plugin.yml has no name");
  const m = blank("bukkit", name, name);
  m.version = sourceScalar(doc, "version");
  m.description = clean(own(root, "description"));
  m.authors = [...stringList(own(root, "author")), ...stringList(own(root, "authors"))];
  m.minecraftVersion = sourceScalar(doc, "api-version");
  m.entrypoint = clean(own(root, "main"));
  m.homepage = httpsLink(own(root, "website"));
  m.libraries = stringList(own(root, "libraries"));
  const folia = own(root, "folia-supported");
  m.foliaSupported = typeof folia === "boolean" ? folia : null;
  for (const id of stringList(own(root, "depend"))) m.dependencies.push({ id, kind: "required", versionRange: null, side: null });
  for (const id of stringList(own(root, "softdepend"))) m.dependencies.push({ id, kind: "optional", versionRange: null, side: null });
  for (const id of stringList(own(root, "loadbefore"))) m.dependencies.push({ id, kind: "load-before", versionRange: null, side: null });
  if (!m.entrypoint) m.warnings.push("plugin.yml has no main class");
  if (!m.version) m.warnings.push("plugin.yml has no version");
  if (m.libraries.length > 0) m.warnings.push("the server downloads the listed libraries from Maven Central when the plugin loads");
  return m;
}

/** `paper-plugin.yml` (Paper plugins: `dependencies.server` / `dependencies.bootstrap`). */
export function parsePaperPluginYml(text: string): ExtensionMetadata {
  const { doc, root } = parseYaml(text);
  const name = clean(own(root, "name"), 128);
  if (!name) throw new ExtensionMetadataError("paper-plugin.yml has no name");
  const m = blank("paper", name, name);
  m.version = sourceScalar(doc, "version");
  m.description = clean(own(root, "description"));
  m.authors = [...stringList(own(root, "author")), ...stringList(own(root, "authors"))];
  m.minecraftVersion = sourceScalar(doc, "api-version");
  m.entrypoint = clean(own(root, "main"));
  m.homepage = httpsLink(own(root, "website"));
  const folia = own(root, "folia-supported");
  m.foliaSupported = typeof folia === "boolean" ? folia : null;
  const deps = own(root, "dependencies");
  if (isRecord(deps)) {
    const seen = new Set<string>();
    for (const phase of ["server", "bootstrap"]) {
      const group = own(deps, phase);
      if (!isRecord(group)) continue;
      for (const id of Object.keys(group).slice(0, MAX_LIST)) {
        const entry = own(group, id);
        const cid = clean(id, 128);
        if (!cid || seen.has(cid)) continue;
        seen.add(cid);
        // Paper defaults `required` to true.
        const required = isRecord(entry) ? own(entry, "required") !== false : true;
        const load = isRecord(entry) ? clean(own(entry, "load")) : null;
        m.dependencies.push({ id: cid, kind: required ? "required" : load === "AFTER" ? "load-before" : "optional", versionRange: null, side: null });
      }
    }
  }
  if (!m.entrypoint) m.warnings.push("paper-plugin.yml has no main class");
  if (!m.minecraftVersion) m.warnings.push("paper-plugin.yml has no api-version (required by Paper)");
  return m;
}

/** `bungee.yml` (BungeeCord/Waterfall; not runnable on Velocity — reported for upload validation). */
export function parseBungeeYml(text: string): ExtensionMetadata {
  const { doc, root } = parseYaml(text);
  const name = clean(own(root, "name"), 128);
  if (!name) throw new ExtensionMetadataError("bungee.yml has no name");
  const m = blank("bungeecord", name, name);
  m.version = sourceScalar(doc, "version");
  m.description = clean(own(root, "description"));
  m.authors = stringList(own(root, "author"));
  m.entrypoint = clean(own(root, "main"));
  for (const id of stringList(own(root, "depends"))) m.dependencies.push({ id, kind: "required", versionRange: null, side: null });
  for (const id of stringList(own(root, "softDepends"))) m.dependencies.push({ id, kind: "optional", versionRange: null, side: null });
  return m;
}

// ---------------------------------------------------------------------------------------------
// JSON (velocity-plugin.json / fabric.mod.json / quilt.mod.json)

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  checkSize(text);
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ExtensionMetadataError(`${what} is not valid JSON`);
  }
  if (!isRecord(raw)) throw new ExtensionMetadataError(`${what} is not a JSON object`);
  return raw;
}

/** `velocity-plugin.json` (generated by Velocity's annotation processor). */
export function parseVelocityPluginJson(text: string): ExtensionMetadata {
  const o = parseJsonObject(text, "velocity-plugin.json");
  const id = clean(own(o, "id"), 128);
  if (!id) throw new ExtensionMetadataError("velocity-plugin.json has no id");
  const m = blank("velocity", id, clean(own(o, "name"), 128) ?? id);
  m.version = clean(own(o, "version"));
  m.description = clean(own(o, "description"));
  m.authors = stringList(own(o, "authors"));
  m.entrypoint = clean(own(o, "main"));
  m.homepage = httpsLink(own(o, "url"));
  const deps = own(o, "dependencies");
  if (Array.isArray(deps)) {
    for (const d of deps.slice(0, MAX_LIST)) {
      if (!isRecord(d)) continue;
      const did = clean(own(d, "id"), 128);
      if (did) m.dependencies.push({ id: did, kind: own(d, "optional") === true ? "optional" : "required", versionRange: null, side: null });
    }
  }
  return m;
}

function versionMap(v: unknown, kind: DependencyKind, out: ExtensionDependency[], skip: (id: string) => boolean): void {
  if (!isRecord(v)) return;
  for (const id of Object.keys(v).slice(0, MAX_LIST)) {
    const cid = clean(id, 128);
    if (!cid || skip(cid)) continue;
    const range = own(v, id);
    const ranges = Array.isArray(range) ? stringList(range) : stringList([range]);
    out.push({ id: cid, kind, versionRange: ranges.length > 0 ? ranges.join(" || ") : null, side: null });
  }
}

function fabricAuthors(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const a of v.slice(0, MAX_LIST)) {
    const s = isRecord(a) ? clean(own(a, "name")) : clean(a);
    if (s) out.push(s);
  }
  return out;
}

const FABRIC_PLATFORM_IDS = new Set(["minecraft", "fabricloader", "java"]);

/** `fabric.mod.json` (schemaVersion 1; schemaVersion 0 is reported with a warning). */
export function parseFabricModJson(text: string): ExtensionMetadata {
  const o = parseJsonObject(text, "fabric.mod.json");
  const id = clean(own(o, "id"), 64);
  if (!id) throw new ExtensionMetadataError("fabric.mod.json has no id");
  const m = blank("fabric", id, clean(own(o, "name"), 128) ?? id);
  const schema = own(o, "schemaVersion");
  if (schema !== 1) m.warnings.push(`fabric.mod.json schemaVersion ${schema === undefined ? 0 : String(schema).slice(0, 8)} is outdated`);
  m.version = clean(own(o, "version"));
  m.description = clean(own(o, "description"));
  m.authors = fabricAuthors(own(o, "authors"));
  const env = own(o, "environment");
  m.environment = env === "client" ? "client" : env === "server" ? "server" : env === "*" || env === undefined ? "both" : null;
  const depends = own(o, "depends");
  if (isRecord(depends)) {
    m.minecraftVersion = stringList([own(depends, "minecraft")].flat()).join(" || ") || null;
    m.loaderVersion = stringList([own(depends, "fabricloader")].flat()).join(" || ") || null;
  }
  const skip = (dep: string) => dep === "minecraft" || dep === "fabricloader" || dep === "java";
  versionMap(depends, "required", m.dependencies, skip);
  versionMap(own(o, "recommends"), "optional", m.dependencies, skip);
  versionMap(own(o, "suggests"), "optional", m.dependencies, skip);
  versionMap(own(o, "breaks"), "incompatible", m.dependencies, () => false);
  versionMap(own(o, "conflicts"), "discouraged", m.dependencies, () => false);
  const entry = own(o, "entrypoints");
  if (isRecord(entry)) {
    const first = [own(entry, "server"), own(entry, "main")].flat().find((e) => e !== undefined);
    m.entrypoint = isRecord(first) ? clean(own(first, "value")) : clean(first);
  }
  const jars = own(o, "jars");
  let unsafeJars = 0;
  if (Array.isArray(jars)) for (const j of jars.slice(0, MAX_LIST)) if (isRecord(j)) {
    const f = clean(own(j, "file"), 512);
    if (f && isSafeNestedJarPath(f)) m.bundledJars.push(f);
    else if (f) unsafeJars++;
  }
  if (unsafeJars > 0) m.warnings.push(`ignored ${unsafeJars} nested jar entr${unsafeJars === 1 ? "y" : "ies"} with an unsafe path`);
  const license = own(o, "license");
  m.license = Array.isArray(license) ? stringList(license).join(", ") || null : clean(license);
  const contact = own(o, "contact");
  if (isRecord(contact)) m.homepage = httpsLink(own(contact, "homepage")) ?? httpsLink(own(contact, "sources"));
  return m;
}

/** A relative path inside a jar (`META-INF/jars/x.jar`): no `..`/`.` segments, no absolute or drive paths, ends in `.jar`. */
export function isSafeNestedJarPath(p: string): boolean {
  if (p.length > 512 || !/^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(p)) return false;
  const segments = p.split("/");
  // Same rule as installable file names for the jar itself; no "."/".." or device names (CON, NUL, …) anywhere.
  if (!isSafeJarFilename(segments.at(-1)!)) return false;
  return segments.every((seg) => seg !== "." && seg !== ".." && !isWindowsReservedName(seg));
}

/** Fabric dependency ids that are the platform itself (not separate mods). */
export function isFabricPlatformDependency(id: string): boolean {
  return FABRIC_PLATFORM_IDS.has(id);
}

/** `quilt.mod.json` (only the identity; Quilt Loader is not a BlockForge server software). */
export function parseQuiltModJson(text: string): ExtensionMetadata {
  const o = parseJsonObject(text, "quilt.mod.json");
  const loader = own(o, "quilt_loader");
  if (!isRecord(loader)) throw new ExtensionMetadataError("quilt.mod.json has no quilt_loader section");
  const id = clean(own(loader, "id"), 64);
  if (!id) throw new ExtensionMetadataError("quilt.mod.json has no id");
  const meta = own(loader, "metadata");
  const m = blank("quilt", id, (isRecord(meta) ? clean(own(meta, "name"), 128) : null) ?? id);
  m.version = clean(own(loader, "version"));
  if (isRecord(meta)) m.description = clean(own(meta, "description"));
  m.warnings.push("Quilt mods need Quilt Loader; Fabric servers cannot load them");
  return m;
}

// ---------------------------------------------------------------------------------------------
// TOML (META-INF/mods.toml / META-INF/neoforge.mods.toml)

/**
 * Parses a jar manifest (`META-INF/MANIFEST.MF`): main section attributes only, with 72-byte
 * continuation lines joined. Used to resolve `${file.jarVersion}` in mods.toml.
 */
export function parseJarManifest(text: string): Record<string, string> {
  checkSize(text);
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  let key: string | null = null;
  for (const line of lines) {
    if (line === "") break; // end of the main section
    if (line.startsWith(" ") && key !== null) {
      out[key] += line.slice(1);
      continue;
    }
    const i = line.indexOf(": ");
    if (i <= 0) {
      key = null;
      continue;
    }
    key = line.slice(0, i);
    if (!/^[A-Za-z0-9_-]{1,70}$/.test(key)) {
      key = null;
      continue;
    }
    out[key] = line.slice(i + 2);
  }
  return out;
}

const FORGE_SIDE: Record<string, "both" | "client" | "server"> = { BOTH: "both", CLIENT: "client", SERVER: "server" };
const NEO_TYPES: Record<string, DependencyKind> = { required: "required", optional: "optional", incompatible: "incompatible", discouraged: "discouraged" };

/**
 * `META-INF/mods.toml` (Forge, NeoForge ≤ 1.20.4) or `META-INF/neoforge.mods.toml` (NeoForge
 * 1.20.5+). Returns one entry per `[[mods]]`. `${file.jarVersion}` is resolved from the
 * manifest's `Implementation-Version` when `manifest` is given.
 */
export function parseModsToml(text: string, opts: { neoforge?: boolean; manifest?: Record<string, string> } = {}): ExtensionMetadata[] {
  checkSize(text);
  let root: unknown;
  try {
    root = parseToml(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new ExtensionMetadataError(`invalid TOML: ${String((err as Error).message ?? err).split("\n")[0]!.slice(0, 200)}`);
  }
  if (!isRecord(root)) throw new ExtensionMetadataError("mods.toml is not a table");
  const format: ExtensionFormat = opts.neoforge ? "neoforge" : "forge";
  const mods = own(root, "mods");
  if (!Array.isArray(mods) || mods.length === 0) throw new ExtensionMetadataError("mods.toml has no [[mods]] entry");
  const license = clean(own(root, "license"));
  const loaderVersion = clean(own(root, "loaderVersion"));
  const rootAuthors = stringList(own(root, "authors"));
  const allDeps = own(root, "dependencies");
  const out: ExtensionMetadata[] = [];
  for (const mod of mods.slice(0, 32)) {
    if (!isRecord(mod)) continue;
    const id = clean(own(mod, "modId"), 64);
    if (!id) continue;
    const m = blank(format, id, clean(own(mod, "displayName"), 128) ?? id);
    let version = clean(own(mod, "version"));
    if (version === "${file.jarVersion}") {
      const resolved = opts.manifest ? clean(opts.manifest["Implementation-Version"]) : null;
      if (resolved) version = resolved;
      else m.warnings.push("the version comes from the jar manifest (Implementation-Version)");
    }
    m.version = version;
    m.description = clean(own(mod, "description"));
    const authors = stringList(own(mod, "authors"));
    m.authors = (authors.length > 0 ? authors : rootAuthors).flatMap((a) => a.split(",").map((s) => s.trim()).filter(Boolean)).slice(0, MAX_LIST);
    m.license = license;
    m.homepage = httpsLink(own(mod, "displayURL"));
    const deps = isRecord(allDeps) ? own(allDeps, id) : undefined;
    const ranges: string[] = [];
    if (Array.isArray(deps)) {
      for (const d of deps.slice(0, MAX_LIST)) {
        if (!isRecord(d)) continue;
        const did = clean(own(d, "modId"), 64);
        if (!did) continue;
        const type = clean(own(d, "type"));
        const mandatory = own(d, "mandatory");
        const kind: DependencyKind = type ? (NEO_TYPES[type.toLowerCase()] ?? "optional") : mandatory === false ? "optional" : "required";
        const range = clean(own(d, "versionRange"));
        const side = FORGE_SIDE[clean(own(d, "side"))?.toUpperCase() ?? "BOTH"] ?? null;
        if (did === "minecraft") {
          m.minecraftVersion = range;
          continue;
        }
        if (did === "forge" || did === "neoforge") {
          if (range) ranges.push(`${did} ${range}`);
          continue;
        }
        m.dependencies.push({ id: did, kind, versionRange: range, side });
      }
    }
    m.loaderVersion = [loaderVersion ? `javafml ${loaderVersion}` : null, ...ranges].filter(Boolean).join("; ") || null;
    out.push(m);
  }
  if (out.length === 0) throw new ExtensionMetadataError("mods.toml has no valid [[mods]] entry");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dispatch and compatibility

/**
 * Parses whichever metadata entries were read from one jar (`entries`: path inside the jar → text)
 * and returns every plugin/mod declared, most specific first (paper-plugin.yml before plugin.yml).
 */
/** Metadata format read from each jar entry (null for the manifest). */
export const METADATA_ENTRY_FORMATS: Readonly<Record<(typeof EXTENSION_METADATA_ENTRIES)[number], ExtensionFormat | null>> = {
  "paper-plugin.yml": "paper",
  "plugin.yml": "bukkit",
  "velocity-plugin.json": "velocity",
  "bungee.yml": "bungeecord",
  "fabric.mod.json": "fabric",
  "quilt.mod.json": "quilt",
  "META-INF/neoforge.mods.toml": "neoforge",
  "META-INF/mods.toml": "forge",
  "META-INF/MANIFEST.MF": null,
};

export interface InvalidMetadataEntry {
  entry: (typeof EXTENSION_METADATA_ENTRIES)[number];
  format: ExtensionFormat | null;
  message: string;
}

export interface ParsedJarMetadata {
  extensions: ExtensionMetadata[];
  /** `"<entry>: <message>"` (kept for display). */
  errors: string[];
  /** The same failures, structured. */
  invalid: InvalidMetadataEntry[];
}

export function parseJarMetadata(entries: Readonly<Record<string, string>>): ParsedJarMetadata {
  const extensions: ExtensionMetadata[] = [];
  const errors: string[] = [];
  const invalid: InvalidMetadataEntry[] = [];
  const fail = (entry: InvalidMetadataEntry["entry"], message: string) => {
    errors.push(`${entry}: ${message}`);
    invalid.push({ entry, format: METADATA_ENTRY_FORMATS[entry], message });
  };
  const get = (k: string): string | undefined => (Object.hasOwn(entries, k) ? entries[k] : undefined);
  const manifestText = get("META-INF/MANIFEST.MF");
  let manifest: Record<string, string> | undefined;
  if (manifestText !== undefined) {
    try {
      manifest = parseJarManifest(manifestText);
    } catch (err) {
      fail("META-INF/MANIFEST.MF", err instanceof ExtensionMetadataError ? err.message : "unreadable");
    }
  }
  const run = (entry: InvalidMetadataEntry["entry"], fn: (text: string) => ExtensionMetadata | ExtensionMetadata[]) => {
    const text = get(entry);
    if (text === undefined) return;
    try {
      const r = fn(text);
      extensions.push(...(Array.isArray(r) ? r : [r]));
    } catch (err) {
      fail(entry, err instanceof ExtensionMetadataError ? err.message : "unreadable");
    }
  };
  run("paper-plugin.yml", parsePaperPluginYml);
  run("plugin.yml", parsePluginYml);
  run("velocity-plugin.json", parseVelocityPluginJson);
  run("bungee.yml", parseBungeeYml);
  run("fabric.mod.json", parseFabricModJson);
  run("quilt.mod.json", parseQuiltModJson);
  run("META-INF/neoforge.mods.toml", (t) => parseModsToml(t, manifest ? { neoforge: true, manifest } : { neoforge: true }));
  run("META-INF/mods.toml", (t) => parseModsToml(t, manifest ? { manifest } : {}));
  return { extensions, errors, invalid };
}

/** Metadata formats each server software loads, best first. */
export const LOADABLE_FORMATS: Readonly<Record<ServerSoftware, readonly ExtensionFormat[]>> = {
  vanilla: [],
  paper: ["paper", "bukkit"],
  purpur: ["paper", "bukkit"],
  folia: ["paper", "bukkit"],
  spigot: ["bukkit"],
  velocity: ["velocity"],
  fabric: ["fabric"],
  forge: ["forge"],
  neoforge: ["neoforge", "forge"],
};

/** One compatibility problem (codes and levels of the contracts `ExtensionCompatibility`). */
export interface ExtensionProblem {
  code: ExtensionProblemCode;
  level: "error" | "warning";
  /** Human-readable, single line, ≤ 512 characters. */
  message: string;
}

/** Same shape as the contracts `ExtensionCompatibility`. */
export interface JarCompatibility {
  /** False when any problem has level `error`: the server software will not load the jar. */
  loadable: boolean;
  /** Index into the metadata list of the entry the server software uses (null = none). */
  metadataIndex: number | null;
  problems: ExtensionProblem[];
}

const MAX_PROBLEMS = 32;

/**
 * Whether a jar can load on `software` — used to validate uploads before they reach `plugins/` or
 * `mods/`, and to annotate scanned jars. Pass the `parseJarMetadata` result (so unreadable
 * metadata files are reported) or just its `extensions`.
 *
 * Problems: `NO_EXTENSION_DIR` (the software loads no plugins/mods), `NO_METADATA`, `WRONG_PLATFORM`
 * (metadata only for other formats), `FOLIA_UNSUPPORTED` (Folia needs `folia-supported: true`) —
 * errors; `METADATA_INVALID` — an error when the unreadable file is the one the server would read
 * first, a warning otherwise; `LEGACY_MODS_TOML` (NeoForge reads `mods.toml` only before 1.20.5),
 * `CLIENT_ONLY` (Fabric `environment: client`: not loaded by dedicated servers),
 * `METADATA_WARNING` (parser notes of the selected metadata) — warnings.
 */
export function jarCompatibility(jar: readonly ExtensionMetadata[] | ParsedJarMetadata, software: ServerSoftware): JarCompatibility {
  const extensions = "extensions" in jar ? jar.extensions : (jar as readonly ExtensionMetadata[]);
  const invalid = "invalid" in jar ? jar.invalid : [];
  const problems: ExtensionProblem[] = [];
  const add = (code: ExtensionProblemCode, level: ExtensionProblem["level"], message: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ code, level, message: clean(message, 512) ?? code });
  };
  const formats = LOADABLE_FORMATS[software];
  if (formats.length === 0) {
    add("NO_EXTENSION_DIR", "error", `${software} servers do not load plugins or mods`);
    return { loadable: false, metadataIndex: null, problems };
  }
  let metadataIndex: number | null = null;
  let selectedRank = formats.length;
  for (const [rank, format] of formats.entries()) {
    const i = extensions.findIndex((e) => e.format === format);
    if (i >= 0) {
      metadataIndex = i;
      selectedRank = rank;
      break;
    }
  }
  for (const bad of invalid) {
    if (bad.format === null) {
      add("METADATA_INVALID", "warning", `${bad.entry}: ${bad.message}`);
      continue;
    }
    const rank = formats.indexOf(bad.format);
    // The server reads the highest-ranked metadata file present; if that one is broken, it fails.
    const fatal = rank >= 0 && rank <= selectedRank;
    add("METADATA_INVALID", fatal ? "error" : "warning", `${bad.entry}: ${bad.message}`);
  }
  if (metadataIndex === null) {
    const found = [...new Set(extensions.map((e) => e.format))];
    if (found.length > 0) add("WRONG_PLATFORM", "error", `built for ${found.join(", ")}, not for ${software}`);
    else if (!invalid.some((b) => b.format !== null && formats.includes(b.format))) add("NO_METADATA", "error", "no plugin or mod metadata found in the jar");
    return { loadable: !problems.some((p) => p.level === "error"), metadataIndex: null, problems };
  }
  const metadata = extensions[metadataIndex]!;
  if (software === "folia" && metadata.foliaSupported !== true) add("FOLIA_UNSUPPORTED", "error", "Folia only loads plugins that declare folia-supported: true");
  if (software === "neoforge" && metadata.format === "forge") add("LEGACY_MODS_TOML", "warning", "legacy mods.toml: NeoForge only reads it before Minecraft 1.20.5");
  if (metadata.environment === "client") add("CLIENT_ONLY", "warning", "the mod declares a client-only environment and is not loaded by dedicated servers");
  for (const w of metadata.warnings) add("METADATA_WARNING", "warning", w);
  return { loadable: !problems.some((p) => p.level === "error"), metadataIndex, problems };
}

/** One jar of an install dir for `flagDuplicateExtensions` (shape of the contracts `InstalledExtension`). */
export interface DuplicateCheckJar {
  path: string;
  enabled: boolean;
  metadata: readonly { format: ExtensionFormat; id: string }[];
  /** The jar's own result (`jarCompatibility`); null = not read yet (never counted). */
  compatibility: JarCompatibility | null;
}

const MOD_FORMATS: ReadonlySet<ExtensionFormat> = new Set(["fabric", "quilt", "forge", "neoforge"]);

/**
 * Identity key the loader compares. Plugin names: Bukkit replaces spaces with `_` (`PluginDescriptionFile`) and
 * looks plugins up case-insensitively, so `My Plugin`, `my_plugin` and `MY_PLUGIN` collide; Paper's "Ambiguous
 * plugin name" check compares the declared name, so this is a superset of it (a case-only difference is still
 * flagged: such pairs are copies of one plugin in practice). Mod ids are lower-case by spec (Fabric, Forge,
 * NeoForge); they are compared case-insensitively as well.
 */
export function extensionIdentityKey(format: ExtensionFormat, id: string): string {
  const k = MOD_FORMATS.has(format) ? id : id.replaceAll(" ", "_");
  return k.toLowerCase();
}

/**
 * Duplicate copies in one install dir (`plugins/` or `mods/`): two enabled jars whose selected metadata
 * declare the same plugin name / mod id (`extensionIdentityKey`; a Forge jar declaring several mods counts every
 * mod of the selected format). Disabled jars (`.jar.disabled`), jars not read yet and jars the server would not
 * load anyway (`loadable: false`) are not counted and not flagged. Each affected jar gets one `DUPLICATE_ID`
 * problem naming the other path(s): a warning for plugins (Paper/Velocity load only one copy), an error for
 * mods (Fabric/Forge/NeoForge refuse to start with duplicate mod ids). Returns the updated compatibility of
 * the affected jars only, keyed by path; the others are unchanged.
 */
export function flagDuplicateExtensions(jars: readonly DuplicateCheckJar[]): Map<string, JarCompatibility> {
  const owners = new Map<string, { jar: DuplicateCheckJar; id: string; mod: boolean }[]>();
  for (const jar of jars) {
    const c = jar.compatibility;
    if (!jar.enabled || !c || !c.loadable || c.metadataIndex === null) continue;
    const selected = jar.metadata[c.metadataIndex];
    if (!selected) continue;
    const keys = new Map<string, string>();
    for (const m of jar.metadata) if (m.format === selected.format && m.id) keys.set(extensionIdentityKey(m.format, m.id), m.id);
    for (const [key, id] of keys) {
      const list = owners.get(key) ?? [];
      list.push({ jar, id, mod: MOD_FORMATS.has(selected.format) });
      owners.set(key, list);
    }
  }
  const found = new Map<string, { jar: DuplicateCheckJar; messages: string[]; error: boolean }>();
  for (const list of owners.values()) {
    if (list.length < 2) continue;
    for (const o of list) {
      const others = list.filter((x) => x.jar !== o.jar).map((x) => x.jar.path);
      if (others.length === 0) continue;
      const shown = others.slice(0, 3).join(", ") + (others.length > 3 ? ` and ${others.length - 3} more` : "");
      const what = o.mod ? `mod id "${o.id}"` : `plugin name "${o.id}"`;
      const effect = o.mod ? "the server refuses to start with duplicate mod ids" : "the server loads only one of them";
      const f = found.get(o.jar.path) ?? { jar: o.jar, messages: [], error: false };
      f.messages.push(`${shown} declares the same ${what}; ${effect}`);
      f.error ||= o.mod;
      found.set(o.jar.path, f);
    }
  }
  const out = new Map<string, JarCompatibility>();
  for (const [path, f] of found) {
    const base = f.jar.compatibility!;
    const level = f.error ? "error" : "warning";
    const added: ExtensionProblem[] = f.messages.map((m) => ({ code: "DUPLICATE_ID", level, message: clean(m, 512) ?? "DUPLICATE_ID" }));
    // Duplicates first so the cap never drops them.
    const problems = [...added, ...base.problems].slice(0, MAX_PROBLEMS);
    out.set(path, { loadable: base.loadable && level !== "error", metadataIndex: base.metadataIndex, problems });
  }
  return out;
}
