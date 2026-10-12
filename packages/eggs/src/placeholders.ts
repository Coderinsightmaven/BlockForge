import { RESERVED_ENV_VARS, TEMPLATE_PLACEHOLDERS, TEMPLATE_PLACEHOLDER_PREFIXES } from "@blockforge/contracts";

/**
 * `{{…}}` placeholders in config-file rules (Pterodactyl `EggConfigurationService` +
 * Wings `LookupConfigurationValue`, Pelican `EggImporterService::UPGRADE_VARIABLES`):
 *  - `server.build.default.ip|port`, `server.build.memory`, `server.uuid`, `server.name`;
 *  - `server.build.env.X`, `env.X` and Pelican's `server.environment.X` → the server's variable X
 *    (`env.SERVER_MEMORY`/`SERVER_IP`/`SERVER_PORT` are the legacy platform values);
 *  - Pelican's `server.allocations.default.ip|port`, `server.build.memory_limit`;
 *  - `config.docker.interface` (also `config.docker.network.interface`) → the address containers
 *    use to reach the host (Wings: `docker.network.interface`).
 * Unknown placeholders are left untouched (Pterodactyl would substitute an empty string; keeping
 * them makes the problem visible) and reported.
 */
export interface PlaceholderContext {
  serverId: string;
  serverName: string;
  primary: { ip: string; port: number };
  /** Memory limit in MiB (Pterodactyl `server.build.memory`). */
  memoryMiB: number;
  /** The server's environment (usually `buildEggEnvironment(…)`), used for env placeholders. */
  env: Readonly<Record<string, string>>;
  /** `{{config.docker.interface}}`; null = unknown on this node (placeholder left unresolved). */
  dockerInterface: string | null;
}

export const PLACEHOLDER_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Contract prefixes plus Pelican's legacy `server.build.environment.` spelling (upgraded by its importer). */
const ENV_PREFIXES: readonly string[] = [...TEMPLATE_PLACEHOLDER_PREFIXES, "server.build.environment."].sort((a, b) => b.length - a.length);

/** Names every template may reference even though they are not declared variables. */
export const PLATFORM_ENV_NAMES: readonly string[] = RESERVED_ENV_VARS;

export function envNameOfPlaceholder(key: string): string | null {
  for (const p of ENV_PREFIXES) if (key.startsWith(p)) return key.slice(p.length);
  return null;
}

const KNOWN_STATIC = new Set<string>([...TEMPLATE_PLACEHOLDERS, "config.docker.network.interface"]);

/** Whether a config-file placeholder key is resolvable for a template declaring `variableNames`. */
export function isKnownConfigPlaceholder(key: string, variableNames: ReadonlySet<string>): boolean {
  if (KNOWN_STATIC.has(key)) return true;
  const env = envNameOfPlaceholder(key);
  return env !== null && (variableNames.has(env) || PLATFORM_ENV_NAMES.includes(env));
}

export function resolvePlaceholderKey(key: string, ctx: PlaceholderContext): string | null {
  switch (key) {
    case "server.build.default.ip":
    case "server.allocations.default.ip":
    case "server.build.env.SERVER_IP":
    case "env.SERVER_IP":
      return ctx.primary.ip;
    case "server.build.default.port":
    case "server.allocations.default.port":
    case "server.build.env.SERVER_PORT":
    case "env.SERVER_PORT":
      return String(ctx.primary.port);
    case "server.build.memory":
    case "server.build.memory_limit":
    case "server.build.env.SERVER_MEMORY":
    case "env.SERVER_MEMORY":
      return String(ctx.memoryMiB);
    case "server.uuid":
      return ctx.serverId;
    case "server.name":
      return ctx.serverName;
    case "config.docker.interface":
    case "config.docker.network.interface":
      return ctx.dockerInterface;
  }
  const env = envNameOfPlaceholder(key);
  if (env !== null && Object.prototype.hasOwnProperty.call(ctx.env, env)) return ctx.env[env]!;
  return null;
}

/**
 * Replaces known placeholders; returns the result and the unresolved keys. `escape` transforms
 * each substituted VALUE (never the egg-authored text around it), e.g. `$` → `$$` when the result
 * is used as a regex replacement template.
 */
export function resolvePlaceholders(
  text: string,
  ctx: PlaceholderContext,
  escape: (value: string) => string = (v) => v,
): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  // A replacer function: `$` sequences in values are never interpreted by String.replace.
  const value = text.replace(PLACEHOLDER_PATTERN, (whole: string, key: string) => {
    const v = resolvePlaceholderKey(key, ctx);
    if (v === null) {
      unresolved.push(key);
      return whole;
    }
    return escape(v);
  });
  return { value, unresolved };
}

/** Escapes `$` for Go/RE2 replacement templates. */
export function escapeReplacementTemplate(value: string): string {
  return value.replace(/\$/g, "$$$$");
}

/** All placeholder keys in a string, in order of appearance. */
export function placeholderKeys(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]!);
}

/** C0 control characters (except TAB) and DEL — never allowed in line-oriented config values. */
export function hasLineBreakingControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return true;
  }
  return false;
}

export interface QuotedResolution {
  value: string;
  unresolved: string[];
  /** Placeholders whose value cannot be inserted safely at their position (with the reason). */
  unsafe: string[];
}

/**
 * Resolves placeholders in a line-oriented template (the `file` parser), escaping each value for
 * its position in the egg-authored text: inside "…" `\\` and `"` are backslash-escaped, inside '…'
 * `\\` and `'` are; outside quotes values containing `"`, `'`, `;` or `\\` are refused (they
 * could start a new token or command). Values with control characters are always refused.
 */
export function resolvePlaceholdersQuoted(text: string, ctx: PlaceholderContext): QuotedResolution {
  const unresolved: string[] = [];
  const unsafe: string[] = [];
  let out = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  const re = new RegExp(PLACEHOLDER_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  const advance = (to: number) => {
    for (; i < to; i++) {
      const c = text[i]!;
      out += c;
      if (c === "\\" && quote !== "'") {
        if (i + 1 < to) out += text[++i]!;
        continue;
      }
      if (quote === null && (c === '"' || c === "'")) quote = c;
      else if (quote !== null && c === quote) quote = null;
    }
  };
  while ((m = re.exec(text)) !== null) {
    advance(m.index);
    const key = m[1]!;
    const v = resolvePlaceholderKey(key, ctx);
    i = m.index + m[0].length;
    if (v === null) {
      unresolved.push(key);
      out += m[0];
      continue;
    }
    if (hasLineBreakingControl(v)) {
      unsafe.push(`{{${key}}} contains line breaks or control characters`);
      out += m[0];
      continue;
    }
    if (quote === '"') out += v.replace(/[\\"]/g, (c) => `\\${c}`);
    else if (quote === "'") out += v.replace(/[\\']/g, (c) => `\\${c}`);
    else if (/["';\\]/.test(v)) {
      unsafe.push(`{{${key}}} is used outside quotes and its value contains quotes, ";" or "\\"`);
      out += m[0];
    } else out += v;
  }
  advance(text.length);
  return { value: out, unresolved, unsafe };
}
