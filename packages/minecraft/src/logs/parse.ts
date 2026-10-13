import { javaMajorForClassFileVersion } from "../java.js";
import { stripFormatting } from "./formatting.js";

/**
 * Console/log line parsing for the event pipeline. Lines are untrusted: parsing only extracts
 * data, and chat lines (`<name> …`, `[Not Secure] <name> …`, `* name …`) never trigger events.
 *
 * Line layouts (verified 2026-10-12 from real output and the projects' log4j2 configs):
 *  - vanilla / Fabric / Paper latest.log:  `[04:02:22] [main/INFO]: msg`
 *  - Forge console:                        `[04:01:48] [main/WARN] [minecraft/Eula]: msg`
 *  - NeoForge console (ANSI-coloured):     `ESC[32m[04:02:10.694] [main/INFO] [LaunchServiceHandler/MODLAUNCHER]: msg`
 *  - Forge/NeoForge debug.log:             `[12Oct2026 04:02:10.694] [main/INFO] [logger/MARKER]: msg`
 *  - Paper console:                        `[04:02:37 WARN]: msg` / `[04:02:34 INFO]: [bootstrap] msg`
 *  - Velocity console:                     `[03:42:24 INFO]: msg` / `[03:42:24 WARN] [io.netty…]: msg`
 *  - Velocity latest.log:                  `[03:42:24] [main/INFO] [com.velocitypowered.proxy.Velocity]: msg`
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface ParsedLogLine {
  /** Line with formatting codes and control characters removed. */
  plain: string;
  time: string | null;
  thread: string | null;
  level: LogLevel | null;
  logger: string | null;
  /** Message part (whole plain line when no known layout matched). */
  message: string;
  layout: "bracket-thread" | "bracket-level" | "unknown";
  /** Java stack trace / exception continuation line. */
  stackTrace: boolean;
}

const LEVELS: Record<string, LogLevel> = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  WARNING: "warn",
  ERROR: "error",
  SEVERE: "error",
  FATAL: "fatal",
};

const TIME = String.raw`(\d{2}:\d{2}:\d{2}(?:\.\d{3})?|\d{2}[A-Za-z]{3}\d{4} \d{2}:\d{2}:\d{2}\.\d{3})`;
const LEVEL = String.raw`(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|SEVERE|FATAL)`;
const BRACKET_THREAD = new RegExp(String.raw`^\[${TIME}\] \[([^\]]*?)\/${LEVEL}\](?: \[([^\]]*)\])?: ?(.*)$`);
const BRACKET_LEVEL = new RegExp(String.raw`^\[(\d{2}:\d{2}:\d{2}) ${LEVEL}\](?: \[([^\]]*)\])?: ?(.*)$`);
const STACK = /^(?:\s+at [\w$.<>/]+|\s*\.\.\. \d+ more|Caused by: |Suppressed: |\s*[\w$.]+(?:Exception|Error)(?::|$))/;

export function parseLogLine(raw: string): ParsedLogLine {
  const plain = stripFormatting(raw).replace(/\s+$/, "");
  let m = BRACKET_THREAD.exec(plain);
  if (m) {
    return { plain, time: m[1]!, thread: m[2]!, level: LEVELS[m[3]!] ?? null, logger: m[4] ?? null, message: m[5] ?? "", layout: "bracket-thread", stackTrace: false };
  }
  m = BRACKET_LEVEL.exec(plain);
  if (m) {
    return { plain, time: m[1]!, thread: null, level: LEVELS[m[2]!] ?? null, logger: m[3] ?? null, message: m[4] ?? "", layout: "bracket-level", stackTrace: false };
  }
  return { plain, time: null, thread: null, level: null, logger: null, message: plain, layout: "unknown", stackTrace: STACK.test(plain) };
}

/** Level for colouring; stack-trace lines count as errors. */
export function detectLogLevel(raw: string | ParsedLogLine): LogLevel | null {
  const p = typeof raw === "string" ? parseLogLine(raw) : raw;
  if (p.level) return p.level;
  if (p.stackTrace) return "error";
  return null;
}

/** Chat-like messages that a player can control; never treated as server events. */
export function isChatMessage(message: string): boolean {
  return /^(?:\[Not Secure\] )?<[^>]{1,40}> /.test(message) || /^\* \S{1,40} /.test(message);
}

/**
 * Prefix Minecraft 26.3+ (vanilla and Paper; absent in 26.2 and earlier) puts on everything the
 * server sends to its own console as a system message: command feedback ("Saved the game",
 * "There are 0 of a max of 20 players online: "), and the join/leave/death/advancement
 * broadcasts (`MinecraftServer.sendSystemMessage` logs `"System chat: {}"`). Player chat is
 * logged separately (`<name> …`, `[Not Secure] <name> …`) and never carries it.
 */
export const COMMAND_FEEDBACK_PREFIX = "System chat: ";

/**
 * Removes a leading `System chat: ` from a log message (the message part, see `parseLogLine`).
 * Chat lines (`<name> …`, `[Not Secure] <name> …`, `* name …`) are returned unchanged, so a
 * player typing "System chat: Saved the game" stays a chat line. Messages from older versions
 * have no prefix and are returned as they are.
 */
export function stripCommandFeedbackPrefix(message: string): string {
  if (isChatMessage(message) || !message.startsWith(COMMAND_FEEDBACK_PREFIX)) return message;
  return message.slice(COMMAND_FEEDBACK_PREFIX.length);
}

/**
 * Logger segments that belong to the server itself. Vanilla, Fabric and Paper print no logger for
 * Minecraft's own loggers (Paper prints `[Plugin] ` inside the message for everything else);
 * Forge/NeoForge print `[minecraft/<Class>]` (real lines: `[minecraft/Eula]`, `[minecraft/Main]`);
 * Velocity's latest.log prints the full class name (`com.velocitypowered.…`). Anything else —
 * `[EvilMod]`, `[com.evil.Mod]`, `[io.netty…]` — is a mod/plugin/library logger.
 */
export function isServerLogger(logger: string | null): boolean {
  return logger === null || /^minecraft\/[A-Za-z_$][\w$]{0,63}$/.test(logger) || /^com\.velocitypowered\.[\w$.]{1,200}$/.test(logger);
}

export interface ConsoleMessageOptions {
  /** Accept only these levels (e.g. `["info"]` for command feedback). Default: any. */
  levels?: readonly LogLevel[];
  /** Accept only these logger segments (`null` = no logger printed). Default: `isServerLogger`. */
  loggers?: readonly (string | null)[];
}

/**
 * The server's own message on a console line — log prefix and formatting removed, 26.3+
 * `System chat: ` prefix removed — or null when the line cannot be attributed to the server:
 * no recognised log layout (bare text), a mod/plugin logger (see `isServerLogger`), a level outside
 * `opts.levels`, or player chat (before or after the prefix). Callers anchor their patterns on
 * the result, so neither players nor other loggers can forge server output by accident.
 */
export function consoleMessage(raw: string | ParsedLogLine, opts: ConsoleMessageOptions = {}): string | null {
  const p = typeof raw === "string" ? parseLogLine(raw) : raw;
  if (p.layout === "unknown" || p.stackTrace) return null;
  if (opts.loggers ? !opts.loggers.includes(p.logger) : !isServerLogger(p.logger)) return null;
  if (opts.levels && (p.level === null || !opts.levels.includes(p.level))) return null;
  if (isChatMessage(p.message)) return null;
  const m = stripCommandFeedbackPrefix(p.message);
  return isChatMessage(m) ? null : m;
}

/**
 * Player name in event lines: the Java Edition grammar `[A-Za-z0-9_]{1,16}`, plus — as the only,
 * explicit extra — Floodgate's default `.` prefix for Bedrock players (`.Steve`). Anything else
 * (`@`, `/`, `..`, spaces, other offline-mode oddities) never becomes an event.
 */
const NAME = String.raw`(\.?[A-Za-z0-9_]{1,16})`;

/**
 * Forge/NeoForge logger segments allowed per event kind (`null` = no logger printed: vanilla,
 * Fabric, Paper, Velocity console). The classes are the ones whose LOGGER prints each line in the
 * 26.3 server jar (Mojang names, used by Forge/NeoForge at runtime since 1.17); the
 * `minecraft/<SimpleClass>` form is verified on real `[minecraft/Eula]` / `[minecraft/Main]` lines.
 * The MCP names (`ServerLoginNetHandler`, `NetHandlerPlayServer`, …) cover Forge ≤ 1.16 and are
 * not verified on captured lines.
 */
const mc = (...classes: string[]): readonly (string | null)[] => [null, ...classes.map((c) => `minecraft/${c}`)];
export const EVENT_LOGGERS = {
  /** `Done (…)! For help, type "help"` (`DedicatedServer`). */
  ready: mc("DedicatedServer"),
  /** Join/leave broadcasts (`MinecraftServer.sendSystemMessage`; `PlayerList` on old versions). */
  broadcast: mc("MinecraftServer", "DedicatedServer", "PlayerList"),
  /** `… logged in with entity id …`. */
  login: mc("PlayerList"),
  /** `UUID of player … is …`. */
  uuid: mc("ServerLoginPacketListenerImpl", "ServerLoginNetHandler", "NetHandlerLoginServer"),
  /** `… lost connection: …`. */
  disconnect: mc(
    "ServerGamePacketListenerImpl",
    "ServerConfigurationPacketListenerImpl",
    "ServerLoginPacketListenerImpl",
    "ServerPlayNetHandler",
    "ServerLoginNetHandler",
    "NetHandlerPlayServer",
    "NetHandlerLoginServer",
  ),
  /** Port bind failure and the EULA notice. */
  startup: mc("DedicatedServer", "Main", "Eula"),
} as const;

/** Velocity's own loggers in its latest.log (the console prints none). */
const isVelocityLogger = (logger: string | null) => logger === null || /^com\.velocitypowered\.[\w$.]{1,200}$/.test(logger);

export type LogEvent =
  | { type: "ready"; seconds: number | null }
  | { type: "player_join"; name: string; formerName?: string }
  | { type: "player_login"; name: string; address: string | null; entityId: number }
  | { type: "player_uuid"; name: string; uuid: string }
  | { type: "player_leave"; name: string }
  | { type: "player_disconnect"; name: string; reason: string }
  | { type: "proxy_connect"; name: string; address: string | null }
  | { type: "proxy_disconnect"; name: string; address: string | null; reason: string | null }
  | { type: "proxy_server_connect"; name: string; server: string }
  | { type: "proxy_server_disconnect"; name: string; server: string }
  | { type: "crash"; indicator: CrashIndicator; detail: string }
  | { type: "java_version_mismatch"; classFileVersion: number; requiredJava: number; supportedJava: number | null }
  | { type: "port_bind_failed" }
  | { type: "eula_required" }
  | { type: "tps"; tps1m: number; tps5m: number; tps15m: number };

export type CrashIndicator = "crash_report" | "tick_loop_exception" | "unexpected_exception" | "out_of_memory" | "watchdog" | "jvm_fatal_error";

function validName(n: string): boolean {
  return !(n.startsWith("<") && n.endsWith(">"));
}

function address(s: string): string | null {
  const a = s.replace(/^\//, "");
  return a === "<ip address withheld>" || a === "local" || a === "" ? null : a;
}

function num(s: string): number {
  return Number(s.replace(",", "."));
}

/** All events a single line carries (usually 0 or 1). */
export function detectLogEvents(raw: string | ParsedLogLine): LogEvent[] {
  const p = typeof raw === "string" ? parseLogLine(raw) : raw;
  const events: LogEvent[] = [];
  if (isChatMessage(p.message)) return events;
  // 26.3+ logs join/leave broadcasts as "System chat: Steve joined the game". Each server event
  // needs a recognised layout and the logger that prints it (`EVENT_LOGGERS`); crash indicators
  // below still look at every line.
  const server = (loggers: readonly (string | null)[]) => consoleMessage(p, { loggers }) ?? "";
  const velocity = isVelocityLogger(p.logger) ? (consoleMessage(p, { loggers: [p.logger] }) ?? "") : "";

  // Readiness: game servers `Done (3.456s)! For help, type "help"`; Velocity `Done (0.96s)!`.
  const READY = /^Done \((\d+(?:[.,]\d+)?)s\)!(?: For help, type "help")?/;
  let m = READY.exec(server(EVENT_LOGGERS.ready)) ?? READY.exec(velocity);
  if (m) events.push({ type: "ready", seconds: num(m[1]!) });

  const broadcast = server(EVENT_LOGGERS.broadcast);
  if ((m = new RegExp(String.raw`^${NAME} joined the game$`).exec(broadcast)) && validName(m[1]!)) events.push({ type: "player_join", name: m[1]! });
  else if ((m = new RegExp(String.raw`^${NAME} \(formerly known as ${NAME}\) joined the game$`).exec(broadcast)) && validName(m[1]!)) {
    events.push({ type: "player_join", name: m[1]!, formerName: m[2]! });
  }
  if ((m = new RegExp(String.raw`^${NAME} left the game$`).exec(broadcast)) && validName(m[1]!)) events.push({ type: "player_leave", name: m[1]! });
  if ((m = new RegExp(String.raw`^${NAME}\[(.*)\] logged in with entity id (\d+) at \(`).exec(server(EVENT_LOGGERS.login)))) {
    events.push({ type: "player_login", name: m[1]!, address: address(m[2]!), entityId: Number(m[3]) });
  }
  if ((m = new RegExp(String.raw`^UUID of player ${NAME} is ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, "i").exec(server(EVENT_LOGGERS.uuid)))) {
    events.push({ type: "player_uuid", name: m[1]!, uuid: m[2]!.toLowerCase() });
  }
  const disconnect = server(EVENT_LOGGERS.disconnect);
  if ((m = new RegExp(String.raw`^${NAME} lost connection: (.*)$`).exec(disconnect)) && validName(m[1]!)) {
    events.push({ type: "player_disconnect", name: m[1]!, reason: m[2]! });
  } else if ((m = new RegExp(String.raw`^${NAME} \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\) lost connection: (.*)$`).exec(disconnect)) && validName(m[1]!)) {
    // Configuration phase (1.20.2+): `{name} ({uuid}) lost connection: {reason}`.
    events.push({ type: "player_disconnect", name: m[1]!, reason: m[3]! });
  }
  // Velocity (ConnectedPlayer#toString / VelocityServerConnection#toString, 4.2.0 source).
  if ((m = new RegExp(String.raw`^\[connected player\] ${NAME} \((.*?)\) has connected$`).exec(velocity))) {
    events.push({ type: "proxy_connect", name: m[1]!, address: address(m[2]!) });
  } else if ((m = new RegExp(String.raw`^\[connected player\] ${NAME} \((.*?)\) has disconnected(?:: (.*))?$`).exec(velocity))) {
    events.push({ type: "proxy_disconnect", name: m[1]!, address: address(m[2]!), reason: m[3] ?? null });
  }
  if ((m = new RegExp(String.raw`^\[server connection\] ${NAME} -> ([A-Za-z0-9._-]{1,64}) has (connected|disconnected)$`).exec(velocity))) {
    events.push({ type: m[3] === "connected" ? "proxy_server_connect" : "proxy_server_disconnect", name: m[1]!, server: m[2]! });
  }

  const crash = detectCrashIndicator(p);
  if (crash) events.push(crash);

  if ((m = /UnsupportedClassVersionError: .*class file version (\d+(?:\.\d+)?)\)?(?:, this version of the Java Runtime only recognizes class file versions up to (\d+(?:\.\d+)?))?/.exec(p.plain))) {
    const cf = Math.trunc(Number(m[1]));
    events.push({
      type: "java_version_mismatch",
      classFileVersion: cf,
      requiredJava: javaMajorForClassFileVersion(cf),
      supportedJava: m[2] ? javaMajorForClassFileVersion(Number(m[2])) : null,
    });
  }
  const startup = server(EVENT_LOGGERS.startup);
  if (/\*\*\*\* FAILED TO BIND TO PORT!/.test(startup)) events.push({ type: "port_bind_failed" });
  if (/^You need to agree to the EULA in order to run the server/.test(startup)) events.push({ type: "eula_required" });
  const tps = parsePaperTps(p);
  if (tps) events.push(tps);
  return events;
}

/** Crash/hang indicators; null for chat lines and ordinary output. */
export function detectCrashIndicator(raw: string | ParsedLogLine): Extract<LogEvent, { type: "crash" }> | null {
  const p = typeof raw === "string" ? parseLogLine(raw) : raw;
  if (isChatMessage(p.message)) return null;
  const s = p.plain;
  const hit = (indicator: CrashIndicator): Extract<LogEvent, { type: "crash" }> => ({ type: "crash", indicator, detail: s.slice(0, 300) });
  if (s.includes("---- Minecraft Crash Report ----")) return hit("crash_report");
  if (s.includes("Exception in server tick loop")) return hit("tick_loop_exception");
  if (s.includes("Encountered an unexpected exception")) return hit("unexpected_exception");
  if (/\bjava\.lang\.OutOfMemoryError\b/.test(s)) return hit("out_of_memory");
  if (/A single server tick took [\d.,]+ seconds|The server has stopped responding!|Considering it to be crashed, server will forcibly shutdown/.test(s)) return hit("watchdog");
  if (s.includes("# A fatal error has been detected by the Java Runtime Environment")) return hit("jvm_fatal_error");
  return null;
}

/**
 * Paper `/tps`: `TPS from last 1m, 5m, 15m: 20.0, 19.95, 20.0` (Paper TicksPerSecondCommand;
 * older builds prefix values above 20 with `*`). Colour codes are stripped first.
 */
export function parsePaperTps(raw: string | ParsedLogLine): Extract<LogEvent, { type: "tps" }> | null {
  const msg = consoleMessage(raw);
  if (msg === null) return null;
  const m = /TPS from last 1m, 5m, 15m: \*?(\d+(?:\.\d+)?), \*?(\d+(?:\.\d+)?), \*?(\d+(?:\.\d+)?)\s*$/.exec(msg);
  if (!m) return null;
  return { type: "tps", tps1m: Number(m[1]), tps5m: Number(m[2]), tps15m: Number(m[3]) };
}

/** Convenience for readiness checks. */
export function detectReadiness(raw: string | ParsedLogLine): { seconds: number | null } | null {
  const e = detectLogEvents(raw).find((x) => x.type === "ready");
  return e && e.type === "ready" ? { seconds: e.seconds } : null;
}
