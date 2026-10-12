import { redactServerProperties } from "@blockforge/minecraft";
import { BACKEND_FILES } from "./backend-config.js";
import { TomlDocument } from "./toml/document.js";
import { maskYamlPaths } from "./yaml-edit.js";

/**
 * Redaction for displaying secret-bearing files to users without `secrets.read`. Three layers:
 *  1. structural masking of known secret keys per file type (format preserved);
 *  2. a generic line pass masking any `*secret*` / `*token*` / `*password*` assignment;
 *  3. replacement of every occurrence of caller-supplied known secret values anywhere.
 * Layer 3 makes the result safe even for unknown formats when the control plane passes the
 * network's secret(s).
 */
export const REDACTED = "**redacted**";

const YAML_SECRET_PATHS: Record<string, string[][]> = {
  [BACKEND_FILES.paperGlobal]: [["proxies", "velocity", "secret"]],
  [BACKEND_FILES.paperLegacy]: [["settings", "velocity-support", "secret"]],
  [BACKEND_FILES.bungeeGuard]: [["allowed-tokens"]],
};

const TOML_SECRET_KEYS: Record<string, Array<[string[], string]>> = {
  [BACKEND_FILES.fabricProxyLite]: [[[], "secret"]],
  [BACKEND_FILES.pcf]: [[["forwarding"], "secret"]],
  "velocity.toml": [[[], "forwarding-secret"]],
};

const GENERIC = /^(\s*(?:-\s*)?["']?([\w.-]*(?:secret|token|password|passwd)[\w.-]*)["']?\s*[:=]\s*)(.*?)\s*$/i;

/** Masks values of `key: value` / `key = value` lines whose key mentions secret/token/password. */
export function redactGenericLines(text: string): string {
  return text
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === "\n" || part === "\r\n") return part;
      const m = GENERIC.exec(part);
      if (!m) return part;
      if (/(?:file|path)$/i.test(m[2]!)) return part; // e.g. forwarding-secret-file names a file, not a secret
      const value = m[3]!;
      if (value === "" || value === "''" || value === '""' || value === "[]" || value.startsWith("#")) return part;
      const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
      return `${m[1]}${q}${REDACTED}${q}`;
    })
    .join("");
}

export function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 6) continue; // too short to replace safely
    out = out.split(s).join(REDACTED);
  }
  return out;
}

function structural(path: string, text: string): string {
  const base = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const name = base.split("/").pop() ?? base;
  if (name === "forwarding.secret") return text.length > 0 ? REDACTED : text;
  if (base === "server.properties") return redactServerProperties(text, REDACTED);
  const yamlPaths = YAML_SECRET_PATHS[base];
  if (yamlPaths) return maskYamlPaths(text, yamlPaths, REDACTED);
  const tomlKeys = TOML_SECRET_KEYS[base];
  if (tomlKeys) {
    const doc = TomlDocument.parse(text);
    for (const [table, key] of tomlKeys) {
      const v = doc.get(table, key);
      if (typeof v === "string" && v !== "") doc.setValue(table, key, REDACTED);
    }
    return doc.toString();
  }
  return text;
}

export interface RedactOptions {
  /** Secret values to remove wherever they appear (e.g. the network's forwarding secret). */
  knownSecrets?: readonly string[];
  /** Additional file names that hold a raw secret (custom `forwarding-secret-file`). */
  secretFiles?: readonly string[];
}

/** Redacts any file for display. Never throws: unparsable files fall back to layers 2 and 3. */
export function redactFileForDisplay(path: string, text: string, opts: RedactOptions = {}): { content: string; redacted: boolean } {
  let out: string;
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  if (opts.secretFiles?.includes(name) || opts.secretFiles?.includes(path)) out = text.length > 0 ? REDACTED : text;
  else {
    try {
      out = structural(path, text);
    } catch {
      out = text;
    }
  }
  out = redactGenericLines(out);
  out = redactKnownSecrets(out, opts.knownSecrets ?? []);
  return { content: out, redacted: out !== text };
}
