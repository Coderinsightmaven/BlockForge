/** Paths are relative to the server's data root, "/"-separated, without leading slash. "" = root. */

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

export function joinPath(dir: string, name: string): string {
  const d = normalizePath(dir);
  const n = normalizePath(name);
  return d ? (n ? `${d}/${n}` : d) : n;
}

export function parentPath(p: string): string {
  const parts = normalizePath(p).split("/");
  parts.pop();
  return parts.join("/");
}

export function baseName(p: string): string {
  const parts = normalizePath(p).split("/");
  return parts[parts.length - 1] ?? "";
}

export function breadcrumbs(p: string): Array<{ name: string; path: string }> {
  const parts = normalizePath(p).split("/").filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}

/** A single new file/folder name (no separators). Returns an error message or null. */
export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n === "." || n === "..") return "That name is reserved.";
  if (/[/\\\0]/.test(n)) return "Names cannot contain / or \\.";
  if (n.length > 255) return "At most 255 characters.";
  return null;
}

/** A relative destination path for rename/move. Returns an error message or null. */
export function validateRelativePath(p: string): string | null {
  const raw = p.trim();
  if (!raw) return "Enter a path.";
  if (/^([/\\]|[a-zA-Z]:)/.test(raw)) return "Use a path relative to the server root.";
  if (raw.includes("\0")) return "Invalid character.";
  const parts = raw.split(/[/\\]/);
  if (parts.includes("..")) return "'..' is not allowed.";
  if (normalizePath(raw) === "") return "That is the server root.";
  return null;
}

const ARCHIVE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|gz|rar|7z)$/i;
export function isArchive(name: string): boolean {
  return ARCHIVE.test(name);
}

const TEXT_EXT =
  /\.(txt|log|md|properties|cfg|conf|config|ini|toml|ya?ml|json5?|xml|html?|css|js|mjs|cjs|ts|sh|bash|bat|cmd|ps1|env|lang|mcmeta|sk|lua|py|java|kt|gradle|csv|tsv|sql|nbt\.txt|secret|whitelist|ops|banned-players|banned-ips|example|default)$/i;
const TEXT_NAMES = new Set([
  "eula.txt",
  "server.properties",
  "dockerfile",
  "makefile",
  "readme",
  "license",
  ".env",
]);

/** Whether to open in the editor (vs. download). The server still refuses binary/oversized files. */
export function isLikelyText(name: string): boolean {
  const n = name.toLowerCase();
  return TEXT_NAMES.has(n) || TEXT_EXT.test(n) || !n.includes(".");
}

export const EDITOR_MAX_BYTES = 5 * 1024 * 1024;

export type EditorLanguage = "json" | "yaml" | "properties" | "toml" | "shell" | "plain";

export function languageFor(name: string): EditorLanguage {
  const n = name.toLowerCase();
  if (/\.(json5?|mcmeta)$/.test(n)) return "json";
  if (/\.ya?ml$/.test(n)) return "yaml";
  if (/\.(properties|lang|ini|cfg|conf|env)$/.test(n) || n === "eula.txt") return "properties";
  if (/\.toml$/.test(n)) return "toml";
  if (/\.(sh|bash)$/.test(n)) return "shell";
  return "plain";
}
