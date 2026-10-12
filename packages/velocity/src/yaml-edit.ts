import { YamlEditError, parseYamlStrict, yamlMaskPaths, yamlSetMany, type YamlSetValue } from "@blockforge/eggs";
import type { Document } from "yaml";

/**
 * Comment- and byte-preserving YAML edits for backend configs (paper-global.yml, paper.yml,
 * spigot.yml, BungeeGuard). Uses the shared source-level editor from `@blockforge/eggs`:
 * existing scalars are replaced in place, missing keys are inserted as new lines in the deepest
 * existing block mapping, a UTF-8 BOM and CRLF line endings are kept. The document is **never**
 * re-serialised: when an edit cannot be expressed at the source level (flow mappings, writing
 * through a scalar) `editYaml` throws `YamlEditError` (fail closed) and the plan blocks that server.
 */

export { YamlEditError };

export type YamlValue = YamlSetValue;

export interface YamlEdit {
  path: readonly (string | number)[];
  value: YamlValue;
}

export function parseYaml(text: string): Document {
  return parseYamlStrict(text.startsWith("\uFEFF") ? text.slice(1) : text);
}

/**
 * Applies edits; `null` text = file does not exist yet (it is created from the edits).
 * Returns the original text unchanged when every value already matches.
 */
export function editYaml(text: string | null, edits: readonly YamlEdit[]): { content: string; changed: boolean; created: boolean } {
  const created = text === null || text.trim() === "";
  const r = yamlSetMany(text ?? "", edits, { fallback: "fail" });
  if (!r.changed) return { content: text ?? "", changed: false, created: false };
  return { content: r.text, changed: true, created };
}

/** Replaces scalar values at `paths` (and every item of sequences there) with `mask`, in place. */
export function maskYamlPaths(text: string, paths: readonly (readonly (string | number)[])[], mask: string): string {
  return yamlMaskPaths(text, paths, mask);
}
