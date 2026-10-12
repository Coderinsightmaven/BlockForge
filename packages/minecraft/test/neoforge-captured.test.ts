import { describe, expect, it } from "vitest";
import { detectLogEvents, detectReadiness, isSaveConfirmation } from "../src/index.js";

/*
 * Lines captured 2026-10-12 from a live NeoForge 1.21.1 server (All The Mods 11) on the test node, read with
 * `docker logs` only. Player names, IPs and UUIDs are anonymised; logger classes and wording are verbatim.
 */
const NEOFORGE = {
  ready: '[22:27:55] [Server thread/INFO] [minecraft/DedicatedServer]: Done (1.021s)! For help, type "help"',
  login:
    "[02:21:56] [Server thread/INFO] [minecraft/PlayerList]: PlayerX[/203.0.113.1:50000] logged in with entity id 44 at (316.6049331293055, 145.0, -247.03477814454186)",
  join: "[02:21:58] [Server thread/INFO] [minecraft/MinecraftServer]: PlayerX joined the game",
  leave: "[02:22:30] [Server thread/INFO] [minecraft/MinecraftServer]: PlayerX left the game",
  preLoginDisconnect:
    "[12:05:02] [Server thread/INFO] [minecraft/ServerLoginPacketListenerImpl]: Scanner1 (/203.0.113.1:50000) lost connection: Disconnected",
  rconSave: "[22:28:31] [Server thread/INFO] [minecraft/MinecraftServer]: [Rcon: Saved the game]",
};

describe("real NeoForge (ATM11) console lines", () => {
  it("detects readiness from [minecraft/DedicatedServer]", () => {
    expect(detectReadiness(NEOFORGE.ready)).toEqual({ seconds: 1.021 });
    expect(detectLogEvents(NEOFORGE.ready)).toContainEqual({ type: "ready", seconds: 1.021 });
  });

  it("detects login, join and leave from the classes NeoForge logs them with", () => {
    expect(detectLogEvents(NEOFORGE.login)).toContainEqual(expect.objectContaining({ type: "player_login", name: "PlayerX", entityId: 44 }));
    expect(detectLogEvents(NEOFORGE.join)).toContainEqual(expect.objectContaining({ type: "player_join", name: "PlayerX" }));
    expect(detectLogEvents(NEOFORGE.leave)).toContainEqual({ type: "player_leave", name: "PlayerX" });
  });

  it("does not open sessions for pre-login disconnects", () => {
    expect(detectLogEvents(NEOFORGE.preLoginDisconnect).filter((e) => e.type === "player_join" || e.type === "player_leave")).toEqual([]);
  });

  it("does not treat an RCON client's broadcast save feedback as our save confirmation", () => {
    expect(isSaveConfirmation(NEOFORGE.rconSave)).toBe(false);
  });
});
