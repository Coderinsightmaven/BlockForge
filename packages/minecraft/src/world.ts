import { hasControlChars } from "./util.js";
import { isAtLeast } from "./versions.js";

/**
 * World settings helpers.
 *
 * Seeds (vanilla `WorldOptions.parseSeed`, 1.19+; same behaviour earlier): the string is trimmed;
 * empty → random; a valid Java `long` → that number; anything else → `String.hashCode()` (so
 * text seeds only cover 2^32 distinct worlds).
 */
export interface SeedInfo {
  ok: boolean;
  kind: "random" | "numeric" | "text";
  /** Effective numeric seed as a decimal string (null for random). */
  effectiveSeed: string | null;
  message: string | null;
}

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

/** Java `String.hashCode()` (UTF-16 code units, 32-bit overflow). */
export function javaStringHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function validateSeed(seed: string, maxLength = 64): SeedInfo {
  if (hasControlChars(seed)) return { ok: false, kind: "text", effectiveSeed: null, message: "Seed must not contain control characters or line breaks." };
  if (seed.length > maxLength) return { ok: false, kind: "text", effectiveSeed: null, message: `Seed is longer than ${maxLength} characters.` };
  const t = seed.trim();
  if (t === "") return { ok: true, kind: "random", effectiveSeed: null, message: null };
  if (/^[+-]?\d+$/.test(t)) {
    const n = BigInt(t);
    if (n >= LONG_MIN && n <= LONG_MAX) return { ok: true, kind: "numeric", effectiveSeed: n.toString(), message: null };
    return {
      ok: true,
      kind: "text",
      effectiveSeed: String(javaStringHashCode(t)),
      message: "Number is outside the 64-bit range, so Minecraft hashes it as text.",
    };
  }
  return {
    ok: true,
    kind: "text",
    effectiveSeed: String(javaStringHashCode(t)),
    message: "Text seeds are hashed with String.hashCode() (2^32 possible worlds).",
  };
}

/** Built-in world presets in 1.19+ (verified in the 26.3 jar's WorldPresets). */
export const WORLD_PRESETS = [
  "minecraft:normal",
  "minecraft:flat",
  "minecraft:large_biomes",
  "minecraft:amplified",
  "minecraft:single_biome_surface",
  "minecraft:debug_all_block_states",
] as const;

/** Legacy names still accepted by 1.19+ (`default` → normal, `largebiomes` → large_biomes). */
const LEGACY_ALIASES: Record<string, string> = { default: "minecraft:normal", largebiomes: "minecraft:large_biomes" };

/**
 * Pre-1.19 values (case-insensitive). Best effort from the Minecraft Wiki — not verified against
 * the jars; older servers silently fall back to the default type for unknown values.
 */
export function legacyLevelTypes(version: string): string[] {
  if (isAtLeast(version, "1.16") === true) return ["default", "flat", "largebiomes", "amplified", "debug_all_block_states"];
  if (isAtLeast(version, "1.13") === true) return ["default", "flat", "largebiomes", "amplified", "buffet", "default_1_1"];
  return ["default", "flat", "largebiomes", "amplified", "customized", "default_1_1"];
}

export interface LevelTypeCheck {
  severity: "ok" | "info" | "warning" | "error";
  /** Canonical value to store (may equal the input). */
  normalized: string;
  message: string | null;
}

export function validateLevelType(value: string, version: string): LevelTypeCheck {
  const v = value.trim();
  if (v === "") return { severity: "ok", normalized: "", message: null };
  const modern = isAtLeast(version, "1.19");
  if (modern === false) {
    const ok = legacyLevelTypes(version).includes(v.toLowerCase());
    return ok
      ? { severity: "ok", normalized: v, message: null }
      : { severity: "warning", normalized: v, message: `Unknown level type for ${version}; the server falls back to the default world type.` };
  }
  const lower = v.toLowerCase();
  const alias = LEGACY_ALIASES[lower];
  if (alias) return { severity: "info", normalized: alias, message: `Legacy name "${v}" is accepted and maps to ${alias}.` };
  const id = v.includes(":") ? v : `minecraft:${v}`;
  if ((WORLD_PRESETS as readonly string[]).includes(id)) {
    if (id === "minecraft:debug_all_block_states") return { severity: "warning", normalized: id, message: "Debug world: not playable, only for inspecting block states." };
    return { severity: "ok", normalized: id, message: null };
  }
  if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)) {
    return { severity: "warning", normalized: id, message: `"${id}" is not a built-in preset; it only works if a datapack provides it.` };
  }
  return { severity: "error", normalized: v, message: `Invalid level type "${v}". Use one of ${WORLD_PRESETS.join(", ")}.` };
}

/** World folder name: a single safe path segment (level-name). */
export function validateLevelName(name: string): string | null {
  if (name.length === 0) return "World name must not be empty.";
  if (name.length > 64) return "World name must be at most 64 characters.";
  if (name === "." || name === "..") return "World name must not be '.' or '..'.";
  if (hasControlChars(name) || /[\\/:*?"<>|]/.test(name)) return "World name must be a single folder name without / \\ : * ? \" < > | or control characters.";
  return null;
}
