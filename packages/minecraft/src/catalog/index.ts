import type { ServerSoftware, SoftwareInfo } from "@blockforge/contracts";
import { createFabricAdapter } from "./fabric.js";
import { createFillAdapter } from "./fill.js";
import { createForgeAdapter } from "./forge.js";
import { createVanillaAdapter } from "./mojang.js";
import { createNeoForgeAdapter } from "./neoforge.js";
import { createPurpurAdapter } from "./purpur.js";
import { createSpigotAdapter } from "./spigot.js";
import type { SoftwareAdapter } from "./types.js";

export type Catalog = Readonly<Record<ServerSoftware, SoftwareAdapter>>;

/** All adapters, keyed by contracts `ServerSoftware`. Network access happens per call via the context. */
export function createCatalog(): Catalog {
  return {
    vanilla: createVanillaAdapter(),
    paper: createFillAdapter("paper"),
    folia: createFillAdapter("folia"),
    velocity: createFillAdapter("velocity"),
    purpur: createPurpurAdapter(),
    fabric: createFabricAdapter(),
    forge: createForgeAdapter(),
    neoforge: createNeoForgeAdapter(),
    spigot: createSpigotAdapter(),
  };
}

export function listSoftwareInfo(catalog: Catalog = createCatalog()): SoftwareInfo[] {
  return Object.values(catalog).map((a) => a.info);
}

/** Hosts the catalogue fetches metadata and artifacts from (for SSRF allowlists). */
export const CATALOG_HOSTS = {
  metadata: [
    "piston-meta.mojang.com",
    "fill.papermc.io",
    "api.purpurmc.org",
    "meta.fabricmc.net",
    "files.minecraftforge.net",
    "maven.minecraftforge.net",
    "maven.neoforged.net",
  ],
  artifacts: [
    "piston-data.mojang.com",
    "launcher.mojang.com",
    "fill-data.papermc.io",
    "api.purpurmc.org",
    "meta.fabricmc.net",
    "maven.minecraftforge.net",
    "maven.neoforged.net",
  ],
} as const;
