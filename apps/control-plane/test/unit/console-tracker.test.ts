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
    s.tracker.begin(S, "mine", false, "list");
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
    s.tracker.begin(S, "a", false, "list");
    expect(s.tracker.contended(S, "a")).toBe(false);
    s.tracker.begin(S, "list", true, "list");
    expect(s.tracker.contended(S, "a")).toBe(false);
    s.foreign("new");
    s.tracker.begin(S, "b", false, "list");
    expect(s.tracker.contended(S, "b")).toBe(true);
    expect(s.tracker.contended(S, "unknown")).toBe(true);
  });

  it("two own commands contend with each other; an unanswered own command lingers; an answered one is dropped", () => {
    const s = setup();
    s.tracker.begin(S, "a", false, "list");
    s.tracker.begin(S, "b", false, "list");
    s.tracker.end(S, "b", true);
    expect(s.tracker.contended(S, "a")).toBe(true); // b was in flight during a's wait
    s.tracker.end(S, "a", false); // timed out: may still answer
    s.tracker.begin(S, "c", false, "list");
    expect(s.tracker.contended(S, "c")).toBe(true);
    s.tracker.end(S, "c", true);
    s.clock.now = LINGER;
    s.tracker.begin(S, "d", false, "list");
    expect(s.tracker.contended(S, "d")).toBe(false);
  });

  it("save-all is held until the save finished (then lingers), at most SAVE_HOLD_MAX_MS", () => {
    const s = setup();
    s.foreign("backup", "save-all flush");
    s.clock.now = 10 * LINGER; // long save: still possibly answering
    s.tracker.begin(S, "a", false, "list");
    expect(s.tracker.contended(S, "a")).toBe(true);
    s.tracker.end(S, "a", true);
    s.output("[12:00:00 INFO]: Saving the game (this may take a moment!)");
    s.tracker.begin(S, "b", false, "list");
    expect(s.tracker.contended(S, "b")).toBe(true);
    s.tracker.end(S, "b", true);
    s.output("[12:00:00 INFO]: System chat: Saved the game");
    s.clock.now += LINGER - 1; // queued output may still follow the save
    s.tracker.begin(S, "c", false, "list");
    expect(s.tracker.contended(S, "c")).toBe(true);
    s.tracker.end(S, "c", true);
    s.clock.now += 1;
    s.tracker.begin(S, "d", false, "list");
    expect(s.tracker.contended(S, "d")).toBe(false);
    s.tracker.end(S, "d", true);
    // No confirmation at all: released after SAVE_HOLD_MAX_MS.
    s.foreign("stuck", "save-all");
    s.clock.now += SAVE_HOLD_MAX_MS - 1;
    s.tracker.begin(S, "e", false, "list");
    expect(s.tracker.contended(S, "e")).toBe(true);
    s.tracker.end(S, "e", true);
    s.clock.now += 1;
    s.tracker.begin(S, "f", false, "list");
    expect(s.tracker.contended(S, "f")).toBe(false);
  });

  it("round 3: a stray confirmation before the save's progress line does not end it; one confirmation ends one save", () => {
    const s = setup();
    const contended = (id: string) => {
      s.tracker.begin(S, id, false, "list");
      const c = s.tracker.contended(S, id);
      s.tracker.end(S, id, true);
      return c;
    };
    s.foreign("save1", "save-all flush");
    s.output("[12:00:00 INFO]: Saved the game"); // stray (an earlier save / autosave): no progress line yet
    s.clock.now += LINGER;
    expect(contended("a")).toBe(true);
    s.foreign("save2", "save-all");
    s.output("[12:00:00 INFO]: Saving the game (this may take a moment!)"); // save1's progress
    s.output("[12:00:00 INFO]: Saving the game (this may take a moment!)"); // save2's progress
    s.output("[12:00:00 INFO]: Saved the game"); // ends save1 only
    s.clock.now += LINGER;
    expect(contended("b")).toBe(true); // save2 still pending
    s.output("[12:00:00 INFO]: Saved the game");
    s.clock.now += LINGER;
    expect(contended("c")).toBe(false);
  });

  it("round 3: the entry cap never evicts a pending save-all or a waiting own command", () => {
    const s = setup();
    s.foreign("backup", "save-all flush");
    s.tracker.begin(S, "mine", false, "op Steve");
    for (let i = 0; i < 1_200; i++) s.foreign(`f${i}`);
    const m = (s.tracker as unknown as { servers: Map<string, Map<string, unknown>> }).servers.get(S)!;
    expect(m.size).toBe(1_000);
    expect(m.has("backup")).toBe(true);
    expect(m.has("mine")).toBe(true);
  });

  it("round 3: same action and target overlapping → ambiguous (any order, own or foreign, linger included)", () => {
    const s = setup();
    s.tracker.begin(S, "a", false, "op Steve");
    s.tracker.begin(S, "b", false, "op Alex");
    s.tracker.begin(S, "c", false, "deop Steve");
    expect([s.tracker.ambiguous(S, "a"), s.tracker.ambiguous(S, "b"), s.tracker.ambiguous(S, "c")]).toEqual([false, false, false]);
    s.foreign("console", "/OP steve");
    expect(s.tracker.ambiguous(S, "a")).toBe(true);
    expect(s.tracker.ambiguous(S, "b")).toBe(false);
    s.tracker.end(S, "b", false); // timed out: lingers
    s.tracker.begin(S, "retry", false, "op Alex");
    expect(s.tracker.ambiguous(S, "retry")).toBe(true);
    s.tracker.begin(S, "say", false, "say op Alex");
    expect(s.tracker.ambiguous(S, "say")).toBe(false);
    expect(s.tracker.ambiguous(S, "unknown")).toBe(true);
    s.clock.now = LINGER;
    s.tracker.end(S, "retry", true);
    s.tracker.begin(S, "later", false, "op Alex");
    expect(s.tracker.ambiguous(S, "later")).toBe(false);
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
