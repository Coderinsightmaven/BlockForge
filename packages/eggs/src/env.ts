import type { Template } from "@blockforge/contracts";

/**
 * Environment of an egg workload. Mirrors Pterodactyl (`EnvironmentService` + Wings): every
 * template variable (`value ?? default`), then the platform values, which always win:
 * `STARTUP` (verbatim — the yolk entrypoint turns `{{VAR}}` into `${VAR}` and evals it),
 * `SERVER_MEMORY` (MiB), `SERVER_IP`, `SERVER_PORT`, `P_SERVER_UUID`, `P_SERVER_LOCATION`,
 * `P_SERVER_ALLOCATION_LIMIT`, `TZ`.
 */
export interface EggEnvironmentInput {
  template: Pick<Template, "startup" | "variables">;
  /** User-supplied values by env name. Unknown names are ignored. */
  values: Readonly<Record<string, string>>;
  memoryLimitBytes: number;
  primary: { ip: string; port: number };
  serverId: string;
  location: string | null;
  allocationLimit: number;
  timezone: string;
}

export class EggEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EggEnvironmentError";
  }
}

export function memoryMiB(memoryLimitBytes: number): number {
  return Math.floor(memoryLimitBytes / (1024 * 1024));
}

export function buildEggEnvironment(input: EggEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of input.template.variables) {
    const value = Object.prototype.hasOwnProperty.call(input.values, v.envName) ? input.values[v.envName]! : v.defaultValue;
    env[v.envName] = value;
  }
  Object.assign(env, {
    STARTUP: input.template.startup,
    SERVER_MEMORY: String(memoryMiB(input.memoryLimitBytes)),
    SERVER_IP: input.primary.ip,
    SERVER_PORT: String(input.primary.port),
    P_SERVER_UUID: input.serverId,
    P_SERVER_LOCATION: input.location ?? "",
    P_SERVER_ALLOCATION_LIMIT: String(input.allocationLimit),
    TZ: input.timezone,
  });
  for (const [k, v] of Object.entries(env)) {
    if (v.includes("\0")) throw new EggEnvironmentError(`environment variable ${k} contains a NUL byte`);
  }
  return env;
}

export const HIDDEN_VALUE = "[hidden]";

/**
 * Startup command for display (Pterodactyl `StartupCommandService`): `{{VAR}}` of template
 * variables become their value, or `[hidden]` when `isViewable(envName)` is false; other
 * `{{NAME}}` placeholders are replaced from `values` (e.g. SERVER_MEMORY/SERVER_PORT from the
 * server's environment) and otherwise left as written.
 */
export function resolveStartupForDisplay(
  template: Pick<Template, "startup" | "variables">,
  values: Readonly<Record<string, string>>,
  isViewable: (envName: string) => boolean,
): string {
  const vars = new Map(template.variables.map((v) => [v.envName, v]));
  return template.startup.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const v = vars.get(name);
    const has = Object.prototype.hasOwnProperty.call(values, name);
    if (v) {
      if (!isViewable(name)) return HIDDEN_VALUE;
      return has ? values[name]! : v.defaultValue;
    }
    return has ? values[name]! : whole;
  });
}
