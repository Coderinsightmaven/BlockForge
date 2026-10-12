import { RESERVED_ENV_VARS, TEMPLATE_PLACEHOLDERS } from "@blockforge/contracts";

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

const ENV_PREFIXES = ["server.build.env.", "server.environment.", "server.build.environment.", "env."] as const;

/** Names every template may reference even though they are not declared variables. */
export const PLATFORM_ENV_NAMES: readonly string[] = RESERVED_ENV_VARS;

export function envNameOfPlaceholder(key: string): string | null {
  for (const p of ENV_PREFIXES) if (key.startsWith(p)) return key.slice(p.length);
  return null;
}

const KNOWN_STATIC = new Set<string>([
  ...TEMPLATE_PLACEHOLDERS,
  "server.allocations.default.ip",
  "server.allocations.default.port",
  "server.build.memory_limit",
  "config.docker.network.interface",
]);

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

/** Replaces known placeholders; returns the result and the unresolved keys. */
export function resolvePlaceholders(text: string, ctx: PlaceholderContext): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const value = text.replace(PLACEHOLDER_PATTERN, (whole, key: string) => {
    const v = resolvePlaceholderKey(key, ctx);
    if (v === null) {
      unresolved.push(key);
      return whole;
    }
    return v;
  });
  return { value, unresolved };
}

/** All placeholder keys in a string, in order of appearance. */
export function placeholderKeys(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]!);
}
