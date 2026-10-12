import type { ConfigFileRule } from "@blockforge/contracts";
import { getProperty, parseProperties, serializeProperties, setProperties } from "@blockforge/minecraft";
import { type PlaceholderContext, escapeReplacementTemplate, hasLineBreakingControl, resolvePlaceholders, resolvePlaceholdersQuoted } from "../placeholders.js";
import { YamlEditError, parseYamlStrict, yamlSetMany } from "../yaml-source.js";
import { editIni } from "./ini.js";
import { type Replacement, applyReplacements } from "./paths.js";
import { XmlEditError, editXml } from "./xml.js";
import { jsonSetInSource } from "../json-source.js";

export interface ConfigFileResult {
  content: string;
  changed: boolean;
  warnings: string[];
}

/** Largest file the parsers will rewrite (fs.read returns at most 5 MiB). */
export const MAX_CONFIG_FILE_BYTES = 8 * 1024 * 1024;

/**
 * `find` → replacement list with placeholders resolved (Pterodactyl `EggConfigurationService`):
 * a string value replaces unconditionally; a map value yields one conditional replacement per
 * entry (`current value → replacement`, `regex:<expr>` keys for json/yaml).
 */
export function resolveReplacements(
  rule: Pick<ConfigFileRule, "find"> & Partial<Pick<ConfigFileRule, "parser">>,
  ctx: PlaceholderContext,
): { replacements: Replacement[]; unresolved: string[] } {
  const replacements: Replacement[] = [];
  const unresolved: string[] = [];
  const one = (match: string, ifValue: string | null, template: string): Replacement => {
    if (rule.parser === "file") {
      // Line-oriented files: values are escaped for their quote context or refused.
      const r = resolvePlaceholdersQuoted(template, ctx);
      unresolved.push(...r.unresolved);
      return r.unsafe.length > 0 ? { match, ifValue, replaceWith: r.value, unsafe: r.unsafe } : { match, ifValue, replaceWith: r.value };
    }
    if (rule.parser === "xml") {
      // The attribute form is recognised on the egg-authored template only, never on a user value.
      const attr = /^\[(\w+)='([\s\S]*)'\]$/.exec(template);
      if (attr) {
        const r = resolvePlaceholders(attr[2]!, ctx);
        unresolved.push(...r.unresolved);
        return { match, ifValue, replaceWith: r.value, attribute: attr[1]! };
      }
    }
    const r = resolvePlaceholders(template, ctx, ifValue !== null && ifValue.startsWith("regex:") ? escapeReplacementTemplate : undefined);
    unresolved.push(...r.unresolved);
    return { match, ifValue, replaceWith: r.value };
  };
  for (const [match, spec] of Object.entries(rule.find)) {
    if (typeof spec === "string") {
      replacements.push(one(match, null, spec));
    } else {
      for (const [ifValue, replaceWith] of Object.entries(spec)) {
        // `regex:` conditions use the replacement as a Go template ($1 …): substituted values are
        // escaped so a user value like "$1" or "$'" stays literal; egg-authored "$2" keeps working.
        replacements.push(one(match, ifValue, replaceWith));
      }
    }
  }
  return { replacements, unresolved: [...new Set(unresolved)] };
}

const BOM = "\uFEFF";

function detectJsonIndent(text: string): string | number {
  const m = /^[ \t]*[{[]\s*\r?\n([ \t]+)\S/.exec(text) ?? /\n([ \t]+)"/.exec(text);
  return m ? m[1]! : 4; // Wings writes 4 spaces
}

function applyJson(current: string | null, replacements: Replacement[], warnings: string[]): string | null {
  const src = current ?? "";
  const bom = src.startsWith(BOM);
  const body = bom ? src.slice(1) : src;
  let data: unknown;
  if (body.trim() === "") data = {};
  else {
    try {
      data = JSON.parse(body);
    } catch (e) {
      warnings.push(`file is not valid JSON (${(e as Error).message}); left unchanged`);
      return null;
    }
  }
  if (typeof data !== "object" || data === null) {
    warnings.push("top-level JSON value is not an object or array; left unchanged");
    return null;
  }
  const { edits, warnings: w } = applyReplacements(data as Record<string, unknown>, replacements);
  warnings.push(...w);
  const eol = /\r\n/.test(body) ? "\r\n" : "\n";
  if (edits.length === 0) return current === null ? `{}${eol}` : null;
  // Source-level edits keep the original layout; fall back to re-serialisation (like Wings).
  let text: string | null = body.trim() === "" ? `{}${eol}` : body;
  try {
    for (const e of edits) {
      if (text === null) break;
      text = jsonSetInSource(text, e.path, e.value);
    }
  } catch {
    text = null;
  }
  if (text === null) {
    warnings.push("the file had to be re-serialised; number spellings, \\u escapes and blank lines may change");
    text = JSON.stringify(data, null, detectJsonIndent(body)).replace(/\n/g, eol) + eol;
  }
  return (bom ? BOM : "") + text;
}

function applyYaml(current: string | null, replacements: Replacement[], warnings: string[]): string | null {
  const src = current ?? "";
  let data: unknown;
  try {
    const doc = parseYamlStrict(src.startsWith("\uFEFF") ? src.slice(1) : src);
    data = doc.toJS() ?? {};
  } catch (e) {
    warnings.push(`file is not valid YAML (${(e as Error).message}); left unchanged`);
    return null;
  }
  if (typeof data !== "object" || data === null) {
    warnings.push("top-level YAML value is not a mapping or list; left unchanged");
    return null;
  }
  const { edits, warnings: w } = applyReplacements(data as Record<string, unknown>, replacements);
  warnings.push(...w);
  if (edits.length === 0) return current === null ? "" : null;
  try {
    const r = yamlSetMany(src, edits.map((e) => ({ path: e.path, value: e.value })), { fallback: "reserialize" });
    if (r.reserialized) warnings.push("some keys could not be inserted in place; the file was re-serialised (comments kept, layout may change)");
    return r.changed ? r.text : null;
  } catch (e) {
    if (e instanceof YamlEditError) {
      warnings.push(e.message);
      return null;
    }
    throw e;
  }
}

function applyProperties(current: string | null, replacements: Replacement[], warnings: string[]): string | null {
  let doc;
  try {
    doc = parseProperties(current ?? "");
  } catch (e) {
    warnings.push(`file is not a valid properties file (${(e as Error).message}); left unchanged`);
    return null;
  }
  for (const r of replacements) {
    const cur = getProperty(doc, r.match);
    // Wings compares literally (no regex for properties) and skips missing keys for conditions.
    if (r.ifValue !== null && (cur === undefined || cur !== r.ifValue)) continue;
    if (cur === r.replaceWith) continue;
    // Escape non-ASCII as \uXXXX like Wings: older game servers read properties as ISO-8859-1.
    doc = setProperties(doc, { [r.match]: r.replaceWith }, { asciiOnly: true });
  }
  const out = serializeProperties(doc);
  return out === (current ?? "") && current !== null ? null : out;
}

function applyText(current: string, replacements: Replacement[], warnings: string[]): string | null {
  // Wings: every line that starts with `match` is replaced by `replace_with` (conditions ignored).
  // BlockForge uses only the most specific (longest) matching prefix per line — Wings concatenates
  // all matches into one line — and skips replacements whose values were unsafe.
  const parts = current.split(/(\r\n|\n|\r)/);
  let changed = false;
  const reported = new Set<string>();
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!;
    const hits = replacements.filter((r) => line.startsWith(r.match)).sort((a, b) => b.match.length - a.match.length);
    const r = hits[0];
    if (!r) continue;
    if (r.unsafe && r.unsafe.length > 0) {
      if (!reported.has(r.match)) warnings.push(`line "${r.match}…" not rewritten: ${r.unsafe.join("; ")}`);
      reported.add(r.match);
      continue;
    }
    if (hasLineBreakingControl(r.replaceWith)) {
      if (!reported.has(r.match)) warnings.push(`line "${r.match}…" not rewritten: the replacement contains line breaks or control characters`);
      reported.add(r.match);
      continue;
    }
    if (r.replaceWith !== line) {
      parts[i] = r.replaceWith;
      changed = true;
    }
  }
  return changed ? parts.join("") : null;
}

/**
 * Applies one egg config-file rule to the file's current content (`null` = the file does not
 * exist; it is created, except for the `file` parser, which Wings also skips). Unrelated content,
 * comments and line endings are preserved wherever the format allows. Never throws for bad file
 * content: problems are returned as warnings and the content is left unchanged.
 */
export function applyConfigFileRule(rule: ConfigFileRule, current: string | null, ctx: PlaceholderContext): ConfigFileResult {
  const warnings: string[] = [];
  if (current !== null && current.length > MAX_CONFIG_FILE_BYTES) {
    return { content: current, changed: false, warnings: [`${rule.path} is larger than ${MAX_CONFIG_FILE_BYTES} bytes; not rewritten`] };
  }
  const { replacements, unresolved } = resolveReplacements(rule, ctx);
  for (const u of unresolved) warnings.push(`placeholder {{${u}}} could not be resolved and was left as written`);
  let out: string | null = null;
  try {
    switch (rule.parser) {
      case "properties":
        out = applyProperties(current, replacements, warnings);
        break;
      case "json":
        out = applyJson(current, replacements, warnings);
        break;
      case "yaml":
        out = applyYaml(current, replacements, warnings);
        break;
      case "ini": {
        const r = editIni(current ?? "", replacements.map((x) => ({ match: x.match, ifValue: x.ifValue, value: x.replaceWith })));
        warnings.push(...r.warnings);
        out = r.changed || current === null ? r.text : null;
        break;
      }
      case "xml": {
        try {
          const r = editXml(current ?? "", replacements.map((x) => ({ match: x.match, ifValue: x.ifValue, value: x.replaceWith, attribute: x.attribute ?? null })));
          warnings.push(...r.warnings);
          out = r.changed || current === null ? r.text : null;
        } catch (e) {
          if (!(e instanceof XmlEditError)) throw e;
          warnings.push(`file is not valid XML (${e.message}); left unchanged`);
        }
        break;
      }
      case "file":
        if (current === null) {
          warnings.push(`${rule.path} does not exist yet; text replacements are skipped until it does`);
          return { content: "", changed: false, warnings };
        }
        out = applyText(current, replacements, warnings);
        break;
    }
  } catch (e) {
    warnings.push(`could not apply ${rule.parser} rule to ${rule.path}: ${(e as Error).message}`);
    out = null;
  }
  if (out === null) return { content: current ?? "", changed: false, warnings };
  return { content: out, changed: out !== current, warnings };
}


