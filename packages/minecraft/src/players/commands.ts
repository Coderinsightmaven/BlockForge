import type { ServerSoftware } from "@blockforge/contracts";
import { consoleMessage } from "../logs/parse.js";
import { commandFeedbackMessage } from "../logs/save.js";
import { normalizeIp } from "./lists.js";
import { PlayerInputError, assertPlayerName, isValidPlayerName, normalizeUuid } from "./uuid.js";

/**
 * Console command builders for running servers and parsers for their output. Commands are typed
 * into the server console by the agent (`workload.command`), so every argument is validated:
 * player names are `[A-Za-z0-9_]{1,16}` (no `@` selectors, spaces or line breaks), IPs are
 * literal addresses, and free-text reasons are collapsed to one line. Output formats come from the
 * 26.3 and 1.12.2 server jars (`en_us.json` / `en_us.lang`) and Velocity 4.2.0
 * (`messages.properties`, `GlistCommand`). Minecraft 26.3+ prefixes console feedback with
 * `System chat: ` (real Paper and vanilla 26.3 lines in test/fixtures/console); every parser
 * reads lines through `consoleMessage`, which removes it and drops player chat.
 */

export const MAX_REASON_LENGTH = 200;

/**
 * Single-line reason: control, format (bidi) and line/paragraph separator characters become
 * spaces, whitespace is collapsed, and the result is cut to `MAX_REASON_LENGTH`. Empty → null.
 */
export function sanitizeReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const s = reason
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s === "") return null;
  return [...s].slice(0, MAX_REASON_LENGTH).join("");
}

function ip(value: string): string {
  const n = normalizeIp(value);
  if (!n) throw new PlayerInputError("invalid IP address");
  return n;
}

const withReason = (base: string, reason: string | null | undefined) => {
  const r = sanitizeReason(reason);
  return r === null ? base : `${base} ${r}`;
};

export const playerCommands = {
  whitelistAdd: (name: string) => `whitelist add ${assertPlayerName(name)}`,
  whitelistRemove: (name: string) => `whitelist remove ${assertPlayerName(name)}`,
  whitelistOn: () => "whitelist on",
  whitelistOff: () => "whitelist off",
  /** Re-reads whitelist.json after an offline edit. */
  whitelistReload: () => "whitelist reload",
  op: (name: string) => `op ${assertPlayerName(name)}`,
  deop: (name: string) => `deop ${assertPlayerName(name)}`,
  ban: (name: string, reason?: string | null) => withReason(`ban ${assertPlayerName(name)}`, reason),
  pardon: (name: string) => `pardon ${assertPlayerName(name)}`,
  /** `ban-ip` takes an address or the name of an online player. */
  banIp: (target: { ip: string } | { name: string }, reason?: string | null) =>
    withReason(`ban-ip ${"ip" in target ? ip(target.ip) : assertPlayerName(target.name)}`, reason),
  pardonIp: (address: string) => `pardon-ip ${ip(address)}`,
  kick: (name: string, reason?: string | null) => withReason(`kick ${assertPlayerName(name)}`, reason),
  /** `list uuids` exists since 1.13 (1.12 also accepts `list uuids`). */
  list: (opts: { uuids?: boolean } = {}) => (opts.uuids ? "list uuids" : "list"),
  /** Velocity: player count per backend server. */
  glistAll: () => "glist all",
} as const;

export type PlayerCommandName = keyof typeof playerCommands;

/** The (action, target) a console command line acts on, in the terms of `CommandFeedback`. */
export interface PlayerCommandTarget {
  action: Extract<CommandFeedback, { ok: true }>["action"];
  /**
   * Lowercase player name, the normalised IP for `ban-ip`/`pardon-ip` with a literal address, or
   * `PLAYER_COMMAND_ANY_TARGET` when the feedback could name anyone (selectors, UUIDs, `ban-ip <name>`
   * — vanilla resolves an online player's name to their IP —, missing or unparsable arguments).
   */
  target: string;
}

/** Target wildcard of `parsePlayerCommand`: the command's feedback may name any player or address. */
export const PLAYER_COMMAND_ANY_TARGET = "*";

/** A Brigadier word or quoted string (`"Steve"`, `'Steve'`) holding a valid player name, lowercased; else null. */
function plainName(w: string | undefined): string | null {
  if (w === undefined) return null;
  const q = /^(["'])(.*)\1$/.exec(w);
  const v = q ? q[2]! : w;
  return isValidPlayerName(v) ? v.toLowerCase() : null;
}

/**
 * Recognises a vanilla player command typed into the console (`op Steve`, `/minecraft:ban Steve x`,
 * `whitelist add Steve`, `ban-ip 1.2.3.4`, …): whenever the verb (after an optional `/` and
 * `minecraft:`, case-insensitive) is a player action, the action is returned, with the canonical
 * target or `PLAYER_COMMAND_ANY_TARGET` (see `PlayerCommandTarget.target`). Null for every other
 * command (`say`, `list`, `whitelist on`, plugin commands, `execute … run op …`). Used to tell whether
 * two console commands could print the same feedback line; an unrecognised command that prints
 * vanilla-identical feedback (a plugin command, `execute … run …`) could still collide.
 */
export function parsePlayerCommand(line: string): PlayerCommandTarget | null {
  const words = line.trim().replace(/^\//, "").split(/\s+/);
  const cmd = (words[0] ?? "").toLowerCase().replace(/^minecraft:/, "");
  const ANY = PLAYER_COMMAND_ANY_TARGET;
  switch (cmd) {
    case "op":
    case "deop":
    case "ban":
    case "pardon":
    case "kick":
      return { action: cmd, target: plainName(words[1]) ?? ANY };
    case "whitelist": {
      const sub = (words[1] ?? "").toLowerCase();
      if (sub !== "add" && sub !== "remove") return null;
      return { action: sub === "add" ? "whitelist.add" : "whitelist.remove", target: plainName(words[2]) ?? ANY };
    }
    case "ban-ip":
    case "pardon-ip":
      return { action: cmd, target: (words[1] === undefined ? null : normalizeIp(words[1])) ?? ANY };
    default:
      return null;
  }
}

/** Which builders apply to a server software (Velocity has no built-in ban/whitelist/op). */
export function supportedPlayerCommands(software: ServerSoftware): PlayerCommandName[] {
  if (software === "velocity") return ["glistAll"];
  return (Object.keys(playerCommands) as PlayerCommandName[]).filter((c) => c !== "glistAll");
}

// --- output parsing ---------------------------------------------------------------------------

export interface OnlinePlayer {
  name: string;
  uuid: string | null;
}

export interface PlayerListOutput {
  format: "vanilla" | "legacy";
  online: number;
  max: number;
  /** Only entries that are valid Java Edition names (`[A-Za-z0-9_]{1,16}`). */
  players: OnlinePlayer[];
  /** Entries dropped because they are not valid player names (offline-mode oddities, forged text). */
  skipped: number;
}

export interface VelocityGlistOutput {
  format: "velocity";
  /** From the "N players are currently connected to the proxy." line; null when absent. */
  total: number | null;
  servers: Array<{ server: string; count: number; players: string[]; skipped: number }>;
}

/**
 * Command feedback of a console line under the strict rules of `commandFeedbackMessage`
 * (recognised layout, INFO, server logger, no chat, `System chat: ` removed); "" otherwise.
 */
function messageOf(line: string): string {
  return commandFeedbackMessage(line) ?? "";
}

/** Most players returned from one `list` line (the rest are counted in `skipped`). */
export const MAX_LISTED_PLAYERS = 10_000;

const NAME_AND_ID = /^(\S{1,16}) \(([0-9a-fA-F-]{32,36})\)$/;

/** Splits a ", "-separated name list; entries that are not valid player names are counted, not returned. */
function splitPlayers(text: string): { players: OnlinePlayer[]; skipped: number } {
  const t = text.trim();
  const players: OnlinePlayer[] = [];
  let skipped = 0;
  if (t === "") return { players, skipped };
  // Every entry is looked at: invalid names and entries beyond MAX_LISTED_PLAYERS are counted, never silently lost.
  for (const part of t.split(", ")) {
    const p = part.trim();
    if (p === "") continue;
    const m = NAME_AND_ID.exec(p);
    const name = m ? m[1]! : p;
    const uuid = m ? normalizeUuid(m[2]!) : null;
    if (!isValidPlayerName(name) || (m && uuid === null) || players.length >= MAX_LISTED_PLAYERS) skipped++;
    else players.push({ name, uuid });
  }
  return { players, skipped };
}

// 1.13+: commands.list.players = "There are %s of a max of %s players online: %s"
const VANILLA_LIST = /^There are (\d+) of a max of (\d+) players online:(?: (.*))?$/;
// ≤ 1.12: commands.players.list = "There are %s/%s players online:" + names on the next line
const LEGACY_LIST = /^There are (\d+)\/(\d+) players online:$/;

/**
 * Parses the console output of `list` / `list uuids` (vanilla, Paper, Purpur, Folia, Spigot,
 * Fabric, Forge, NeoForge). `lines` are raw console lines after the command, with or without the
 * log prefix; the first matching line wins.
 */
export function parsePlayerListOutput(lines: readonly string[]): PlayerListOutput | null {
  for (let i = 0; i < lines.length; i++) {
    const msg = messageOf(lines[i]!);
    let m = VANILLA_LIST.exec(msg.trimEnd()) ?? VANILLA_LIST.exec(msg);
    if (m) {
      return { format: "vanilla", online: Number(m[1]), max: Number(m[2]), ...splitPlayers(m[3] ?? "") };
    }
    m = LEGACY_LIST.exec(msg.trim());
    if (m) {
      const online = Number(m[1]);
      const next = online > 0 && i + 1 < lines.length ? messageOf(lines[i + 1]!) : "";
      return { format: "legacy", online, max: Number(m[2]), ...splitPlayers(next) };
    }
  }
  return null;
}

export interface WhitelistOutput {
  format: "vanilla" | "legacy";
  players: string[];
  skipped: number;
}

// 1.13+: commands.whitelist.list "There are %s whitelisted player(s): %s" / commands.whitelist.none
const WHITELIST_LIST = /^There are (\d+) whitelisted player\(s\): (.*)$/;
const WHITELIST_NONE = /^There are no whitelisted players$/;
// ≤ 1.12: "There are %s (out of %s seen) whitelisted players:" + names on the next line
const WHITELIST_LEGACY = /^There are (\d+) \(out of \d+ seen\) whitelisted players:$/;

/** Parses `whitelist list` output (lets the control plane read the whitelist of a running server). */
export function parseWhitelistListOutput(lines: readonly string[]): WhitelistOutput | null {
  for (let i = 0; i < lines.length; i++) {
    const msg = messageOf(lines[i]!).trim();
    if (WHITELIST_NONE.test(msg)) return { format: "vanilla", players: [], skipped: 0 };
    let m = WHITELIST_LIST.exec(msg);
    if (m) {
      const r = splitPlayers(m[2]!);
      return { format: "vanilla", players: r.players.map((p) => p.name), skipped: r.skipped };
    }
    m = WHITELIST_LEGACY.exec(msg);
    if (m) {
      const r = splitPlayers(Number(m[1]) > 0 && i + 1 < lines.length ? messageOf(lines[i + 1]!) : "");
      return { format: "legacy", players: r.players.map((p) => p.name), skipped: r.skipped };
    }
  }
  return null;
}

// velocity.command.glist-player-singular/plural
const GLIST_TOTAL = /^(\d+) players? (?:is|are) currently connected to the proxy\.$/;
// GlistCommand: "[" + server + "] " + "(" + count + ")" + ": " + names joined by ", "
const GLIST_SERVER = /^\[([A-Za-z0-9._-]{1,64})\] \((\d+)\): ?(.*)$/;

/** Parses Velocity `glist` / `glist all` / `glist <server>` output. */
export function parseVelocityGlist(lines: readonly string[]): VelocityGlistOutput | null {
  let total: number | null = null;
  const servers: VelocityGlistOutput["servers"] = [];
  for (const line of lines) {
    // Velocity's own messages: recognised layout, INFO, no foreign logger.
    const msg = (consoleMessage(line, { levels: ["info"] }) ?? "").trim();
    const t = GLIST_TOTAL.exec(msg);
    if (t) {
      total = Number(t[1]);
      continue;
    }
    const s = GLIST_SERVER.exec(msg);
    if (s) {
      const r = splitPlayers(s[3] ?? "");
      servers.push({ server: s[1]!, count: Number(s[2]), players: r.players.map((p) => p.name), skipped: r.skipped });
    }
  }
  return total === null && servers.length === 0 ? null : { format: "velocity", total, servers };
}

// --- command feedback -------------------------------------------------------------------------

export type CommandFeedback =
  | {
      action: "whitelist.add" | "whitelist.remove" | "op" | "deop" | "ban" | "pardon" | "kick" | "ban-ip" | "pardon-ip";
      ok: true;
      target: string;
      reason: string | null;
      /** The server message (untrusted console text, prefix removed). */
      message: string;
    }
  | {
      action: "whitelist.add" | "whitelist.remove" | "op" | "deop" | "ban" | "pardon" | "ban-ip" | "pardon-ip" | "kick" | "player";
      ok: false;
      /**
       * The player the failure names (1.12.2 `Could not op %s` …), or null when the message names
       * nobody (26.3 `Nothing changed. The player is already an operator`, `No player was found`, …).
       * A target-less failure cannot be attributed to one command: callers must only accept it when
       * no other command can be answering on that console at the same time, and never in preference
       * to a later line that names the target (a batch of commands may print both).
       */
      target: string | null;
      message: string;
    };

type Rule = [RegExp, (m: RegExpExecArray, msg: string) => CommandFeedback | null];

const IP_ACTIONS = new Set(["ban-ip", "pardon-ip"]);
/** Success feedback; null when the captured target is not a valid player name (or IPv4 for IP actions). */
const ok = (action: Extract<CommandFeedback, { ok: true }>["action"], target: string, reason: string | null = null): CommandFeedback | null => {
  if (IP_ACTIONS.has(action)) {
    const ip = normalizeIp(target);
    return ip === null ? null : { action, ok: true, target: ip, reason, message: "" };
  }
  return isValidPlayerName(target) ? { action, ok: true, target, reason, message: "" } : null;
};
/**
 * Failure feedback. When the message names a player (capture group 1, 1.12.2 wording) it must be a
 * valid player name (otherwise the line is not recognised); messages without a name have `target: null`.
 */
const fail =
  (action: Extract<CommandFeedback, { ok: false }>["action"]) =>
  (m: RegExpExecArray, msg: string): CommandFeedback | null => {
    const named = m[1];
    if (named === undefined) return { action, ok: false, target: null, message: msg };
    return isValidPlayerName(named) ? { action, ok: false, target: named, message: msg } : null;
  };

/**
 * Success/failure strings of 26.3 (`en_us.json`) and 1.12.2 (`en_us.lang`). Successes always name
 * their target; failures name it only in the 1.12.2 wording (capture group 1 of a failure rule).
 */
const FEEDBACK: Rule[] = [
  [/^Added (\S+) to the whitelist$/, (m) => ok("whitelist.add", m[1]!)],
  [/^Removed (\S+) from the whitelist$/, (m) => ok("whitelist.remove", m[1]!)],
  [/^(?:Player is already whitelisted|Could not add (\S+) to the whitelist)$/, fail("whitelist.add")],
  [/^(?:Player is not whitelisted|Could not remove (\S+) from the whitelist)$/, fail("whitelist.remove")],
  [/^(?:Made (\S+) a server operator|Opped (\S+))$/, (m) => ok("op", (m[1] ?? m[2])!)],
  [/^(?:Made (\S+) no longer a server operator|De-opped (\S+))$/, (m) => ok("deop", (m[1] ?? m[2])!)],
  [/^(?:Nothing changed\. The player is already an operator|Could not op (\S+))$/, fail("op")],
  [/^(?:Nothing changed\. The player is not an operator|Could not de-op (\S+))$/, fail("deop")],
  [/^Banned IP (\S+): (.*)$/, (m) => ok("ban-ip", m[1]!, m[2]!)],
  [/^Banned IP address (\S+)(?: belonging to .*)?$/, (m) => ok("ban-ip", m[1]!)],
  [/^Banned (\S+): (.*)$/, (m) => ok("ban", m[1]!, m[2]!)],
  [/^Banned player (\S+)$/, (m) => ok("ban", m[1]!)],
  [/^(?:Nothing changed\. The player is already banned|Could not ban player (\S+))$/, fail("ban")],
  [/^Unbanned IP(?: address)? (\S+)$/, (m) => ok("pardon-ip", m[1]!)],
  [/^Unbanned(?: player)? (\S+)$/, (m) => ok("pardon", m[1]!)],
  [/^(?:Nothing changed\. The player isn't banned|Could not unban player (\S+))$/, fail("pardon")],
  [/^(?:Nothing changed\. That IP is already banned|Invalid IP address or unknown player|You have entered an invalid IP address or a player that is not online)$/, fail("ban-ip")],
  [/^(?:Nothing changed\. That IP isn't banned|Invalid IP address|You have entered an invalid IP address)$/, fail("pardon-ip")],
  [/^Kicked (\S+): (.*)$/, (m) => ok("kick", m[1]!, m[2]!)],
  [/^Kicked (\S+) from the game(?:: '(.*)')?$/, (m) => ok("kick", m[1]!, m[2] ?? null)],
  // 26.3 `commands.kick.owner.failed` / `.singleplayer.failed` (integrated server only; target-less).
  [/^(?:Cannot kick the server owner in a LAN game|Cannot kick in an offline singleplayer game)$/, fail("kick")],
  [/^(?:That player does not exist|No player was found)$/, fail("player")],
];

/**
 * Only feedback of commands typed into the server console is logged as such. A command a player
 * (or an RCON client) runs is answered to that source only; on success the server additionally
 * logs the op broadcast `chat.type.admin` "[%s: %s]" (e.g. `[Steve: Made Alex a server operator]`,
 * 26.3: `System chat: [Steve: …]`), which does not match any rule here, and failures of such
 * commands are not logged at all. Console feedback therefore always comes from a console command.
 *
 * Interprets one console line printed in response to a player command; null if unrelated, not
 * attributable to the server (see `commandFeedbackMessage`), or when the captured target is not a
 * valid player name / IPv4 address (e.g. a forged `Made @a a server operator`).
 */
export function parseCommandFeedback(line: string): CommandFeedback | null {
  const msg = messageOf(line);
  if (msg === "") return null;
  for (const [re, make] of FEEDBACK) {
    const m = re.exec(msg);
    if (m) {
      const r = make(m, msg);
      return r && r.ok ? { ...r, message: msg } : r;
    }
  }
  return null;
}
