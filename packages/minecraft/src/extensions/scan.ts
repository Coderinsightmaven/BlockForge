import type { ServerSoftware } from "@blockforge/contracts";
import { modrinthLoaderProfile } from "../modrinth/loaders.js";
import { isSafeJarFilename } from "../modrinth/plan.js";

/** Minimal shape of an agent `fs.list` entry (contracts `FileEntry`). */
export interface ListedFile {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
}

/** A jar found in `plugins/` or `mods/`. `.jar.disabled` files are disabled extensions. */
export interface ExtensionFileCandidate {
  /** Relative to the data root, e.g. `plugins/LuckPerms-Bukkit-5.5.71.jar`. */
  path: string;
  name: string;
  sizeBytes: number;
  enabled: boolean;
}

export const DISABLED_SUFFIX = ".disabled";
const MAX_ENTRIES = 4096;

/** `plugins` for plugin platforms, `mods` for mod loaders, null for vanilla. */
export function extensionDirFor(software: ServerSoftware): "plugins" | "mods" | null {
  return modrinthLoaderProfile(software)?.installDir ?? null;
}

/**
 * Picks the extension jars out of a directory listing of `plugins/` or `mods/`. Symlinks,
 * directories, empty files and names that are not safe single path components are skipped
 * (with a reason) — they are never hashed or opened.
 */
export function selectExtensionFiles(
  dir: "plugins" | "mods",
  entries: readonly ListedFile[],
): { files: ExtensionFileCandidate[]; skipped: Array<{ name: string; reason: "not-a-jar" | "symlink" | "not-a-file" | "empty" | "unsafe-name" | "too-many" }> } {
  const files: ExtensionFileCandidate[] = [];
  const skipped: Array<{ name: string; reason: "not-a-jar" | "symlink" | "not-a-file" | "empty" | "unsafe-name" | "too-many" }> = [];
  for (const [i, e] of entries.entries()) {
    const lower = e.name.toLowerCase();
    const enabled = lower.endsWith(".jar");
    const disabled = lower.endsWith(`.jar${DISABLED_SUFFIX}`);
    if (!enabled && !disabled) {
      if (e.type === "file") skipped.push({ name: e.name, reason: "not-a-jar" });
      continue;
    }
    if (i >= MAX_ENTRIES) {
      skipped.push({ name: e.name, reason: "too-many" });
      continue;
    }
    if (e.type === "symlink") skipped.push({ name: e.name, reason: "symlink" });
    else if (e.type !== "file") skipped.push({ name: e.name, reason: "not-a-file" });
    else if (e.size <= 0) skipped.push({ name: e.name, reason: "empty" });
    else if (!isSafeJarFilename(disabled ? e.name.slice(0, -DISABLED_SUFFIX.length) : e.name)) skipped.push({ name: e.name, reason: "unsafe-name" });
    else files.push({ path: `${dir}/${e.name}`, name: e.name, sizeBytes: e.size, enabled });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { files, skipped };
}

/** Rename target to enable/disable an extension jar (`x.jar` ⇄ `x.jar.disabled`); null when already in that state. */
export function toggledExtensionPath(path: string, enable: boolean): string | null {
  const isDisabled = path.toLowerCase().endsWith(`.jar${DISABLED_SUFFIX}`);
  if (enable) return isDisabled ? path.slice(0, -DISABLED_SUFFIX.length) : null;
  return isDisabled || !path.toLowerCase().endsWith(".jar") ? null : `${path}${DISABLED_SUFFIX}`;
}
