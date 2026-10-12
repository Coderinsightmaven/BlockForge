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
 * Player name: Mojang names are [A-Za-z0-9_]{1,16}; offline-mode servers accept any printable
 * ASCII, Floodgate prefixes Bedrock names with "." — brackets/parentheses/angle brackets are
 * excluded so names cannot swallow the surrounding log syntax.
 */
const NAME = String.raw`([.*]?[!-'*-;=?-Z^-~\\]{1,16})`;

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
  const msg = p.message;
  const events: LogEvent[] = [];
  if (isChatMessage(msg)) return events;

  // Readiness: game servers `Done (3.456s)! For help, type "help"`; Velocity `Done (1.55s)!`.
  let m = /^Done \((\d+(?:[.,]\d+)?)s\)!(?: For help, type "help")?/.exec(msg);
  if (m && p.layout !== "unknown") events.push({ type: "ready", seconds: num(m[1]!) });

  if ((m = new RegExp(String.raw`^${NAME} joined the game$`).exec(msg)) && validName(m[1]!)) events.push({ type: "player_join", name: m[1]! });
  else if ((m = new RegExp(String.raw`^${NAME} \(formerly known as ${NAME}\) joined the game$`).exec(msg)) && validName(m[1]!)) {
    events.push({ type: "player_join", name: m[1]!, formerName: m[2]! });
  }
  if ((m = new RegExp(String.raw`^${NAME} left the game$`).exec(msg)) && validName(m[1]!)) events.push({ type: "player_leave", name: m[1]! });
  if ((m = new RegExp(String.raw`^${NAME}\[(.*)\] logged in with entity id (\d+) at \(`).exec(msg))) {
    events.push({ type: "player_login", name: m[1]!, address: address(m[2]!), entityId: Number(m[3]) });
  }
  if ((m = new RegExp(String.raw`^UUID of player ${NAME} is ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, "i").exec(msg))) {
    events.push({ type: "player_uuid", name: m[1]!, uuid: m[2]!.toLowerCase() });
  }
  if ((m = new RegExp(String.raw`^${NAME} lost connection: (.*)$`).exec(msg)) && validName(m[1]!)) {
    events.push({ type: "player_disconnect", name: m[1]!, reason: m[2]! });
  }
  // Velocity (ConnectedPlayer#toString / VelocityServerConnection#toString, 4.2.0 source).
  if ((m = new RegExp(String.raw`^\[connected player\] ${NAME} \((.*?)\) has connected$`).exec(msg))) {
    events.push({ type: "proxy_connect", name: m[1]!, address: address(m[2]!) });
  } else if ((m = new RegExp(String.raw`^\[connected player\] ${NAME} \((.*?)\) has disconnected(?:: (.*))?$`).exec(msg))) {
    events.push({ type: "proxy_disconnect", name: m[1]!, address: address(m[2]!), reason: m[3] ?? null });
  }
  if ((m = new RegExp(String.raw`^\[server connection\] ${NAME} -> (\S+) has (connected|disconnected)$`).exec(msg))) {
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
  if (/\*\*\*\* FAILED TO BIND TO PORT!/.test(msg)) events.push({ type: "port_bind_failed" });
  if (/^You need to agree to the EULA in order to run the server/.test(msg)) events.push({ type: "eula_required" });
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
  const p = typeof raw === "string" ? parseLogLine(raw) : raw;
  if (isChatMessage(p.message)) return null;
  const m = /TPS from last 1m, 5m, 15m: \*?(\d+(?:\.\d+)?), \*?(\d+(?:\.\d+)?), \*?(\d+(?:\.\d+)?)\s*$/.exec(p.message);
  if (!m) return null;
  return { type: "tps", tps1m: Number(m[1]), tps5m: Number(m[2]), tps15m: Number(m[3]) };
}

/** Convenience for readiness checks. */
export function detectReadiness(raw: string | ParsedLogLine): { seconds: number | null } | null {
  const e = detectLogEvents(raw).find((x) => x.type === "ready");
  return e && e.type === "ready" ? { seconds: e.seconds } : null;
}
