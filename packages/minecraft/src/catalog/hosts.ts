/**
 * Hosts the catalogue talks to. The library enforces them itself at the fetch boundary (every
 * request, every redirect hop, and every artifact URL taken from upstream JSON) so a compromised
 * or spoofed upstream response cannot point BlockForge at internal addresses. The control plane
 * and the agent keep their own allowlists as well.
 */
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
