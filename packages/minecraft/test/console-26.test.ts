import { describe, expect, it } from "vitest";
import {
  COMMAND_FEEDBACK_PREFIX,
  consoleMessage,
  detectLogEvents,
  detectReadiness,
  isSaveConfirmation,
  isSaveFailure,
  isSaveOffConfirmation,
  isSaveOnConfirmation,
  parseCommandFeedback,
  parsePaperTps,
  parsePlayerListOutput,
  parseWhitelistListOutput,
  stripCommandFeedbackPrefix,
} from "../src/index.js";
import { fixture } from "./helpers.js";

/** Real console lines captured from Paper 26.3 and the vanilla egg (26.3) on the test node. */
const captured = (JSON.parse(fixture("console/captured-26.3.json")) as { lines: Record<"paper-26.3" | "vanilla-egg-26.3", string[]> }).lines;
const formats = [
  ["paper-26.3", captured["paper-26.3"]],
  ["vanilla-egg-26.3", captured["vanilla-egg-26.3"]],
] as const;
const find = (lines: readonly string[], text: string) => lines.filter((l) => l.endsWith(text) || l.endsWith(`${text} `));

describe("26.3 `System chat: ` prefix", () => {
  it("strips the prefix but never touches chat lines", () => {
    expect(COMMAND_FEEDBACK_PREFIX).toBe("System chat: ");
    expect(stripCommandFeedbackPrefix("System chat: Saved the game")).toBe("Saved the game");
    expect(stripCommandFeedbackPrefix("Saved the game")).toBe("Saved the game");
    expect(stripCommandFeedbackPrefix("<Steve> System chat: Saved the game")).toBe("<Steve> System chat: Saved the game");
    expect(stripCommandFeedbackPrefix("[Not Secure] <Steve> System chat: Saved the game")).toBe("[Not Secure] <Steve> System chat: Saved the game");
    expect(stripCommandFeedbackPrefix("* Steve System chat: Saved the game")).toBe("* Steve System chat: Saved the game");
    expect(stripCommandFeedbackPrefix("System chat: System chat: x")).toBe("System chat: x"); // only one prefix
  });

  it("consoleMessage: log prefix + System chat removed; chat (before or after the prefix) → null", () => {
    expect(consoleMessage("[19:33:07 INFO]: System chat: Saved the game")).toBe("Saved the game");
    expect(consoleMessage("[19:35:40] [Server thread/INFO]: System chat: Saved the game")).toBe("Saved the game");
    expect(consoleMessage("[19:35:40] [Server thread/INFO]: Saved the game")).toBe("Saved the game");
    expect(consoleMessage("[19:35:40] [Server thread/INFO]: <Steve> Saved the game")).toBeNull();
    expect(consoleMessage("[19:35:40 INFO]: [Not Secure] <Steve> System chat: Saved the game")).toBeNull();
    expect(consoleMessage("[19:35:40 INFO]: System chat: <Steve> Saved the game")).toBeNull();
  });
});

describe.each(formats)("captured %s console lines", (_name, lines) => {
  it("save-off / save-all / save-on feedback", () => {
    expect(lines.filter((l) => isSaveConfirmation(l))).toEqual(find(lines, "Saved the game"));
    expect(find(lines, "Saved the game").length).toBeGreaterThan(0);
    expect(lines.filter((l) => isSaveOffConfirmation(l))).toEqual(find(lines, "Automatic saving is now disabled"));
    expect(lines.filter((l) => isSaveOnConfirmation(l))).toEqual(find(lines, "Automatic saving is now enabled"));
    // "Saving the game (this may take a moment!)" is progress, not confirmation.
    for (const l of find(lines, "Saving the game (this may take a moment!)")) {
      expect(isSaveConfirmation(l)).toBe(false);
      expect(isSaveFailure(l)).toBe(false);
    }
  });

  it("`list` output", () => {
    const line = lines.find((l) => l.includes("players online"))!;
    const out = parsePlayerListOutput([line]);
    expect(out).toMatchObject({ format: "vanilla", online: 0, players: [] });
    expect(out!.max).toBe(_name === "paper-26.3" ? 10 : 20);
  });

  it("`whitelist list` and player errors", () => {
    expect(parseWhitelistListOutput(lines)).toEqual({ format: "vanilla", players: [] });
    const fb = lines.map((l) => parseCommandFeedback(l)).filter((x) => x !== null);
    expect(fb).toEqual([
      { action: "player", ok: false, message: "That player does not exist" },
      { action: "player", ok: false, message: "No player was found" },
    ]);
  });

  it("no captured line is mistaken for an event", () => {
    for (const l of lines) {
      expect(detectLogEvents(l)).toEqual([]);
      expect(detectReadiness(l)).toBeNull();
    }
  });
});

describe("save feedback across versions", () => {
  it.each([
    ["[19:35:40] [Server thread/INFO]: Saved the game", "saved"],
    ["[12:00:00] [Server thread/INFO]: Saved the world", "saved"],
    ["[12:00:00 INFO]: Saved the game", "saved"],
    ["[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: Saved the game", "saved"],
    ["[19:35:40] [Server thread/INFO]: System chat: Unable to save the game (is there enough disk space?)", "failed"],
    ["[12:00:00] [Server thread/INFO]: Saving failed: java.io.IOException: No space left on device", "failed"],
    ["[12:00:00] [Server thread/INFO]: Turned off world auto-saving", "off"],
    ["[12:00:00] [Server thread/INFO]: System chat: Saving is already turned off", "off"],
    ["[12:00:00] [Server thread/INFO]: Turned on world auto-saving", "on"],
    ["[12:00:00] [Server thread/INFO]: Saving is already turned on", "on"],
  ] as const)("%s → %s", (line, kind) => {
    expect(isSaveConfirmation(line)).toBe(kind === "saved");
    expect(isSaveFailure(line)).toBe(kind === "failed");
    expect(isSaveOffConfirmation(line)).toBe(kind === "off");
    expect(isSaveOnConfirmation(line)).toBe(kind === "on");
  });

  it.each([
    "[19:35:40] [Server thread/INFO]: <Steve> Saved the game",
    "[19:35:40] [Server thread/INFO]: [Not Secure] <Steve> Saved the game",
    "[19:35:40] [Server thread/INFO]: [Not Secure] <Steve> System chat: Saved the game",
    "[19:35:40] [Server thread/INFO]: * Steve Saved the game",
    "[19:35:40] [Server thread/INFO]: System chat: <Steve> Saved the game",
    "[19:35:40] [Server thread/INFO]: [Steve] Saved the game", // /say
    "[19:35:40] [Server thread/INFO]: System chat: [Steve: Saved the game]", // op broadcast of a player's save-all
    "[19:35:40] [Server thread/INFO]: Saved the game and more",
  ])("chat and look-alikes never confirm: %s", (line) => {
    expect(isSaveConfirmation(line)).toBe(false);
    expect(isSaveOffConfirmation(line.replace("Saved the game", "Automatic saving is now disabled"))).toBe(false);
  });
});

it("a bare message without a recognised log layout is taken as the server's text", () => {
  expect(isSaveConfirmation("Saved the game")).toBe(true);
  expect(isSaveConfirmation("System chat: Saved the game")).toBe(true);
});

describe("events and other parsers with the 26.3 prefix", () => {
  // MinecraftServer.sendSystemMessage logs "System chat: {}" in 26.3 (absent in 26.2), and
  // PlayerList.broadcastSystemMessage — used for multiplayer.player.joined/left — calls it, so
  // join/leave broadcasts carry the prefix too (bytecode; no captured join yet).
  it("join/leave broadcasts with the prefix are still events", () => {
    expect(detectLogEvents("[19:40:00] [Server thread/INFO]: System chat: Steve joined the game")).toEqual([{ type: "player_join", name: "Steve" }]);
    expect(detectLogEvents("[19:40:00 INFO]: System chat: Steve left the game")).toEqual([{ type: "player_leave", name: "Steve" }]);
    expect(detectLogEvents("[19:40:00 INFO]: System chat: Steve (formerly known as Alex) joined the game")).toEqual([{ type: "player_join", name: "Steve", formerName: "Alex" }]);
    expect(detectLogEvents("[19:40:00 INFO]: <Griefer> System chat: Steve joined the game")).toEqual([]);
    expect(detectLogEvents("[19:40:00 INFO]: System chat: <Griefer> Steve joined the game")).toEqual([]);
  });

  it("LOGGER lines keep their pre-26.3 form (readiness, login, configuration-phase disconnect)", () => {
    expect(detectReadiness('[19:30:00] [Server thread/INFO]: Done (4.321s)! For help, type "help"')).toEqual({ seconds: 4.321 });
    expect(detectReadiness('[19:30:00 INFO]: System chat: Done (4.321s)! For help, type "help"')).toEqual({ seconds: 4.321 });
    expect(detectLogEvents("[19:40:00] [Server thread/INFO]: Steve (069a79f4-44e9-4726-a5be-fca90e38aaf5) lost connection: Disconnected")).toEqual([
      { type: "player_disconnect", name: "Steve", reason: "Disconnected" },
    ]);
  });

  it("Paper /tps with and without the prefix", () => {
    expect(parsePaperTps("[19:40:00 INFO]: System chat: TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0")).toMatchObject({ tps1m: 20 });
    expect(parsePaperTps("[19:40:00 INFO]: <Griefer> TPS from last 1m, 5m, 15m: 1.0, 1.0, 1.0")).toBeNull();
  });

  it("pre-26.3 list output and feedback still parse", () => {
    expect(parsePlayerListOutput(["[12:00:00] [Server thread/INFO]: There are 1 of a max of 20 players online: Steve"])!.players).toEqual([{ name: "Steve", uuid: null }]);
    expect(parseCommandFeedback("[12:00:00] [Server thread/INFO]: Made Steve a server operator")).toMatchObject({ action: "op", ok: true });
    expect(parseCommandFeedback("[19:40:00 INFO]: System chat: Made Steve a server operator")).toMatchObject({ action: "op", ok: true, target: "Steve" });
    expect(parseWhitelistListOutput(["[19:40:00 INFO]: System chat: There are 2 whitelisted player(s): Steve, Alex"])).toEqual({ format: "vanilla", players: ["Steve", "Alex"] });
    expect(parseWhitelistListOutput(["There are 2 (out of 5 seen) whitelisted players:", "Steve, Alex"])).toEqual({ format: "legacy", players: ["Steve", "Alex"] });
  });
});
