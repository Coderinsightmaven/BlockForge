import type { SoftwareInfo } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import type { SoftwareAdapter } from "./types.js";

/**
 * Spigot has no official redistributable server binary: SpigotMC only distributes BuildTools
 * (https://hub.spigotmc.org/jenkins/job/BuildTools/), which decompiles, patches and compiles the
 * server locally and needs git + a JDK. BlockForge does not run BuildTools, so the adapter lists
 * no versions and refuses to resolve instead of pointing at an unofficial mirror.
 */
export const SPIGOT_INFO: SoftwareInfo = {
  software: "spigot",
  displayName: "Spigot",
  kind: "game",
  description: "CraftBukkit fork by SpigotMC. Distributed only as source via BuildTools.",
  supportsPlugins: true,
  supportsMods: false,
  restrictions: [
    "No official downloadable server jar exists: Spigot must be compiled locally with SpigotMC's BuildTools (requires git and a JDK). BlockForge does not run BuildTools and never uses unofficial mirrors.",
    "Use Paper or Purpur instead: they run Spigot/Bukkit plugins and are provisioned automatically.",
    "Behind Velocity, Spigot only supports legacy (BungeeCord) forwarding, which is insecure without strict network isolation.",
  ],
  source: "https://hub.spigotmc.org/jenkins/job/BuildTools/",
};

export function createSpigotAdapter(): SoftwareAdapter {
  return {
    info: SPIGOT_INFO,
    async listVersions() {
      return [];
    },
    async listBuilds() {
      return [];
    },
    async resolve() {
      throw new CatalogError("UNSUPPORTED", SPIGOT_INFO.restrictions[0]!);
    },
  };
}
