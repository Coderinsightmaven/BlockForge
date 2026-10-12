import { compileDenylist } from "@blockforge/contracts";
import { BACKEND_FILES, redactFileForDisplay } from "@blockforge/velocity";

/** Normalises a workload-relative path: forward slashes, no leading "./" or "/", no trailing "/". */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

/**
 * Template `fileDenylist` check via the contracts matcher (`compileDenylist`), byte-compatible with
 * the agent's SFTP matcher (shared fixture `fixtures/denylist.json`).
 */
export function isDenied(path: string, patterns: readonly string[]): boolean {
  if (!patterns.length) return false;
  return compileDenylist(patterns).denied(normalizePath(path));
}

/** Files that may contain proxy forwarding secrets (redacted for users without `secrets.read`). */
export const SECRET_BEARING_FILES: readonly string[] = [
  "forwarding.secret",
  "velocity.toml",
  BACKEND_FILES.paperGlobal,
  BACKEND_FILES.paperLegacy,
  BACKEND_FILES.bungeeGuard,
  BACKEND_FILES.fabricProxyLite,
  BACKEND_FILES.pcf,
];

export function isSecretBearing(path: string): boolean {
  const norm = normalizePath(path);
  const name = norm.split("/").pop() ?? norm;
  return SECRET_BEARING_FILES.includes(norm) || name === "forwarding.secret";
}

export function redactForDisplay(path: string, content: string): { content: string; redacted: boolean } {
  return redactFileForDisplay(normalizePath(path), content);
}
