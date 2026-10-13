import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AgentGateway } from "../../src/agents/gateway.js";
import { ConsoleCommandTracker, SAVE_HOLD_MAX_MS } from "../../src/players/console.js";

/** #4 (control-plane Phase 4b review, rounds 1–2): which console commands may be answering. */

const S = "11111111-1111-4111-8111-111111111111";
const LINGER = 500;

function setup() {
  const emitter = new EventEmitter();
  const clock = { now: 0 };
  const tracker = new ConsoleCommandTracker(emitter as unknown as AgentGateway, () => clock.now, LINGER);
  let seq = 0;
  return {
    clock,
    tracker,
    foreign: (id: string, line = "say hi") => emitter.emit("consoleCommand", S, id, line),
    output: (line: string) => emitter.emit("consoleLines", S, [{ seq: ++seq, ts: 0, stream: "stdout", line }]),
    entries: () => (tracker as unknown as { servers: Map<string, Map<string, unknown>> }).servers.get(S)?.size ?? 0,
  };
}

describe("ConsoleCommandTracker", () => {
  it("alone → not contended; a foreign command at any time during the wait contends, even after it expired", () => {
    const s = setup();
    s.tracker.begin(S, "mine", false);
    expect(s.tracker.contended(S, "mine")).toBe(false);
    s.clock.now = 100;
    s.foreign("typed");
    s.clock.now = 100 + LINGER + 1; // the foreign command is forgotten …
    expect(s.tracker.contended(S, "mine")).toBe(true); // … but it overlapped the wait
  });

  it("a live foreign command from before the send contends; an expired one does not; quiet commands never do", () => {
    const s = setup();
    s.foreign("old");
    s.clock.now = LINGER;
    s.tracker.begin(S, "a", false);
    expect(s.tracker.contended(S, "a")).toBe(false);
    s.tracker.begin(S, "list", true);
    expect(s.tracker.contended(S, "a")).toBe(false);
    s.foreign("new");
    s.tracker.begin(S, "b", false);
    expect(s.tracker.contended(S, "b")).toBe(true);
    expect(s.tracker.contended(S, "unknown")).toBe(true);
  });

  it("two own commands contend with each other; an unanswered own command lingers; an answered one is dropped", () => {
    const s = setup();
    s.tracker.begin(S, "a", false);
    s.tracker.begin(S, "b", false);
    s.tracker.end(S, "b", true);
    expect(s.tracker.contended(S, "a")).toBe(true); // b was in flight during a's wait
    s.tracker.end(S, "a", false); // timed out: may still answer
    s.tracker.begin(S, "c", false);
    expect(s.tracker.contended(S, "c")).toBe(true);
    s.tracker.end(S, "c", true);
    s.clock.now = LINGER;
    s.tracker.begin(S, "d", false);
    expect(s.tracker.contended(S, "d")).toBe(false);
  });

  it("save-all is held until the save finished (then lingers), at most SAVE_HOLD_MAX_MS", () => {
    const s = setup();
    s.foreign("backup", "save-all flush");
    s.clock.now = 10 * LINGER; // long save: still possibly answering
    s.tracker.begin(S, "a", false);
    expect(s.tracker.contended(S, "a")).toBe(true);
    s.tracker.end(S, "a", true);
    s.output("[12:00:00 INFO]: Saving the game (this may take a moment!)");
    s.tracker.begin(S, "b", false);
    expect(s.tracker.contended(S, "b")).toBe(true);
    s.tracker.end(S, "b", true);
    s.output("[12:00:00 INFO]: System chat: Saved the game");
    s.clock.now += LINGER - 1; // queued output may still follow the save
    s.tracker.begin(S, "c", false);
    expect(s.tracker.contended(S, "c")).toBe(true);
    s.tracker.end(S, "c", true);
    s.clock.now += 1;
    s.tracker.begin(S, "d", false);
    expect(s.tracker.contended(S, "d")).toBe(false);
    s.tracker.end(S, "d", true);
    // No confirmation at all: released after SAVE_HOLD_MAX_MS.
    s.foreign("stuck", "save-all");
    s.clock.now += SAVE_HOLD_MAX_MS - 1;
    s.tracker.begin(S, "e", false);
    expect(s.tracker.contended(S, "e")).toBe(true);
    s.tracker.end(S, "e", true);
    s.clock.now += 1;
    s.tracker.begin(S, "f", false);
    expect(s.tracker.contended(S, "f")).toBe(false);
  });

  it("prunes on insert and bounds the per-server map", () => {
    const s = setup();
    for (let i = 0; i < 1_200; i++) s.foreign(`f${i}`);
    expect(s.entries()).toBe(1_000);
    s.clock.now = LINGER;
    s.foreign("late");
    expect(s.entries()).toBe(1);
  });
});
