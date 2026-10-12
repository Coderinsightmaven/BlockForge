import type { GameplaySettings } from "@blockforge/contracts";
import { isAtLeast } from "../versions.js";
import { validateLevelType } from "../world.js";
import { type PropertiesDocument, parseProperties, serializeProperties, setProperties } from "./document.js";
import { SECRET_PROPERTY_KEYS } from "./schema.js";

export interface GameRuleChange {
  /** Rule id as accepted by `/gamerule` on that version. */
  rule: string;
  value: string;
  /** Console command to apply it (no leading slash). */
  command: string;
}

export interface GameplayMapping {
  properties: Record<string, string>;
  /**
   * Settings that are world game rules on this version (1.21.9+ moved pvp/allow-nether/
   * enable-command-block out of server.properties). Apply via console once the server is ready;
   * they persist in the world (level.dat).
   */
  gameRules: GameRuleChange[];
  warnings: string[];
}

const DIFFICULTY_IDS = { peaceful: 0, easy: 1, normal: 2, hard: 3 } as const;
const GAMEMODE_IDS = { survival: 0, creative: 1, adventure: 2, spectator: 3 } as const;

type RuleName = "pvp" | "allowNether" | "commandBlocks";

/**
 * Game-rule ids, verified from the server jars (2026-10-12): 1.21.9/1.21.10 register camelCase
 * rules (`pvp`, `allowEnteringNetherUsingPortals`, `commandBlocksEnabled`); 1.21.11+ register
 * namespaced snake_case ids (`minecraft:pvp`, `minecraft:allow_entering_nether_using_portals`,
 * `minecraft:command_blocks_work`).
 */
export function gameRuleId(rule: RuleName, minecraftVersion: string): string {
  const snake = isAtLeast(minecraftVersion, "1.21.11") !== false;
  switch (rule) {
    case "pvp":
      return snake ? "minecraft:pvp" : "pvp";
    case "allowNether":
      return snake ? "minecraft:allow_entering_nether_using_portals" : "allowEnteringNetherUsingPortals";
    case "commandBlocks":
      return snake ? "minecraft:command_blocks_work" : "commandBlocksEnabled";
  }
}

/** Maps wizard gameplay settings to server.properties keys (and game rules where required). */
export function gameplayToProperties(settings: GameplaySettings, minecraftVersion: string): GameplayMapping {
  const p: Record<string, string> = {};
  const gameRules: GameRuleChange[] = [];
  const warnings: string[] = [];
  const named = isAtLeast(minecraftVersion, "1.14") !== false; // unknown ids: assume modern
  const asRules = isAtLeast(minecraftVersion, "1.21.9") !== false;
  const rule = (name: RuleName, value: boolean) => {
    const id = gameRuleId(name, minecraftVersion);
    gameRules.push({ rule: id, value: String(value), command: `gamerule ${id} ${value}` });
  };

  if (settings.motd !== undefined) p["motd"] = settings.motd;
  if (settings.maxPlayers !== undefined) p["max-players"] = String(settings.maxPlayers);
  if (settings.difficulty !== undefined) p["difficulty"] = named ? settings.difficulty : String(DIFFICULTY_IDS[settings.difficulty]);
  if (settings.gamemode !== undefined) p["gamemode"] = named ? settings.gamemode : String(GAMEMODE_IDS[settings.gamemode]);
  if (settings.onlineMode !== undefined) p["online-mode"] = String(settings.onlineMode);
  if (settings.whitelist !== undefined) {
    p["white-list"] = String(settings.whitelist);
    p["enforce-whitelist"] = String(settings.whitelist);
  }
  if (settings.spawnProtection !== undefined) p["spawn-protection"] = String(settings.spawnProtection);
  if (settings.viewDistance !== undefined) {
    p["view-distance"] = String(settings.viewDistance);
    if (settings.viewDistance < 3) warnings.push("view-distance below 3 is clamped to 3 by the server.");
  }
  if (settings.simulationDistance !== undefined) {
    if (isAtLeast(minecraftVersion, "1.18") === false) warnings.push(`simulation-distance does not exist before 1.18; ignored for ${minecraftVersion}.`);
    else {
      p["simulation-distance"] = String(settings.simulationDistance);
      if (settings.simulationDistance < 3) warnings.push("simulation-distance below 3 is clamped to 3 by the server.");
    }
  }
  if (settings.pvp !== undefined) {
    if (asRules) rule("pvp", settings.pvp);
    else p["pvp"] = String(settings.pvp);
  }
  if (settings.enableCommandBlock !== undefined) {
    if (asRules) rule("commandBlocks", settings.enableCommandBlock);
    else p["enable-command-block"] = String(settings.enableCommandBlock);
  }
  if (settings.allowNether !== undefined) {
    if (asRules) rule("allowNether", settings.allowNether);
    else p["allow-nether"] = String(settings.allowNether);
  }
  if (settings.hardcore !== undefined) p["hardcore"] = String(settings.hardcore);
  if (settings.levelSeed !== undefined) p["level-seed"] = settings.levelSeed;
  if (settings.levelType !== undefined) {
    const lt = validateLevelType(settings.levelType, minecraftVersion);
    if (lt.severity === "error" || lt.severity === "warning") warnings.push(lt.message ?? "Unusual level type.");
    p["level-type"] = lt.severity === "error" ? settings.levelType : lt.normalized;
  }
  if (settings.generateStructures !== undefined) p["generate-structures"] = String(settings.generateStructures);
  if (settings.resourcePack !== undefined) p["resource-pack"] = settings.resourcePack;
  if (settings.resourcePackSha1 !== undefined) p["resource-pack-sha1"] = settings.resourcePackSha1.toLowerCase();
  if (settings.requireResourcePack !== undefined) {
    if (isAtLeast(minecraftVersion, "1.17") === false) warnings.push(`require-resource-pack does not exist before 1.17; ignored for ${minecraftVersion}.`);
    else p["require-resource-pack"] = String(settings.requireResourcePack);
  }
  if (asRules && gameRules.length > 0) {
    warnings.push(`On ${minecraftVersion}, PvP, Nether access and command blocks are world game rules; they are applied with /gamerule after the world loads.`);
  }
  return { properties: p, gameRules, warnings };
}

export interface PlatformPropertiesInput {
  /** Port inside the container (Docker maps the host port). Default 25565. */
  containerPort?: number;
  query?: { enabled: boolean; port: number } | null;
  rcon?: { enabled: boolean; port: number; password: string } | null;
  /** Disable the 1.21.9+ management protocol unless BlockForge configures it. Default true. */
  disableManagementServer?: boolean;
  minecraftVersion: string;
}

/** Keys BlockForge always controls. */
export function platformProperties(input: PlatformPropertiesInput): Record<string, string> {
  const p: Record<string, string> = {
    "server-ip": "",
    "server-port": String(input.containerPort ?? 25565),
    "enable-query": String(input.query?.enabled ?? false),
    "enable-rcon": String(input.rcon?.enabled ?? false),
  };
  if (input.query) p["query.port"] = String(input.query.port);
  if (input.rcon) {
    p["rcon.port"] = String(input.rcon.port);
    p["rcon.password"] = input.rcon.password;
  }
  if ((input.disableManagementServer ?? true) && isAtLeast(input.minecraftVersion, "1.21.9") !== false) {
    p["management-server-enabled"] = "false";
  }
  return p;
}

/** Masks secret values (RCON / management passwords) while keeping the file layout. */
export function redactServerProperties(text: string, mask = "**redacted**", keys: readonly string[] = SECRET_PROPERTY_KEYS): string {
  const doc: PropertiesDocument = parseProperties(text);
  const updates: Record<string, string> = {};
  for (const l of doc.lines) if (l.kind === "entry" && keys.includes(l.key) && l.value !== "") updates[l.key] = mask;
  if (Object.keys(updates).length === 0) return text;
  // Every occurrence (not only the effective last one) must be masked.
  const lines = doc.lines.map((l) => {
    if (l.kind !== "entry" || !(l.key in updates)) return l;
    return setProperties({ lines: [l], eol: doc.eol }, { [l.key]: mask }).lines[0]!;
  });
  return serializeProperties({ lines, eol: doc.eol });
}
