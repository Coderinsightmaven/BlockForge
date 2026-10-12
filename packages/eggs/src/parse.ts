import {
  type ConfigFileRule,
  EnvVarName,
  RESERVED_ENV_VARS,
  type StopConfig,
  type Template,
  type TemplateGame,
  type TemplateImportPreview,
  TemplateImportPreview as TemplateImportPreviewSchema,
  type TemplateVariable,
} from "@blockforge/contracts";
import { DEFAULT_AGENT_IMAGE_ALLOWLIST, imageAllowed, parseImageRef } from "./images.js";
import { isKnownConfigPlaceholder, placeholderKeys } from "./placeholders.js";
import { unsupportedRules } from "./rules.js";
import { defineOwn, isForbiddenKey } from "./safe.js";

/**
 * Egg import (Pterodactyl `EggImporterService`/`EggParserService`, Pelican `EggImporterService`).
 *
 * Formats (`meta.version`):
 *  - PTDL_v1: `images` (array) or `image` (string) instead of `docker_images`;
 *  - PTDL_v2: `docker_images` map label → image;
 *  - PLCN_v1, PLCN_v2: as PTDL_v2; variable `rules` may be an array;
 *  - PLCN_v3: `startup_commands` map name → command instead of `startup`; optional `tags`, `icon`.
 * `config.files|startup|logs` may be JSON-encoded strings (Pterodactyl exports) or objects
 * (Pelican YAML exports). `config.stop` `^C` / `^SIGNAL` is a signal, anything else a console
 * command. The egg version is recorded as `sourceFormat`.
 */

type Issue = TemplateImportPreview["issues"][number];
type Severity = Issue["severity"];
type ParsedTemplate = NonNullable<TemplateImportPreview["template"]>;

export interface ParseEggOptions {
  category: string;
  game?: TemplateGame;
  /** Agent image allowlist used for `imagesNeedingAllowlist`; defaults to the agent default. */
  imageAllowlist?: readonly string[];
}

export const SUPPORTED_EGG_FORMATS = ["PTDL_v1", "PTDL_v2", "PLCN_v1", "PLCN_v2", "PLCN_v3"] as const;
export const MAX_INSTALL_SCRIPT_BYTES = 64 * 1024;
const PARSERS = new Set(["properties", "yaml", "json", "ini", "xml", "file"]);
const SIGNALS: Record<string, StopConfig & { type: "signal" }> = {
  C: { type: "signal", signal: "SIGINT" },
  SIGINT: { type: "signal", signal: "SIGINT" },
  SIGTERM: { type: "signal", signal: "SIGTERM" },
  SIGQUIT: { type: "signal", signal: "SIGQUIT" },
  SIGKILL: { type: "signal", signal: "SIGKILL" },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return fallback;
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Slug from an egg name: lowercase, `-` separated, 3–48 chars. */
export function slugify(name: string): string {
  let s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 48) s = s.slice(0, 48).replace(/-+$/, "");
  if (s.length < 3) s = `egg-${s || "imported"}`.slice(0, 48).replace(/-+$/, "");
  return s;
}

/** Decodes a `config.*` member that may be a JSON string or an object. */
function decodeConfigMember(v: unknown, path: string, issue: (s: Severity, code: string, msg: string, p?: string) => void): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    if (v.trim() === "") return null;
    try {
      return JSON.parse(v);
    } catch (e) {
      issue("error", "CONFIG_UNPARSEABLE", `${path} is not valid JSON: ${(e as Error).message}`, path);
      return undefined;
    }
  }
  return v;
}

function suggestGame(egg: Record<string, unknown>, startup: string, configFiles: ConfigFileRule[], done: string[]): { game: TemplateGame; reason: string } {
  const name = String(egg["name"] ?? "").toLowerCase();
  const features = Array.isArray(egg["features"]) ? (egg["features"] as unknown[]).map(String) : [];
  if (/bungee|waterfall|velocity|travertine/.test(name) || (configFiles.some((f) => f.path === "config.yml" && Object.keys(f.find).some((k) => k.startsWith("listeners"))) && /\.jar/.test(startup))) {
    return { game: "minecraft-proxy", reason: "name/config look like a Minecraft proxy (BungeeCord/Waterfall/Velocity)" };
  }
  const props = configFiles.some((f) => f.path === "server.properties");
  const mcDone = done.some((d) => d.includes(")! For help, type"));
  if ((features.includes("eula") && /\.jar|java/.test(startup)) || (props && mcDone) || (props && /\.jar/.test(startup) && /minecraft|paper|spigot|forge|fabric|sponge|purpur|bukkit/.test(name))) {
    return { game: "minecraft-java", reason: "eula feature / server.properties / Minecraft done line" };
  }
  return { game: "other", reason: "no Minecraft markers" };
}

/** Parses a raw egg object into an import preview. Never throws for bad input. */
export function parseEgg(raw: unknown, opts: ParseEggOptions): TemplateImportPreview {
  const issues: Issue[] = [];
  const issue = (severity: Severity, code: string, message: string, path?: string) => issues.push(path === undefined ? { severity, code, message } : { severity, code, message, path });
  const fail = (): TemplateImportPreview => ({ template: null, issues, imagesNeedingAllowlist: [] });

  if (!isObj(raw)) {
    issue("error", "EGG_UNPARSEABLE", "The egg must be a JSON object.");
    return fail();
  }
  const egg = raw;
  const meta = isObj(egg["meta"]) ? egg["meta"] : {};
  const version = str(meta["version"]) ?? "";
  if (!(SUPPORTED_EGG_FORMATS as readonly string[]).includes(version)) {
    issue("error", "EGG_FORMAT_UNKNOWN", version ? `Unsupported egg format "${version}" (supported: ${SUPPORTED_EGG_FORMATS.join(", ")}).` : "The egg has no meta.version; it is not a Pterodactyl/Pelican egg export.", "meta.version");
    return fail();
  }
  const sourceFormat = version as NonNullable<ParsedTemplate["sourceFormat"]>;

  // --- name / description / author -------------------------------------------------------
  let name = (str(egg["name"]) ?? "").trim();
  if (name === "") {
    issue("error", "NAME_MISSING", "The egg has no name.", "name");
    name = "Imported egg";
  }
  if (name.length > 80) {
    issue("warning", "NAME_TRUNCATED", "The name was shortened to 80 characters.", "name");
    name = name.slice(0, 80).trim();
  }
  let description = str(egg["description"]) ?? "";
  if (description.length > 4096) {
    issue("warning", "DESCRIPTION_TRUNCATED", "The description was shortened to 4096 characters.", "description");
    description = description.slice(0, 4096);
  }
  let author = str(egg["author"]);
  if (author !== null && author.length > 191) author = author.slice(0, 191);
  if (author === "") author = null;

  // --- docker images -----------------------------------------------------------------------
  const images: ParsedTemplate["dockerImages"] = [];
  if (version === "PTDL_v1" && !isObj(egg["docker_images"])) {
    const list = Array.isArray(egg["images"]) ? (egg["images"] as unknown[]) : egg["image"] !== undefined ? [egg["image"]] : [];
    for (const im of list) {
      const s = str(im);
      if (s) images.push({ label: s.slice(0, 80), image: s });
    }
  } else if (isObj(egg["docker_images"])) {
    for (const [label, im] of Object.entries(egg["docker_images"])) {
      const s = str(im);
      if (s) images.push({ label: (label.trim() || s).slice(0, 80), image: s.trim() });
    }
  } else if (Array.isArray(egg["docker_images"])) {
    for (const im of egg["docker_images"] as unknown[]) {
      const s = str(im);
      if (s) images.push({ label: s.slice(0, 80), image: s.trim() });
    }
  }
  if (images.length === 0) issue("error", "NO_DOCKER_IMAGES", "The egg defines no Docker images.", "docker_images");
  if (images.length > 32) {
    issue("warning", "TOO_MANY_IMAGES", "Only the first 32 Docker images are kept.", "docker_images");
    images.splice(32);
  }
  const imageCheck = (image: string, path: string) => {
    try {
      parseImageRef(image);
      return true;
    } catch (e) {
      issue("error", "INVALID_IMAGE", `"${image}" is not a valid image reference: ${(e as Error).message}.`, path);
      return false;
    }
  };
  images.forEach((im, i) => imageCheck(im.image, `docker_images[${i}]`));

  // --- startup ------------------------------------------------------------------------------
  let startup = "";
  if (version === "PLCN_v3") {
    const cmds = isObj(egg["startup_commands"]) ? Object.entries(egg["startup_commands"]).filter(([, v]) => typeof v === "string") : [];
    if (cmds.length > 0) {
      const chosen = cmds.find(([k]) => k === "Default") ?? cmds[0]!;
      startup = chosen[1] as string;
      if (cmds.length > 1) {
        issue("info", "STARTUP_COMMANDS_REDUCED", `The egg offers ${cmds.length} startup commands; "${chosen[0]}" is used (BlockForge templates have one startup command).`, "startup_commands");
      }
    }
  } else {
    startup = str(egg["startup"]) ?? "";
  }
  if (startup.trim() === "") issue("error", "STARTUP_MISSING", "The egg has no startup command.", version === "PLCN_v3" ? "startup_commands" : "startup");
  if (startup.length > 8192) issue("error", "STARTUP_TOO_LONG", "The startup command is longer than 8192 characters.", "startup");

  // --- config -------------------------------------------------------------------------------
  const config = isObj(egg["config"]) ? egg["config"] : {};
  const files = decodeConfigMember(config["files"], "config.files", issue);
  const startupCfg = decodeConfigMember(config["startup"], "config.startup", issue);
  const logs = decodeConfigMember(config["logs"], "config.logs", issue);
  if (isObj(logs) && Object.keys(logs).length > 0) issue("info", "CONFIG_LOGS_IGNORED", "config.logs is not used (logs are streamed from the console).", "config.logs");

  const configFiles: ConfigFileRule[] = [];
  if (isObj(files)) {
    for (const [rawPath, spec] of Object.entries(files)) {
      const p = `config.files["${rawPath}"]`;
      // Wings resolves config paths inside the server root, so a leading "/" means the root.
      const path = rawPath.replace(/^\/+/, "");
      if (path !== rawPath) issue("info", "CONFIG_FILE_PATH_NORMALISED", `Config file path "${rawPath}" is stored as "${path}" (relative to the server root).`, p);
      if (!isObj(spec)) {
        issue("warning", "CONFIG_FILE_IGNORED", `Config file entry for ${path} is not an object; ignored.`, p);
        continue;
      }
      let parser = str(spec["parser"])?.toLowerCase() ?? "";
      if (parser === "yml") parser = "yaml";
      if (!PARSERS.has(parser)) {
        issue("warning", "CONFIG_PARSER_UNSUPPORTED", `Parser "${parser}" for ${path} is not supported; the rule is ignored.`, p);
        continue;
      }
      if (path.trim() === "" || path.length > 512 || /^([/\\]|[a-zA-Z]:)/.test(path) || path.split(/[/\\]/).includes("..") || path.includes("\0")) {
        issue("error", "CONFIG_FILE_PATH_INVALID", `Config file path "${path}" must be relative and must not contain "..".`, p);
        continue;
      }
      const find: ConfigFileRule["find"] = {};
      if (!isObj(spec["find"])) {
        issue("warning", "CONFIG_FILE_NO_FIND", `Config file ${path} has no "find" map; ignored.`, p);
        continue;
      }
      for (const [key, value] of Object.entries(spec["find"])) {
        // Keys become object paths in the config writers: refuse prototype-polluting segments.
        const badSeg = key.split(/[.[\]]/).find((seg) => isForbiddenKey(seg));
        if (badSeg !== undefined) {
          issue("error", "CONFIG_KEY_FORBIDDEN", `${path}: key "${key}" contains the forbidden segment "${badSeg}".`, `${p}.find`);
          continue;
        }
        const s = str(value);
        if (s !== null) {
          defineOwn(find, key, s);
          if (typeof value !== "string") issue("info", "CONFIG_VALUE_STRINGIFIED", `${path}: value of "${key}" is stored as the string "${s}".`, `${p}.find`);
        } else if (isObj(value)) {
          const m: Record<string, string> = {};
          for (const [k, v] of Object.entries(value)) {
            if (isForbiddenKey(k)) {
              issue("error", "CONFIG_KEY_FORBIDDEN", `${path}: condition "${k}" under "${key}" is not allowed.`, `${p}.find`);
              continue;
            }
            const vs = str(v);
            if (vs === null) {
              issue("warning", "CONFIG_VALUE_UNSUPPORTED", `${path}: nested value under "${key}" → "${k}" is not a string; ignored.`, `${p}.find`);
              continue;
            }
            defineOwn(m, k, vs);
          }
          defineOwn(find, key, m);
        } else {
          issue("warning", "CONFIG_VALUE_UNSUPPORTED", `${path}: value of "${key}" is not a string or map; ignored.`, `${p}.find`);
        }
      }
      if (parser !== "yaml" && parser !== "json") {
        for (const [key, value] of Object.entries(find)) {
          if (typeof value !== "string" && Object.keys(value).some((k) => k.startsWith("regex:"))) {
            issue("warning", "CONFIG_REGEX_UNSUPPORTED", `${path}: "regex:" conditions only work with the yaml and json parsers (key "${key}").`, `${p}.find`);
          }
        }
      }
      if (parser === "file") issue("info", "CONFIG_FILE_TEXT_PARSER", `${path} uses the line-prefix "file" parser; it only edits the file once it exists.`, p);
      configFiles.push({ path, parser: parser as ConfigFileRule["parser"], find });
    }
  } else if (files !== null && files !== undefined) {
    issue("warning", "CONFIG_FILES_IGNORED", "config.files is not an object; ignored.", "config.files");
  }
  if (configFiles.length > 64) {
    issue("warning", "TOO_MANY_CONFIG_FILES", "Only the first 64 config-file rules are kept.", "config.files");
    configFiles.splice(64);
  }

  let startupDone: string[] = [];
  if (isObj(startupCfg)) {
    const done = startupCfg["done"];
    const list = typeof done === "string" ? [done] : Array.isArray(done) ? (done as unknown[]).map(str).filter((d): d is string => d !== null) : [];
    startupDone = list.filter((d) => d.length > 0);
    if (Array.isArray(startupCfg["userInteraction"]) && (startupCfg["userInteraction"] as unknown[]).length > 0) {
      issue("info", "USER_INTERACTION_IGNORED", "config.startup.userInteraction is not supported.", "config.startup");
    }
  }
  if (startupDone.some((d) => d.length > 512)) {
    issue("warning", "DONE_PATTERN_TRUNCATED", "Startup done patterns longer than 512 characters were dropped.", "config.startup.done");
    startupDone = startupDone.filter((d) => d.length <= 512);
  }
  if (startupDone.length > 16) {
    issue("warning", "TOO_MANY_DONE_PATTERNS", "Only the first 16 startup done patterns are kept.", "config.startup.done");
    startupDone = startupDone.slice(0, 16);
  }
  if (startupDone.length === 0) issue("warning", "NO_DONE_PATTERN", "The egg has no startup done pattern; the server is reported as running as soon as its container starts.", "config.startup.done");
  for (const d of startupDone) {
    if (d.startsWith("regex:")) {
      try {
        new RegExp(d.slice(6));
      } catch {
        issue("warning", "DONE_REGEX_INVALID", `Done pattern "${d}" is not a valid regex; it is matched as literal text (like Wings).`, "config.startup.done");
      }
    }
  }

  let stop: StopConfig;
  const stopRaw = (str(config["stop"]) ?? "").trim();
  if (stopRaw === "") {
    issue("warning", "STOP_MISSING", "The egg has no stop command; SIGTERM is used.", "config.stop");
    stop = { type: "signal", signal: "SIGTERM" };
  } else if (stopRaw.startsWith("^")) {
    const sig = stopRaw.slice(1).toUpperCase();
    const mapped = SIGNALS[sig];
    if (mapped) stop = mapped;
    else {
      issue("warning", "STOP_SIGNAL_UNSUPPORTED", `Stop signal "${stopRaw}" is not supported; SIGTERM is used.`, "config.stop");
      stop = { type: "signal", signal: "SIGTERM" };
    }
  } else if (stopRaw.length > 256 || /[\0\r\n]/.test(stopRaw)) {
    issue("error", "STOP_INVALID", "The stop command must be a single line of at most 256 characters.", "config.stop");
    stop = { type: "signal", signal: "SIGTERM" };
  } else {
    stop = { type: "command", command: stopRaw };
  }

  // --- install script -----------------------------------------------------------------------
  let install: ParsedTemplate["install"] = null;
  const scripts = isObj(egg["scripts"]) ? egg["scripts"] : {};
  const inst = isObj(scripts["installation"]) ? scripts["installation"] : null;
  if (inst) {
    const script = (str(inst["script"]) ?? "").replace(/\r\n/g, "\n");
    const container = (str(inst["container"]) ?? "").trim();
    const entryRaw = (str(inst["entrypoint"]) ?? "").trim();
    if (script.trim() === "") {
      issue("info", "NO_INSTALL_SCRIPT", "The egg has no install script.", "scripts.installation.script");
    } else {
      const entry = /^(?:\/(?:usr\/)?bin\/)?(bash|ash|sh)$/.exec(entryRaw)?.[1] as "bash" | "ash" | "sh" | undefined;
      let ok = true;
      if (!entry) {
        issue("error", "INSTALL_ENTRYPOINT_UNSUPPORTED", `Install entrypoint "${entryRaw}" is not supported (use bash, ash or sh).`, "scripts.installation.entrypoint");
        ok = false;
      } else if (entry !== entryRaw) {
        issue("info", "INSTALL_ENTRYPOINT_NORMALISED", `Install entrypoint "${entryRaw}" is stored as "${entry}".`, "scripts.installation.entrypoint");
      }
      if (utf8Length(script) > MAX_INSTALL_SCRIPT_BYTES) {
        issue("error", "INSTALL_SCRIPT_TOO_LARGE", `The install script is larger than ${MAX_INSTALL_SCRIPT_BYTES / 1024} KiB.`, "scripts.installation.script");
        ok = false;
      }
      if (container === "") {
        issue("error", "INSTALL_IMAGE_MISSING", "The install script has no container image.", "scripts.installation.container");
        ok = false;
      } else if (!imageCheck(container, "scripts.installation.container")) ok = false;
      if (ok && entry === "bash" && /alpine/i.test(container)) {
        issue("warning", "INSTALL_ENTRYPOINT_MISMATCH", `The install image "${container}" looks Alpine-based but the script runs with bash; make sure the image ships bash.`, "scripts.installation.entrypoint");
      }
      if (ok && entry !== "bash" && /\[\[|\bfunction\s+\w+\s*\(|<\(|\$\{[A-Za-z_]+\[/.test(script)) {
        issue("warning", "INSTALL_SCRIPT_BASHISMS", `The install script uses bash syntax but runs with ${entry}.`, "scripts.installation.script");
      }
      if (ok && entry) install = { image: container, entrypoint: entry, script };
    }
  }

  // --- variables ----------------------------------------------------------------------------
  const variables: TemplateVariable[] = [];
  const rawVars = Array.isArray(egg["variables"]) ? (egg["variables"] as unknown[]) : [];
  const seen = new Set<string>();
  rawVars.forEach((rv, idx) => {
    const p = `variables[${idx}]`;
    if (!isObj(rv)) {
      issue("warning", "VARIABLE_IGNORED", "Variable entry is not an object; ignored.", p);
      return;
    }
    const envName = (str(rv["env_variable"]) ?? "").trim();
    if (!EnvVarName.safeParse(envName).success) {
      issue("error", "VARIABLE_NAME_INVALID", `Variable name "${envName}" is not a valid environment variable name.`, `${p}.env_variable`);
      return;
    }
    if (isForbiddenKey(envName)) {
      issue("error", "VARIABLE_NAME_INVALID", `Variable name "${envName}" is not allowed.`, `${p}.env_variable`);
      return;
    }
    if ((RESERVED_ENV_VARS as readonly string[]).includes(envName.toUpperCase())) {
      issue("error", "VARIABLE_NAME_RESERVED", `Variable ${envName} uses a name reserved by the platform.`, `${p}.env_variable`);
      return;
    }
    if (seen.has(envName)) {
      issue("error", "VARIABLE_DUPLICATE", `Variable ${envName} is defined more than once.`, `${p}.env_variable`);
      return;
    }
    seen.add(envName);
    let vname = (str(rv["name"]) ?? "").trim() || envName;
    if (vname.length > 191) vname = vname.slice(0, 191);
    let desc = str(rv["description"]) ?? "";
    if (desc.length > 4096) desc = desc.slice(0, 4096);
    const def = rv["default_value"] === null || rv["default_value"] === undefined ? "" : (str(rv["default_value"]) ?? "");
    if (def.length > 8192) {
      issue("error", "VARIABLE_DEFAULT_TOO_LONG", `Default of ${envName} is longer than 8192 characters.`, `${p}.default_value`);
      return;
    }
    let rules: string;
    if (Array.isArray(rv["rules"])) rules = (rv["rules"] as unknown[]).map((r) => String(r)).join("|");
    else rules = str(rv["rules"]) ?? "nullable|string";
    if (rules.trim() === "") rules = "nullable|string";
    if (rules.length > 2048) {
      issue("error", "VARIABLE_RULES_TOO_LONG", `Rules of ${envName} are longer than 2048 characters.`, `${p}.rules`);
      return;
    }
    const unsupported = unsupportedRules(rules);
    if (unsupported.length > 0) {
      issue("warning", "VARIABLE_RULES_UNSUPPORTED", `${envName}: rule(s) ${unsupported.join(", ")} are not enforced by BlockForge.`, `${p}.rules`);
    }
    const sortRaw = rv["sort"];
    const sortOrder = typeof sortRaw === "number" && Number.isInteger(sortRaw) ? sortRaw : typeof sortRaw === "string" && /^-?\d+$/.test(sortRaw) ? Number(sortRaw) : idx + 1;
    variables.push({
      envName,
      name: vname,
      description: desc,
      defaultValue: def,
      userViewable: bool(rv["user_viewable"], false),
      userEditable: bool(rv["user_editable"], false),
      rules,
      sortOrder,
    });
  });
  if (variables.length > 128) {
    issue("error", "TOO_MANY_VARIABLES", "Templates support at most 128 variables.", "variables");
  }
  variables.sort((a, b) => a.sortOrder - b.sortOrder);
  const editableNotViewable = variables.filter((v) => v.userEditable && !v.userViewable);
  for (const v of editableNotViewable) issue("info", "VARIABLE_EDITABLE_HIDDEN", `${v.envName} is editable but not viewable; users can overwrite it without seeing it.`, "variables");

  // --- placeholders -------------------------------------------------------------------------
  const varNames = new Set(variables.map((v) => v.envName));
  const platform = new Set<string>(RESERVED_ENV_VARS);
  for (const key of new Set(placeholderKeys(startup))) {
    if (!varNames.has(key) && !platform.has(key)) {
      issue("warning", "UNKNOWN_PLACEHOLDER", `Startup placeholder {{${key}}} is not a variable of this egg; the image entrypoint will expand it to an empty value.`, "startup");
    }
  }
  for (const f of configFiles) {
    for (const v of Object.values(f.find)) {
      const texts = typeof v === "string" ? [v] : Object.values(v);
      for (const t of texts) {
        for (const key of new Set(placeholderKeys(t))) {
          if (!isKnownConfigPlaceholder(key, varNames)) {
            issue("warning", "UNKNOWN_PLACEHOLDER", `${f.path}: placeholder {{${key}}} is not supported; it is left as written.`, `config.files["${f.path}"]`);
          }
        }
      }
    }
  }

  // --- misc -----------------------------------------------------------------------------------
  let features = Array.isArray(egg["features"]) ? (egg["features"] as unknown[]).map(str).filter((f): f is string => f !== null && f !== "") : [];
  features = [...new Set(features)].filter((f) => f.length <= 64).slice(0, 32);
  let fileDenylist = Array.isArray(egg["file_denylist"]) ? (egg["file_denylist"] as unknown[]).map(str).filter((f): f is string => f !== null && f.trim() !== "") : [];
  if (fileDenylist.some((f) => f.length > 512)) issue("warning", "DENYLIST_ENTRY_DROPPED", "Denylist entries longer than 512 characters were dropped.", "file_denylist");
  fileDenylist = fileDenylist.filter((f) => f.length <= 512).slice(0, 256);
  if (Array.isArray(egg["tags"]) && (egg["tags"] as unknown[]).length > 0) issue("info", "TAGS_IGNORED", "Pelican tags are not imported.", "tags");
  if (egg["copy_script_from"] || egg["config_from"]) issue("warning", "INHERITANCE_UNSUPPORTED", "Egg inheritance (copy_script_from/config_from) is not supported.");

  // --- images vs allowlist --------------------------------------------------------------------
  const allowlist = opts.imageAllowlist ?? DEFAULT_AGENT_IMAGE_ALLOWLIST;
  const allImages = [...images.map((i) => i.image), ...(install ? [install.image] : [])];
  const imagesNeedingAllowlist = [...new Set(allImages.filter((im) => { try { parseImageRef(im); } catch { return false; } return !imageAllowed(im, allowlist); }))];
  for (const im of imagesNeedingAllowlist) {
    issue("warning", "IMAGE_NOT_ALLOWLISTED", `Image "${im}" is not in the node agents' default image allowlist; nodes refuse it until an operator adds it.`);
  }
  const knownYolk = images.some((i) => {
    try {
      return /^ghcr\.io\/(pterodactyl|parkervcp)\/(yolks|games|images)$/.test(parseImageRef(i.image).repo);
    } catch {
      return false;
    }
  });
  if (images.length > 0 && !knownYolk) {
    issue("warning", "IMAGE_ENTRYPOINT_UNKNOWN", "None of the images is a Pterodactyl/Pelican yolk; the image's entrypoint must evaluate the STARTUP variable (the egg runtime does not run the startup command itself).");
  }

  // --- game -----------------------------------------------------------------------------------
  let game: TemplateGame;
  if (opts.game) game = opts.game;
  else {
    const s = suggestGame(egg, startup, configFiles, startupDone);
    game = s.game;
    issue("info", "GAME_SUGGESTED", `Game detected as "${s.game}" (${s.reason}); override it if wrong.`, "game");
  }

  const template: ParsedTemplate = {
    key: slugify(name),
    name,
    description,
    category: opts.category,
    kind: "egg",
    game,
    author,
    source: "import",
    sourceFormat,
    dockerImages: images,
    startup,
    variables: variables.slice(0, 128),
    configFiles,
    startupDone,
    stop,
    install,
    features,
    fileDenylist,
    runtime: { dataMountPath: "/home/container", readOnlyRootfs: true },
  };

  if (issues.some((i) => i.severity === "error")) return { template: null, issues, imagesNeedingAllowlist };
  const checked = TemplateImportPreviewSchema.safeParse({ template, issues, imagesNeedingAllowlist });
  if (!checked.success) {
    for (const i of checked.error.issues.slice(0, 10)) issue("error", "TEMPLATE_INVALID", `${i.path.join(".")}: ${i.message}`, i.path.join("."));
    return { template: null, issues, imagesNeedingAllowlist };
  }
  return checked.data;
}

/** Convenience: the template part of a successful preview (throws when the preview has errors). */
export function templateFromPreview(preview: TemplateImportPreview): NonNullable<TemplateImportPreview["template"]> {
  if (!preview.template) throw new Error(preview.issues.filter((i) => i.severity === "error").map((i) => i.message).join("; ") || "egg import failed");
  return preview.template;
}

export type ImportedTemplate = Omit<Template, "id" | "serverCount" | "createdAt" | "updatedAt">;
