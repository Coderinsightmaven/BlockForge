import { describe, expect, it } from "vitest";
import { detectCrashIndicator, detectLogEvents, detectLogLevel, detectReadiness, parseLogLine, parsePaperTps, stripFormatting, tokenizeFormatting } from "../src/index.js";
import { fixture } from "./helpers.js";

const lines = (f: string) => fixture(`logs/${f}`).split(/\r?\n/).filter((l) => l.length > 0);
const events = (l: string) => detectLogEvents(l);

describe("real startup logs (captured 2026-10-12)", () => {
  it("Velocity 4.2.0: readiness, levels and logger", () => {
    const ls = lines("velocity-4.2.0-startup.log");
    const ready = ls.map((l) => detectReadiness(l)).filter(Boolean);
    expect(ready).toEqual([{ seconds: 1.55 }]);
    expect(parseLogLine(ls[2]!)).toMatchObject({ time: "03:42:23", level: "warn", layout: "bracket-level" });
    expect(parseLogLine(ls.find((l) => l.includes("MacAddressUtil"))!)).toMatchObject({ level: "warn", logger: "io.netty.util.internal.MacAddressUtil" });
  });

  it("Paper 26.3: console layout and EULA gate", () => {
    const ls = lines("paper-26.3-first-start.log");
    const boot = parseLogLine(ls.find((l) => l.includes("[bootstrap] Loading Paper"))!);
    expect(boot).toMatchObject({ level: "info", message: expect.stringMatching(/^\[bootstrap\] Loading Paper 26\.3/) });
    expect(ls.flatMap(events).map((e) => e.type)).toEqual(["eula_required"]);
    expect(detectLogLevel(ls.find((l) => l.includes("Failed to load eula.txt"))!)).toBe("warn");
  });

  it("NeoForge 21.1.259: ANSI-coloured console lines parse after stripping", () => {
    const ls = lines("neoforge-21.1.259-first-start.log");
    const coloured = ls.find((l) => l.includes("\u001b[") && l.includes("Launching target"))!;
    expect(coloured).toBeDefined();
    const p = parseLogLine(coloured);
    expect(p).toMatchObject({ time: expect.stringMatching(/^\d{2}:\d{2}:\d{2}\.\d{3}$/), thread: "main", level: "info", logger: "LaunchServiceHandler/MODLAUNCHER" });
    expect(p.plain).not.toContain("\u001b");
    expect(ls.flatMap(events).some((e) => e.type === "eula_required")).toBe(true);
  });

  it("Forge 1.21.11: logger with marker", () => {
    const ls = lines("forge-1.21.11-61.2.0-first-start.log");
    const p = parseLogLine(ls.find((l) => l.includes("[minecraft/Eula]"))!);
    expect(p).toMatchObject({ thread: "main", level: "warn", logger: "minecraft/Eula", message: "Failed to load eula.txt" });
  });

  it("Fabric and vanilla: stack traces are classified as errors", () => {
    const fabric = lines("fabric-1.21.11-0.19.5-first-start.log");
    expect(parseLogLine(fabric.find((l) => l.includes("Loading Minecraft 1.21.11 with Fabric Loader"))!)).toMatchObject({ level: "info", thread: "main" });
    const vanilla = lines("vanilla-26.3-no-eula.log");
    expect(parseLogLine(vanilla[0]!)).toMatchObject({ thread: "ServerMain", level: "error" });
    const frame = vanilla.find((l) => l.trimStart().startsWith("at "))!;
    expect(parseLogLine(frame).stackTrace).toBe(true);
    expect(detectLogLevel(frame)).toBe("error");
    expect(detectLogLevel("java.nio.file.NoSuchFileException: server.properties")).toBe("error");
    expect(vanilla.flatMap(events).map((e) => e.type)).toEqual(["eula_required"]);
  });
});

describe("events (lines built from verified format strings, see fixtures/logs/synthesized-events.md)", () => {
  it("readiness for vanilla, Paper and Forge layouts", () => {
    expect(detectReadiness('[12:00:01] [Server thread/INFO]: Done (3.456s)! For help, type "help"')).toEqual({ seconds: 3.456 });
    expect(detectReadiness('[12:00:01 INFO]: Done (12.03s)! For help, type "help"')).toEqual({ seconds: 12.03 });
    expect(detectReadiness('[12:00:01] [Server thread/INFO] [minecraft/DedicatedServer]: Done (20,5s)! For help, type "help"')).toEqual({ seconds: 20.5 });
    expect(detectReadiness('[12:00:01] [Server thread/INFO]: <Steve> Done (1.0s)! For help, type "help"')).toBeNull();
    expect(detectReadiness('Done (1.0s)! For help, type "help"')).toBeNull();
  });

  it("player join/leave/login/uuid/disconnect (vanilla and Paper layouts)", () => {
    expect(events("[12:00:00] [Server thread/INFO]: Steve joined the game")).toEqual([{ type: "player_join", name: "Steve" }]);
    expect(events("[12:00:00 INFO]: Alex_99 left the game")).toEqual([{ type: "player_leave", name: "Alex_99" }]);
    expect(events("[12:00:00] [Server thread/INFO]: Steve (formerly known as Notch) joined the game")).toEqual([{ type: "player_join", name: "Steve", formerName: "Notch" }]);
    expect(events("[12:00:00] [Server thread/INFO]: Steve[/172.18.0.1:40112] logged in with entity id 123 at (0.5, 64.0, 0.5)")).toEqual([
      { type: "player_login", name: "Steve", address: "172.18.0.1:40112", entityId: 123 },
    ]);
    expect(events("[12:00:00 INFO]: Steve[/[2001:db8::1]:40112] logged in with entity id 7 at ([world]0.5, 64.0, 0.5)")[0]).toMatchObject({ address: "[2001:db8::1]:40112" });
    expect(events("[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is 069A79F4-44E9-4726-A5BE-FCA90E38AAF5")).toEqual([
      { type: "player_uuid", name: "Steve", uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5" },
    ]);
    expect(events("[12:00:00] [Server thread/INFO]: Steve lost connection: Disconnected")).toEqual([{ type: "player_disconnect", name: "Steve", reason: "Disconnected" }]);
    expect(events("[12:00:00] [Server thread/INFO]: .BedrockPlayer joined the game")[0]).toMatchObject({ name: ".BedrockPlayer" });
  });

  it("Velocity proxy connections", () => {
    expect(events("[12:00:00 INFO]: [connected player] Steve (/203.0.113.7:51234) has connected")).toEqual([{ type: "proxy_connect", name: "Steve", address: "203.0.113.7:51234" }]);
    expect(events("[12:00:00 INFO]: [server connection] Steve -> lobby has connected")).toEqual([{ type: "proxy_server_connect", name: "Steve", server: "lobby" }]);
    expect(events("[12:00:00 INFO]: [connected player] Steve (<ip address withheld>) has disconnected")).toEqual([
      { type: "proxy_disconnect", name: "Steve", address: null, reason: null },
    ]);
    expect(events("[12:00:00 INFO]: [connected player] Steve (/203.0.113.7:51234) has disconnected: You were kicked")[0]).toMatchObject({ reason: "You were kicked" });
    expect(events("[12:00:00 INFO]: [server connection] Steve -> survival has disconnected")[0]).toMatchObject({ type: "proxy_server_disconnect", server: "survival" });
  });

  it("ignores spoofing attempts through chat, /me and formatting codes", () => {
    for (const l of [
      "[12:00:00] [Server thread/INFO]: <Mallory> Steve joined the game",
      "[12:00:00] [Server thread/INFO]: [Not Secure] <Mallory> java.lang.OutOfMemoryError",
      "[12:00:00 INFO]: * Mallory ---- Minecraft Crash Report ----",
      "[12:00:00 INFO]: <Mallory> TPS from last 1m, 5m, 15m: 1.0, 1.0, 1.0",
      "[12:00:00] [Server thread/INFO]: <Mallory> joined the game",
    ]) {
      expect(events(l), l).toEqual([]);
    }
  });

  it("crash and hang indicators", () => {
    expect(detectCrashIndicator("---- Minecraft Crash Report ----")?.indicator).toBe("crash_report");
    expect(detectCrashIndicator("[12:00:00] [Server thread/ERROR]: Encountered an unexpected exception")?.indicator).toBe("unexpected_exception");
    expect(detectCrashIndicator("[12:00:00] [Server thread/ERROR]: Exception in server tick loop")?.indicator).toBe("tick_loop_exception");
    expect(detectCrashIndicator('Exception in thread "Server thread" java.lang.OutOfMemoryError: Java heap space')?.indicator).toBe("out_of_memory");
    expect(detectCrashIndicator("[12:01:00] [Server Watchdog/ERROR]: A single server tick took 60.00 seconds (should be max 0.05)")?.indicator).toBe("watchdog");
    expect(detectCrashIndicator("[12:01:00 ERROR]: The server has stopped responding! This is (probably) not a Paper bug.")?.indicator).toBe("watchdog");
    expect(detectCrashIndicator("# A fatal error has been detected by the Java Runtime Environment:")?.indicator).toBe("jvm_fatal_error");
    expect(detectCrashIndicator("[12:00:00] [Server thread/INFO]: Saving chunks")).toBeNull();
  });

  it("startup failures", () => {
    expect(
      events(
        "Error: LinkageError occurred while loading main class io.papermc.paperclip.Main\njava.lang.UnsupportedClassVersionError: io/papermc/paperclip/Main has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0".split("\n")[1]!,
      ),
    ).toEqual([{ type: "java_version_mismatch", classFileVersion: 69, requiredJava: 25, supportedJava: 21 }]);
    expect(events("[12:00:00] [Server thread/WARN]: **** FAILED TO BIND TO PORT!")).toEqual([{ type: "port_bind_failed" }]);
  });

  it("Paper TPS (plain, coloured and legacy asterisk)", () => {
    expect(parsePaperTps("[12:00:00 INFO]: TPS from last 1m, 5m, 15m: 20.0, 19.97, 18.5")).toEqual({ type: "tps", tps1m: 20, tps5m: 19.97, tps15m: 18.5 });
    expect(parsePaperTps("[12:00:00 INFO]: §6TPS from last 1m, 5m, 15m: §a*20.0, §e17.2, §c12.0")).toEqual({ type: "tps", tps1m: 20, tps5m: 17.2, tps15m: 12 });
    expect(parsePaperTps("[12:00:00 INFO]: \u001b[38;2;255;170;0mTPS from last 1m, 5m, 15m: \u001b[38;2;85;255;85m20.0, 20.0, 20.0\u001b[m")).toMatchObject({ tps15m: 20 });
    expect(parsePaperTps("TPS: unknown")).toBeNull();
  });
});

describe("formatting tokenizer", () => {
  it("parses § colours, decorations, reset and hex", () => {
    const segs = tokenizeFormatting("§aGreen §lBold§r plain §x§F§F§0§0§0§0red");
    expect(segs).toEqual([
      { text: "Green ", style: expect.objectContaining({ color: { kind: "minecraft", name: "green" }, bold: false }) },
      { text: "Bold", style: expect.objectContaining({ color: { kind: "minecraft", name: "green" }, bold: true }) },
      { text: " plain ", style: expect.objectContaining({ color: null, bold: false }) },
      { text: "red", style: expect.objectContaining({ color: { kind: "rgb", hex: "#ff0000" } }) },
    ]);
    expect(stripFormatting("§kobf§zx§")).toBe("obfx");
  });

  it("parses ANSI SGR including 256-colour and truecolor, strips other sequences", () => {
    const segs = tokenizeFormatting("\u001b[1;31mred\u001b[22;38;5;208m orange\u001b[38;2;1;2;3m rgb\u001b[0m\u001b[2K\u001b]0;title\u0007 done\u001b[39m");
    expect(segs.map((s) => [s.text, s.style.color, s.style.bold])).toEqual([
      ["red", { kind: "ansi", index: 1 }, true],
      [" orange", { kind: "ansi", index: 208 }, false],
      [" rgb", { kind: "rgb", hex: "#010203" }, false],
      [" done", null, false],
    ]);
  });

  it("removes control characters and never yields markup", () => {
    expect(stripFormatting("a\u0000b\u0007c\rd\te\u009bf")).toBe("abcd\tef");
    expect(stripFormatting("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
    expect(tokenizeFormatting("\u001b[")).toEqual([]);
    expect(stripFormatting("\u001b")).toBe("");
  });
});
