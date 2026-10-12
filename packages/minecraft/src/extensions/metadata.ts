import type { ServerSoftware } from "@blockforge/contracts";
import { parse as parseToml } from "smol-toml";
import { isMap, isScalar, parseDocument, type Document } from "yaml";

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
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(v: unknown, max = MAX_STR): string | null {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    const s = String(v).replace(CONTROL, "").trim();
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
  if (Array.isArray(jars)) for (const j of jars.slice(0, MAX_LIST)) if (isRecord(j)) {
    const f = clean(own(j, "file"));
    if (f) m.bundledJars.push(f);
  }
  const license = own(o, "license");
  m.license = Array.isArray(license) ? stringList(license).join(", ") || null : clean(license);
  const contact = own(o, "contact");
  if (isRecord(contact)) m.homepage = httpsLink(own(contact, "homepage")) ?? httpsLink(own(contact, "sources"));
  if (m.environment === "client") m.warnings.push("the mod declares environment \"client\" and is not loaded by dedicated servers");
  return m;
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
export function parseJarMetadata(entries: Readonly<Record<string, string>>): { extensions: ExtensionMetadata[]; errors: string[] } {
  const extensions: ExtensionMetadata[] = [];
  const errors: string[] = [];
  const get = (k: string): string | undefined => (Object.hasOwn(entries, k) ? entries[k] : undefined);
  const manifestText = get("META-INF/MANIFEST.MF");
  let manifest: Record<string, string> | undefined;
  if (manifestText !== undefined) {
    try {
      manifest = parseJarManifest(manifestText);
    } catch (err) {
      errors.push(`META-INF/MANIFEST.MF: ${(err as Error).message}`);
    }
  }
  const run = (entry: string, fn: (text: string) => ExtensionMetadata | ExtensionMetadata[]) => {
    const text = get(entry);
    if (text === undefined) return;
    try {
      const r = fn(text);
      extensions.push(...(Array.isArray(r) ? r : [r]));
    } catch (err) {
      errors.push(`${entry}: ${err instanceof ExtensionMetadataError ? err.message : "unreadable"}`);
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
  return { extensions, errors };
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

export interface JarCompatibility {
  loadable: boolean;
  /** The metadata entry the server will use. */
  metadata: ExtensionMetadata | null;
  warnings: string[];
}

/**
 * Whether a jar (parsed with `parseJarMetadata`) can load on `software` — used to validate
 * uploads before they reach `plugins/` or `mods/`. Folia needs `folia-supported: true`; NeoForge
 * reads legacy `mods.toml` only before Minecraft 1.20.5.
 */
export function jarCompatibility(extensions: readonly ExtensionMetadata[], software: ServerSoftware): JarCompatibility {
  const formats = LOADABLE_FORMATS[software];
  const warnings: string[] = [];
  for (const format of formats) {
    const metadata = extensions.find((e) => e.format === format);
    if (!metadata) continue;
    if (software === "folia" && metadata.foliaSupported !== true) {
      return { loadable: false, metadata, warnings: ["Folia only loads plugins that declare folia-supported: true"] };
    }
    if (software === "neoforge" && format === "forge") warnings.push("legacy mods.toml: NeoForge only reads it before Minecraft 1.20.5");
    if (metadata.environment === "client") warnings.push("client-only mod");
    return { loadable: true, metadata, warnings: [...warnings, ...metadata.warnings] };
  }
  const found = [...new Set(extensions.map((e) => e.format))];
  return {
    loadable: false,
    metadata: null,
    warnings: [found.length > 0 ? `built for ${found.join(", ")}, not for ${software}` : "no plugin or mod metadata found in the jar"],
  };
}
