import type { ServerSoftware } from "@blockforge/contracts";

export type ExtensionKind = "plugin" | "mod";

/** Which Modrinth versions can run on a BlockForge server software, and where they go. */
export interface ModrinthLoaderProfile {
  software: ServerSoftware;
  kind: ExtensionKind;
  /** Modrinth `project_type` facet. */
  projectType: "plugin" | "mod";
  /** Modrinth loader tags that run on this software, in preference order. */
  loaders: readonly string[];
  /** Loader tags accepted with a warning (Quilt-only builds on Fabric). */
  loadersWithWarning: readonly string[];
  /** Install directory relative to the data root. */
  installDir: "plugins" | "mods";
  /**
   * Whether versions are filtered by the server's Minecraft version. False for Velocity: its
   * plugins target the proxy API, and BlockForge stores the Velocity version, not a game version.
   */
  filterGameVersion: boolean;
}

const plugin = (software: ServerSoftware, loaders: string[], filterGameVersion = true): ModrinthLoaderProfile => ({
  software,
  kind: "plugin",
  projectType: "plugin",
  loaders,
  loadersWithWarning: [],
  installDir: "plugins",
  filterGameVersion,
});
const mod = (software: ServerSoftware, loaders: string[], loadersWithWarning: string[] = []): ModrinthLoaderProfile => ({
  software,
  kind: "mod",
  projectType: "mod",
  loaders,
  loadersWithWarning,
  installDir: "mods",
  filterGameVersion: true,
});

/**
 * BlockForge software → Modrinth loaders. Paper runs Bukkit/Spigot plugins; Purpur additionally
 * runs Purpur-specific ones; Folia only runs plugins explicitly tagged `folia` (regionised
 * threading breaks ordinary plugins); Spigot runs Spigot/Bukkit plugins. Fabric accepts
 * Quilt-tagged builds only with a warning (Quilt Loader runs Fabric mods, not the other way
 * round). Vanilla datapacks are out of scope for now.
 */
export const MODRINTH_LOADER_PROFILES: Readonly<Record<ServerSoftware, ModrinthLoaderProfile | null>> = {
  vanilla: null,
  paper: plugin("paper", ["paper", "spigot", "bukkit"]),
  purpur: plugin("purpur", ["purpur", "paper", "spigot", "bukkit"]),
  folia: plugin("folia", ["folia"]),
  spigot: plugin("spigot", ["spigot", "bukkit"]),
  velocity: plugin("velocity", ["velocity"], false),
  fabric: mod("fabric", ["fabric"], ["quilt"]),
  forge: mod("forge", ["forge"]),
  neoforge: mod("neoforge", ["neoforge"]),
};

export function modrinthLoaderProfile(software: ServerSoftware): ModrinthLoaderProfile | null {
  return MODRINTH_LOADER_PROFILES[software] ?? null;
}

/** How a version's loader tags relate to a profile. */
export function loaderMatch(profile: ModrinthLoaderProfile, versionLoaders: readonly string[]): "match" | "warning" | "none" {
  if (versionLoaders.some((l) => profile.loaders.includes(l))) return "match";
  if (versionLoaders.some((l) => profile.loadersWithWarning.includes(l))) return "warning";
  return "none";
}

/** Side support as published by Modrinth (`client_side` / `server_side`). */
export type SideSupport = "required" | "optional" | "unsupported" | "unknown";

export function sideSupport(value: string | null | undefined): SideSupport {
  return value === "required" || value === "optional" || value === "unsupported" ? value : "unknown";
}

/**
 * Whether a project or version cannot run on a dedicated server: project `server_side:
 * unsupported`, or a version `environment` of `client_only` / `singleplayer_only`.
 */
export function isClientOnly(input: { serverSide?: string | null; environment?: string | readonly string[] | null }): boolean {
  if (input.serverSide === "unsupported") return true;
  const envs = typeof input.environment === "string" ? [input.environment] : (input.environment ?? []);
  return envs.length > 0 && envs.every((e) => e === "client_only" || e === "singleplayer_only");
}
