import type { ServerSoftware } from "@blockforge/contracts";
import { isAtLeast } from "@blockforge/minecraft";
import type { ForwardingMode } from "./model.js";

/**
 * Velocity player-info forwarding compatibility (backend software × Minecraft version).
 * Researched 2026-10-11; sources:
 *  [VEL]  https://docs.papermc.io/velocity/player-information-forwarding — modern forwarding only
 *         for Minecraft ≥ 1.13; Paper 1.14+ and 1.13.1/1.13.2 build ≥ 377 support it natively via
 *         config/paper-global.yml `proxies.velocity.{enabled,online-mode,secret}` (paper.yml
 *         `settings.velocity-support.*` for Paper ≤ 1.18.2); legacy = spigot.yml
 *         `settings.bungeecord: true`, "fundamentally insecure" without firewalling; BungeeGuard =
 *         legacy + token via the BungeeGuard plugin; Fabric: FabricProxy-Lite (modern), "no longer
 *         any actively supported mods that support legacy forwarding"; Forge: ProxyCompatibleForge.
 *  [DOCS] PaperMC docs config specs (github.com/PaperMC/docs src/config/paper/paper-global.yml,
 *         spigot.yml @ 3d540521, 2026-09-29): key paths and defaults (`secret: ""`).
 *  [FPL]  github.com/OKTW-Network/FabricProxy-Lite README: `config/FabricProxy-Lite.toml`
 *         (`secret`, `hackOnlineMode` default true, `hackEarlySend`, `hackMessageChain`); Modrinth
 *         lists game versions 1.16.5 – 26.3.
 *  [PCF]  modrinth.com/mod/proxy-compatible-forge (updated 2026-08-31): Forge 1.7.2 – 26.2 and
 *         NeoForge 1.20.1 – 26.2; modes MODERN, BUNGEEGUARD, LEGACY; config
 *         `config/proxy-compatible-forge.toml` [forwarding] enabled/mode/secret; extra mixin mods on
 *         Forge 1.13.x (ModernMixins) and 1.14 – 1.15.1 (MixinBootstrap); 1.7.2 – 1.12.2 needs a
 *         modified Velocity proxy; "In server.properties make sure online-mode is set to false".
 *  Vanilla has no forwarding support at all.
 */

export type SupportLevel = "native" | "plugin" | "mod" | "unsupported" | "unknown";

export interface ForwardingSupport {
  mode: ForwardingMode;
  level: SupportLevel;
  /** Extensions that must be installed (plugins/mods). */
  requires: string[];
  /** Files BlockForge writes for this mode (relative to the server root). */
  configFiles: string[];
  steps: string[];
  notes: string[];
}

export interface CompatibilityReport {
  software: ServerSoftware;
  minecraftVersion: string;
  modes: Record<ForwardingMode, ForwardingSupport>;
  /** Best secure option for this backend, or null when only unsafe modes exist. */
  recommended: ForwardingMode | null;
  /** Backends behind a proxy must run with online-mode=false (the proxy authenticates). */
  requiresOfflineMode: boolean;
  notes: string[];
}

const PAPER_FAMILY: readonly ServerSoftware[] = ["paper", "purpur", "folia"];

const NONE_SUPPORT = (software: ServerSoftware): ForwardingSupport => ({
  mode: "none",
  level: "native",
  requires: [],
  configFiles: ["server.properties"],
  steps: ["Set online-mode=false in server.properties."],
  notes: [
    "Without forwarding every player appears to connect from the proxy's IP and gets an offline-mode UUID, so skins, bans and player data are not tied to real accounts.",
    ...(software === "vanilla" ? ["Vanilla cannot verify that connections come from the proxy: the backend port must be unreachable except from the proxy."] : []),
  ],
});

const unsupported = (mode: ForwardingMode, why: string): ForwardingSupport => ({ mode, level: "unsupported", requires: [], configFiles: [], steps: [], notes: [why] });

const ENFORCE_PROFILE_NOTE =
  "Minecraft 1.19.1+ chat signing: modern forwarding (Velocity forwarding versions 2–4) carries the player's signing key, so keep the backend's enforce-secure-profile consistent with velocity.toml force-key-authentication. Legacy and BungeeGuard forwarding do not carry the key; if players are kicked for chat validation, set enforce-secure-profile=false on that backend (guidance, not verified on every version).";

function paperFamily(software: ServerSoftware, v: string): CompatibilityReport["modes"] {
  const modern = isAtLeast(v, "1.13");
  const globalFile = isAtLeast(v, "1.19") !== false; // unknown ids (snapshots): assume current layout
  const modernSupport: ForwardingSupport =
    modern === false
      ? unsupported("modern", "Velocity modern forwarding requires Minecraft 1.13 or newer [VEL].")
      : {
          mode: "modern",
          level: "native",
          requires: [],
          configFiles: [globalFile ? "config/paper-global.yml" : "paper.yml", "spigot.yml", "server.properties"],
          steps: globalFile
            ? [
                "config/paper-global.yml: proxies.velocity.enabled = true",
                "config/paper-global.yml: proxies.velocity.online-mode = <velocity.toml online-mode>",
                "config/paper-global.yml: proxies.velocity.secret = <forwarding secret>",
                "spigot.yml: settings.bungeecord = false",
                "server.properties: online-mode = false",
              ]
            : [
                "paper.yml: settings.velocity-support.enabled = true",
                "paper.yml: settings.velocity-support.online-mode = <velocity.toml online-mode>",
                "paper.yml: settings.velocity-support.secret = <forwarding secret>",
                "spigot.yml: settings.bungeecord = false",
                "server.properties: online-mode = false",
              ],
          notes: [
            ...(isAtLeast(v, "1.14") === false ? ["On 1.13.x, Paper build 377 or newer is required [VEL]."] : []),
            ...(software === "folia" ? ["Folia uses Paper's configuration files."] : []),
            ...(software === "purpur" ? ["Purpur inherits Paper's proxy support and configuration files."] : []),
            "Restart the server after changing these files.",
          ],
        };
  return {
    modern: modernSupport,
    legacy: {
      mode: "legacy",
      level: "native",
      requires: [],
      configFiles: ["spigot.yml", "server.properties"],
      steps: ["spigot.yml: settings.bungeecord = true", "server.properties: online-mode = false"],
      notes: ["Legacy (BungeeCord) forwarding is fundamentally insecure: anyone who can reach the backend port can claim any identity. The backend must only be reachable from the proxy [VEL]."],
    },
    bungeeguard: {
      mode: "bungeeguard",
      level: "plugin",
      requires: ["BungeeGuard plugin"],
      configFiles: ["spigot.yml", "plugins/BungeeGuard/config.yml", "server.properties"],
      steps: ["spigot.yml: settings.bungeecord = true", "plugins/BungeeGuard/config.yml: allowed-tokens = [<forwarding secret>]", "server.properties: online-mode = false"],
      notes: ["BungeeGuard adds a shared token to legacy forwarding; still prefer modern forwarding on 1.13+ [VEL]."],
    },
    none: NONE_SUPPORT(software),
  };
}

export function forwardingCompatibility(software: ServerSoftware, minecraftVersion: string): CompatibilityReport {
  const v = minecraftVersion;
  let modes: CompatibilityReport["modes"];
  const notes: string[] = [];
  if (PAPER_FAMILY.includes(software)) {
    modes = paperFamily(software, v);
  } else if (software === "spigot") {
    const pf = paperFamily("spigot", v);
    modes = {
      modern: unsupported("modern", "Spigot does not implement Velocity modern forwarding; use Paper or Purpur."),
      legacy: pf.legacy,
      bungeeguard: pf.bungeeguard,
      none: pf.none,
    };
  } else if (software === "vanilla") {
    modes = {
      modern: unsupported("modern", "Vanilla servers cannot accept Velocity forwarding."),
      legacy: unsupported("legacy", "Vanilla servers cannot accept BungeeCord forwarding."),
      bungeeguard: unsupported("bungeeguard", "Vanilla servers cannot accept BungeeGuard forwarding."),
      none: NONE_SUPPORT("vanilla"),
    };
    notes.push("Behind a proxy a vanilla server only works with forwarding disabled and online-mode=false; it must not be reachable except through the proxy.");
  } else if (software === "fabric") {
    const fpl = isAtLeast(v, "1.16.5");
    modes = {
      modern:
        fpl === false
          ? unsupported("modern", "FabricProxy-Lite is published for Minecraft 1.16.5 and newer only [FPL].")
          : {
              mode: "modern",
              level: "mod",
              requires: ["FabricProxy-Lite", "Fabric API"],
              configFiles: ["config/FabricProxy-Lite.toml", "server.properties"],
              steps: ["Install FabricProxy-Lite (and Fabric API) in mods/", "config/FabricProxy-Lite.toml: secret = <forwarding secret>", "server.properties: online-mode = false"],
              notes: [
                "FabricProxy-Lite's hackOnlineMode (default true) also lets it work with online-mode=true; BlockForge still sets online-mode=false for consistency.",
                "hackEarlySend = true is required by some mods (e.g. LuckPerms); hackMessageChain fixes chat-signature kicks after server switches [FPL].",
              ],
            },
      legacy: unsupported("legacy", "There are no actively supported Fabric mods for legacy forwarding [VEL]."),
      bungeeguard: unsupported("bungeeguard", "No supported Fabric implementation of BungeeGuard."),
      none: NONE_SUPPORT("fabric"),
    };
  } else if (software === "forge" || software === "neoforge") {
    const neo = software === "neoforge";
    const min = neo ? "1.20.1" : "1.13";
    const maxKnown = "26.2";
    const tooOld = isAtLeast(v, min) === false;
    const tooNew = isAtLeast(v, "26.3") === true; // newer than PCF's last listed version
    const level: SupportLevel = tooOld ? "unsupported" : tooNew ? "unknown" : "mod";
    const requires = ["Proxy Compatible Forge (PCF)"];
    if (!neo && isAtLeast(v, "1.14") === false) requires.push("ModernMixins");
    else if (!neo && isAtLeast(v, "1.15.2") === false) requires.push("MixinBootstrap");
    const pcf = (mode: ForwardingMode): ForwardingSupport =>
      level === "unsupported"
        ? unsupported(mode, `Proxy Compatible Forge supports ${neo ? "NeoForge 1.20.1" : "Forge 1.13"} and newer for this mode [PCF].`)
        : {
            mode,
            level,
            requires,
            configFiles: ["config/proxy-compatible-forge.toml", "server.properties"],
            steps: [
              "Install Proxy Compatible Forge in mods/",
              `config/proxy-compatible-forge.toml: [forwarding] enabled = true, mode = "${mode.toUpperCase()}"${mode === "legacy" ? "" : ", secret = <forwarding secret>"}`,
              "server.properties: online-mode = false",
            ],
            notes: [
              ...(level === "unknown" ? [`PCF lists versions up to ${maxKnown} (checked 2026-10-11); support for ${v} is unconfirmed.`] : []),
              ...(neo && isAtLeast(v, "1.21") === true && isAtLeast(v, "1.21.12") === false
                ? ["NeoVelocity is an alternative NeoForge mod for modern forwarding on 1.21 – 1.21.11."]
                : []),
              ...(mode === "legacy" ? ["Legacy forwarding is insecure without strict network isolation [VEL]."] : []),
            ],
          };
    modes = {
      modern: isAtLeast(v, "1.13") === false ? unsupported("modern", "Velocity modern forwarding requires Minecraft 1.13 or newer [VEL].") : pcf("modern"),
      legacy:
        !neo && tooOld
          ? {
              mode: "legacy",
              level: "mod",
              requires: ["BungeeForge"],
              configFiles: ["server.properties"],
              steps: ["Install the BungeeForge build matching this Forge version in mods/", "server.properties: online-mode = false"],
              notes: ["Legacy forwarding is insecure without strict network isolation [VEL].", "Not tested by BlockForge."],
            }
          : pcf("legacy"),
      bungeeguard: pcf("bungeeguard"),
      none: NONE_SUPPORT(software),
    };
    if (!neo && isAtLeast(v, "1.13") === true && isAtLeast(v, "1.20.2") === false) notes.push("For Forge 1.13 – 1.20.1 the Ambassador Velocity plugin handles the Forge handshake on the proxy side [PCF].");
  } else {
    // velocity as a backend makes no sense
    modes = {
      modern: unsupported("modern", "Not a backend server."),
      legacy: unsupported("legacy", "Not a backend server."),
      bungeeguard: unsupported("bungeeguard", "Not a backend server."),
      none: unsupported("none", "Not a backend server."),
    };
  }
  const recommended: ForwardingMode | null =
    modes.modern.level === "native" || modes.modern.level === "mod" || modes.modern.level === "plugin"
      ? "modern"
      : modes.bungeeguard.level !== "unsupported" && modes.bungeeguard.level !== "unknown"
        ? "bungeeguard"
        : null;
  if (isAtLeast(v, "1.19.1") !== false) notes.push(ENFORCE_PROFILE_NOTE);
  return { software, minecraftVersion, modes, recommended, requiresOfflineMode: software !== "velocity", notes };
}

/** Whether `mode` can be used for this backend (native, plugin or mod support). */
export function supportsForwarding(software: ServerSoftware, minecraftVersion: string, mode: ForwardingMode): SupportLevel {
  return forwardingCompatibility(software, minecraftVersion).modes[mode].level;
}
