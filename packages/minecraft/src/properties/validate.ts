import { isAtLeast } from "../versions.js";
import { validateLevelName, validateLevelType, validateSeed } from "../world.js";
import { PROPERTY_SCHEMA, type PropertySpec } from "./schema.js";

export type IssueSeverity = "error" | "warning" | "info";

export interface PropertyIssue {
  key: string;
  severity: IssueSeverity;
  code:
    | "UNKNOWN_KEY"
    | "NOT_IN_VERSION"
    | "REMOVED_IN_VERSION"
    | "INVALID_BOOLEAN"
    | "INVALID_INTEGER"
    | "OUT_OF_RANGE"
    | "INVALID_ENUM"
    | "LEGACY_NUMERIC"
    | "INVALID_URL"
    | "INVALID_SHA1"
    | "INVALID_UUID"
    | "INVALID_LEVEL_NAME"
    | "LEVEL_TYPE"
    | "INVALID_SEED"
    | "SEED_INFO"
    | "PLATFORM_MANAGED"
    | "SIMULATION_EXCEEDS_VIEW"
    | "ENFORCE_WITHOUT_WHITELIST"
    | "REQUIRED_PACK_WITHOUT_URL"
    | "OFFLINE_MODE"
    | "RCON_WITHOUT_PASSWORD"
    | "VERSION_UNORDERED"
    | "SCHEMA_UNVERIFIED";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: PropertyIssue[];
}

export interface ValidateOptions {
  /** Server sits behind a proxy that authenticates players (offline mode is expected). */
  behindProxy?: boolean;
  /** Report platform-managed keys (ports, RCON, management API) as warnings. Default true. */
  flagPlatformManaged?: boolean;
}

const INT = /^[+-]?\d+$/;
const LEGACY_NUMERIC_ENUMS: Record<string, readonly string[]> = {
  difficulty: ["peaceful", "easy", "normal", "hard"],
  gamemode: ["survival", "creative", "adventure", "spectator"],
};

function checkType(spec: PropertySpec, value: string, out: PropertyIssue[]): void {
  const key = spec.key;
  switch (spec.type) {
    case "boolean":
      if (!/^(true|false)$/i.test(value)) out.push({ key, severity: "error", code: "INVALID_BOOLEAN", message: `${key} must be true or false (Minecraft treats anything else as false).` });
      return;
    case "integer": {
      if (!INT.test(value)) {
        out.push({ key, severity: "error", code: "INVALID_INTEGER", message: `${key} must be a whole number (invalid values are replaced by the default ${spec.default}).` });
        return;
      }
      const n = Number(value);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        const severity = key === "view-distance" || key === "simulation-distance" ? "warning" : "error";
        out.push({
          key,
          severity,
          code: "OUT_OF_RANGE",
          message: `${key} must be between ${spec.min ?? "-∞"} and ${spec.max ?? "∞"}${severity === "warning" ? " (the server clamps it)" : ""}.`,
        });
      }
      return;
    }
    case "enum": {
      const values = spec.values ?? [];
      if (values.includes(value.toLowerCase())) return;
      const legacy = LEGACY_NUMERIC_ENUMS[key];
      if (legacy && /^[0-3]$/.test(value)) {
        out.push({ key, severity: "info", code: "LEGACY_NUMERIC", message: `${key}=${value} is the legacy numeric form of "${legacy[Number(value)]}".` });
        return;
      }
      out.push({ key, severity: "error", code: "INVALID_ENUM", message: `${key} must be one of: ${values.join(", ")}.` });
      return;
    }
    case "string":
      return;
  }
}

function checkSpecial(key: string, value: string, version: string, out: PropertyIssue[]): void {
  switch (key) {
    case "resource-pack":
      if (value !== "" && !/^https?:\/\/\S+$/i.test(value)) out.push({ key, severity: "error", code: "INVALID_URL", message: "resource-pack must be an http(s) URL." });
      return;
    case "resource-pack-sha1":
      if (value !== "" && !/^[a-fA-F0-9]{40}$/.test(value)) out.push({ key, severity: "error", code: "INVALID_SHA1", message: "resource-pack-sha1 must be 40 hexadecimal characters." });
      return;
    case "resource-pack-id":
      if (value !== "" && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
        out.push({ key, severity: "error", code: "INVALID_UUID", message: "resource-pack-id must be a UUID." });
      }
      return;
    case "level-name": {
      const err = validateLevelName(value);
      if (err) out.push({ key, severity: "error", code: "INVALID_LEVEL_NAME", message: err });
      return;
    }
    case "level-type": {
      const r = validateLevelType(value, version);
      if (r.message && r.severity !== "ok") out.push({ key, severity: r.severity, code: "LEVEL_TYPE", message: r.message });
      return;
    }
    case "level-seed": {
      const r = validateSeed(value);
      if (!r.ok) out.push({ key, severity: "error", code: "INVALID_SEED", message: r.message ?? "Invalid seed." });
      else if (r.message) out.push({ key, severity: "info", code: "SEED_INFO", message: r.message });
      return;
    }
  }
}

const bool = (v: string | undefined) => (v === undefined ? undefined : v.toLowerCase() === "true");

/**
 * Validates a set of properties for a Minecraft version. Unknown keys are preserved and reported
 * as warnings only (mods/forks add their own keys).
 */
export function validateProperties(values: Readonly<Record<string, string>>, minecraftVersion: string, opts: ValidateOptions = {}): ValidationResult {
  const issues: PropertyIssue[] = [];
  const flagManaged = opts.flagPlatformManaged ?? true;
  const ordered = isAtLeast(minecraftVersion, "1.14");
  if (ordered === null) {
    issues.push({ key: "", severity: "info", code: "VERSION_UNORDERED", message: `Cannot order "${minecraftVersion}"; version-specific checks were skipped.` });
  } else if (!ordered) {
    issues.push({ key: "", severity: "info", code: "SCHEMA_UNVERIFIED", message: "The property schema was verified against Minecraft 1.14 and newer only." });
  }

  for (const [key, value] of Object.entries(values)) {
    const spec = PROPERTY_SCHEMA.get(key);
    if (!spec) {
      issues.push({ key, severity: "warning", code: "UNKNOWN_KEY", message: `${key} is not a vanilla property; it is kept as-is.` });
      continue;
    }
    if (ordered !== null) {
      if (spec.since && isAtLeast(minecraftVersion, spec.since) === false) {
        issues.push({ key, severity: "warning", code: "NOT_IN_VERSION", message: `${key} was added in ${spec.since}; ${minecraftVersion} ignores it.` });
      }
      if (spec.removedIn && isAtLeast(minecraftVersion, spec.removedIn) === true) {
        issues.push({
          key,
          severity: "warning",
          code: "REMOVED_IN_VERSION",
          message: `${key} is no longer read since ${spec.removedIn}${spec.replacedBy ? `; use ${spec.replacedBy}` : ""}.`,
        });
      }
    }
    if (spec.platformManaged && flagManaged) {
      issues.push({ key, severity: "warning", code: "PLATFORM_MANAGED", message: `${key} is managed by BlockForge and will be overwritten.` });
    }
    checkType(spec, value, issues);
    checkSpecial(key, value, minecraftVersion, issues);
  }

  const view = values["view-distance"];
  const sim = values["simulation-distance"];
  if (view !== undefined && sim !== undefined && INT.test(view) && INT.test(sim) && Number(sim) > Number(view)) {
    issues.push({ key: "simulation-distance", severity: "warning", code: "SIMULATION_EXCEEDS_VIEW", message: "simulation-distance above view-distance has no effect beyond the view distance." });
  }
  if (bool(values["enforce-whitelist"]) === true && bool(values["white-list"]) === false) {
    issues.push({ key: "enforce-whitelist", severity: "warning", code: "ENFORCE_WITHOUT_WHITELIST", message: "enforce-whitelist has no effect while white-list is false." });
  }
  if (bool(values["require-resource-pack"]) === true && (values["resource-pack"] ?? "") === "") {
    issues.push({ key: "require-resource-pack", severity: "warning", code: "REQUIRED_PACK_WITHOUT_URL", message: "require-resource-pack is set but resource-pack is empty." });
  }
  if (bool(values["online-mode"]) === false && !opts.behindProxy) {
    issues.push({
      key: "online-mode",
      severity: "warning",
      code: "OFFLINE_MODE",
      message: "online-mode=false lets anyone join with any name (no Mojang authentication). Only use it behind a proxy with forwarding and network isolation.",
    });
  }
  if (bool(values["enable-rcon"]) === true && (values["rcon.password"] ?? "") === "") {
    issues.push({ key: "rcon.password", severity: "error", code: "RCON_WITHOUT_PASSWORD", message: "RCON is enabled without a password." });
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues };
}
