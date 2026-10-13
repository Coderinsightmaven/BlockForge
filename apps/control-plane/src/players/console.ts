import { randomUUID } from "node:crypto";
import { PLAYER_COMMAND_ANY_TARGET, isSaveConfirmation, isSaveFailure, isSaveProgress, parsePlayerCommand } from "@blockforge/minecraft";
import type { ConsoleBuffers, ConsoleLine } from "../agents/console-buffer.js";
import { AgentCommandError, type AgentGateway } from "../agents/gateway.js";

/**
 * How long a console command may still be answering: commands from other senders (console route,
 * schedules, backups) from when they are sent, our own from when they timed out. A busy server
 * thread (world save, lag spike) queues commands, so their output can come long after the send;
 * 60 s covers ordinary stalls. `save-all` is held longer (see `SAVE_HOLD_MAX_MS`).
 */
export const DEFAULT_COMMAND_LINGER_MS = 60_000;
/**
 * A `save-all` (backups, schedules, console) blocks the server thread until the world is written;
 * commands queued behind it answer afterwards. It counts as possibly answering until the server
 * reports that save finished plus the linger time, and at most this long when no such line comes.
 * As in `createSaveTracker`, a confirmation ("Saved the game"/"Saved the world") counts only after a
 * progress line ("Saving the game …") seen after that `save-all` was sent; progress lines and
 * confirmations are matched to pending saves oldest first, one each. A save failure ends the oldest
 * pending save at any time. Recognised forms: `save-all`, `minecraft:save-all`, with or without a
 * leading `/`. Same limit as `createSaveTracker`: on ≤ 1.12 an autosave logs the same "Saving..." /
 * "Saved the world" lines, so an autosave that runs while a `save-all` is pending can release it early.
 */
export const SAVE_HOLD_MAX_MS = 15 * 60_000;
/**
 * Upper bound of tracked commands per server: beyond it the oldest expired-or-ordinary entries without a
 * player-command key are dropped. Held entries (waiting own commands, pending `save-all`s) and entries
 * of recognised player commands are never dropped while they count (the map may then exceed the bound
 * until they expire).
 */
const MAX_ENTRIES_PER_SERVER = 1_000;

interface Entry {
  /** Output of this command can never be player-command feedback (`list uuids`). */
  quiet: boolean;
  /** One of our `sendAndAwait` commands (false: another sender's). */
  own: boolean;
  /** null while still held (our command awaiting feedback, or a `save-all` before the save finished). */
  until: number | null;
  /** `save-all` held until the save finished; never beyond this time. */
  saveDeadline?: number;
  /** The pending `save-all` has seen its progress line. */
  saveProgress?: boolean;
  /** Own commands: another non-quiet command was possibly answering at some point while this one waited. */
  contended: boolean;
  /** Action and target of a recognised player command (`parsePlayerCommand`; target may be `*`), else null. */
  key: { action: string; target: string } | null;
  /**
   * Own commands: another command with the same `key` was possibly answering at some point while this
   * one waited, so even a feedback line naming our target may be the other command's.
   */
  ambiguous: boolean;
}

const keyOf = (line: string): Entry["key"] => parsePlayerCommand(line);

/** Two commands could print the same feedback line: same action, and the same target or a wildcard. */
const sameFeedback = (a: Entry["key"], b: Entry["key"]): boolean =>
  a !== null && b !== null && a.action === b.action && (a.target === b.target || a.target === PLAYER_COMMAND_ANY_TARGET || b.target === PLAYER_COMMAND_ANY_TARGET);

/**
 * Commands that may currently be answering on each server console. Every `workload.console` send
 * is reported by the gateway (`consoleCommand`). Commands sent through `sendAndAwait` are tracked
 * until their feedback is decided (then dropped) or they time out (then kept for `lingerMs`: the
 * answer may still come); other senders' commands are kept for `lingerMs` after the send, `save-all`
 * until the save finished. An own command is *contended* when any other non-quiet command was
 * possibly answering at any time between its send and its decision: a feedback line that names no
 * target (26.3 "Nothing changed. …", "No player was found", whitelist toggles) is then nobody's.
 */
export class ConsoleCommandTracker {
  private readonly servers = new Map<string, Map<string, Entry>>();
  /** Our own sends: registered before `gateway.send`, so the gateway event is not taken for a foreign command. */
  private readonly own = new Set<string>();

  constructor(
    gateway: AgentGateway,
    private readonly now: () => number,
    private readonly lingerMs = DEFAULT_COMMAND_LINGER_MS,
    /** Reports a subscriber that threw (the remaining subscribers still get the lines). */
    private readonly onSubscriberError: (err: unknown) => void = () => undefined,
  ) {
    gateway.on("consoleCommand", (serverId, commandId, line) => {
      if (this.own.has(commandId)) return;
      const t = this.now();
      const save = /^\/?(?:minecraft:)?save-all(?:\s|$)/i.test(line.trim());
      const base = { quiet: false, own: false, contended: false, key: keyOf(line), ambiguous: false };
      this.insert(serverId, commandId, save ? { ...base, until: null, saveDeadline: t + SAVE_HOLD_MAX_MS, saveProgress: false } : { ...base, until: t + this.lingerMs });
    });
    gateway.on("consoleLines", (serverId, lines) => {
      this.trackSaves(serverId, lines);
      // One gateway listener for every waiter (no listener per overlapping wait).
      // A throwing waiter must not keep the others (or later gateway listeners) from the batch.
      for (const fn of [...(this.listeners.get(serverId) ?? [])]) {
        try {
          fn(lines);
        } catch (err) {
          this.onSubscriberError(err);
        }
      }
    });
  }

  private readonly listeners = new Map<string, Set<(lines: ConsoleLine[]) => void>>();

  /** Calls `fn` with every batch of console lines of `serverId` until the returned function is called. */
  subscribe(serverId: string, fn: (lines: ConsoleLine[]) => void): () => void {
    let set = this.listeners.get(serverId);
    if (!set) {
      set = new Set();
      this.listeners.set(serverId, set);
    }
    set.add(fn);
    return () => {
      const cur = this.listeners.get(serverId);
      cur?.delete(fn);
      if (cur?.size === 0) this.listeners.delete(serverId);
    };
  }

  private trackSaves(serverId: string, lines: readonly ConsoleLine[]): void {
    const m = this.servers.get(serverId);
    if (!m) return;
    const pending = () => [...m.values()].filter((e) => e.saveDeadline !== undefined);
    const release = (e: Entry | undefined) => {
      if (!e) return;
      delete e.saveDeadline;
      delete e.saveProgress;
      e.until = this.now() + this.lingerMs;
    };
    for (const l of lines) {
      if (l.stream === "system") continue;
      if (isSaveFailure(l.line)) release(pending()[0]);
      else if (isSaveProgress(l.line)) {
        const e = pending().find((x) => !x.saveProgress);
        if (e) e.saveProgress = true;
      } else if (isSaveConfirmation(l.line)) release(pending().find((x) => x.saveProgress));
    }
  }

  private expired(e: Entry, t: number): boolean {
    if (e.saveDeadline !== undefined) return e.saveDeadline <= t;
    return e.until !== null && e.until <= t;
  }

  private prune(serverId: string): Map<string, Entry> | undefined {
    const m = this.servers.get(serverId);
    if (!m) return undefined;
    const t = this.now();
    for (const [id, e] of m) if (this.expired(e, t)) m.delete(id);
    if (m.size === 0) {
      this.servers.delete(serverId);
      return undefined;
    }
    return m;
  }

  private insert(serverId: string, commandId: string, entry: Entry): void {
    let m = this.prune(serverId);
    if (!m) {
      m = new Map();
      this.servers.set(serverId, m);
    }
    if (!entry.quiet) {
      // Everyone already waiting now shares the console with this command; it shares it with anything live.
      for (const e of m.values()) {
        if (e.own && e.until === null) e.contended = true;
        if (!e.quiet) entry.contended = true;
        // The same player command (same action; same target or a wildcard) prints the very same feedback line.
        if (sameFeedback(entry.key, e.key)) {
          if (e.own && e.until === null) e.ambiguous = true;
          entry.ambiguous = true;
        }
      }
    }
    m.set(commandId, entry);
    if (m.size > MAX_ENTRIES_PER_SERVER) {
      // Drop the oldest expirable entries (Map keeps insertion order); waiting own commands and
      // pending save-alls are never dropped.
      for (const [id, e] of m) {
        if (m.size <= MAX_ENTRIES_PER_SERVER) break;
        if (e.until !== null && e.saveDeadline === undefined && e.key === null) m.delete(id);
      }
    }
  }

  /** Registers one of our commands before it is sent. */
  begin(serverId: string, commandId: string, quiet: boolean, line: string): void {
    this.own.add(commandId);
    this.insert(serverId, commandId, { quiet, own: true, until: null, contended: false, key: quiet ? null : keyOf(line), ambiguous: false });
  }

  /**
   * True when another command with the same action and target (own — including an earlier one still
   * lingering after its timeout — or another sender's) was possibly answering at some time since
   * `commandId` was registered: a feedback line naming the target cannot be attributed. Unknown → true.
   */
  ambiguous(serverId: string, commandId: string): boolean {
    return this.servers.get(serverId)?.get(commandId)?.ambiguous ?? true;
  }

  /** Our command finished: `answered` (or never delivered) drops it; otherwise it may still answer for `lingerMs`. */
  /** Drops a command that provably never reached the server (also after its waiter settled). */
  forget(serverId: string, commandId: string): void {
    this.own.delete(commandId);
    this.servers.get(serverId)?.delete(commandId);
    this.prune(serverId);
  }

  end(serverId: string, commandId: string, answered: boolean): void {
    this.own.delete(commandId);
    const m = this.servers.get(serverId);
    const e = m?.get(commandId);
    if (!m || !e) return;
    if (answered) m.delete(commandId);
    else e.until = this.now() + this.lingerMs;
    this.prune(serverId);
  }

  /**
   * True when another non-quiet command was possibly answering on `serverId` at some time since
   * `commandId` was registered (or still is). Unknown commands count as contended.
   */
  contended(serverId: string, commandId: string): boolean {
    const m = this.prune(serverId);
    const e = m?.get(commandId);
    if (!m || !e) return true;
    if (e.contended) return true;
    for (const [id, o] of m) if (id !== commandId && !o.quiet) return true;
    return false;
  }
}

/**
 * Agent error codes that `workload.console` returns only before anything is written to the server's
 * stdin (services/node-agent: executor.run before the handler — BUSY queue full, UNSUPPORTED_COMMAND,
 * COMMAND_REJECTED signature/expiry/pending approval, VALIDATION_FAILED payload; Driver.Console before
 * writeConsole — VALIDATION_FAILED "single line", NOT_FOUND, CONFLICT "workload is not running").
 * RUNTIME_ERROR is not here: attach and stdin write share it, and a failed write may be partial.
 */
const NEVER_WRITTEN = new Set(["BUSY", "UNSUPPORTED_COMMAND", "COMMAND_REJECTED", "VALIDATION_FAILED", "NOT_FOUND", "CONFLICT"]);

/**
 * Allowlist: a failed `workload.console` send is forgotten at once only when the line provably never
 * reached the server — refused by the control plane before the frame went out (`stage: "not_sent"`),
 * or an agent error from `NEVER_WRITTEN`. COMMAND_REJECTED "duplicate command id (seen before an agent
 * restart)" is excluded: that command may have run before the restart. Everything else (RUNTIME_ERROR,
 * INTERNAL "agent is shutting down", TIMEOUT, disconnects, results violating the contract, other
 * exceptions) may have typed the line, so the command lingers.
 */
function mayHaveRun(err: unknown): boolean {
  if (!(err instanceof AgentCommandError)) return true;
  if (err.stage === "not_sent") return false;
  if (err.stage !== "agent_error" || !NEVER_WRITTEN.has(err.code)) return true;
  return err.code === "COMMAND_REJECTED" && err.message.startsWith("duplicate command id");
}

export interface AwaitOptions<T> {
  userId?: string | null;
  /** The command's output can never be player-command feedback (does not contend with others). */
  quiet?: boolean;
  /**
   * Called once when the wait ends without a decision by `decide`: the lines seen and whether another
   * command was possibly answering at any time during the wait. Its value (or null) is the result.
   */
  atDeadline?: (lines: readonly string[], contended: boolean) => T | null;
}

/**
 * Types `line` into a running server's console and collects the server's output that follows (by
 * console sequence number, never by timestamp: agent and control-plane clocks differ). `decide`
 * sees every non-system line since the command, in order, each time output arrives, plus whether a
 * command with the same action and target overlapped this one (`ConsoleCommandTracker.ambiguous`),
 * and ends the wait with a non-null value. Otherwise the wait lasts `timeoutMs` and `opts.atDeadline` decides
 * (null when absent). When the send fails it throws, except that an answer already decided is returned
 * if the error leaves open whether the line reached the server (`mayHaveRun`: timeouts, disconnects,
 * RUNTIME_ERROR, …); errors proving it was never written always throw.
 */
export async function sendAndAwait<T>(
  d: { gateway: AgentGateway; consoles: ConsoleBuffers; commands: ConsoleCommandTracker },
  nodeId: string,
  serverId: string,
  line: string,
  decide: (lines: readonly string[], ambiguous: boolean) => T | null,
  timeoutMs: number,
  opts: AwaitOptions<T> = {},
): Promise<T | null> {
  const commandId = randomUUID();
  // Registered before the cursor is taken: a concurrent command sees this one for every line it could share.
  d.commands.begin(serverId, commandId, opts.quiet ?? false, line);
  const after = d.consoles.tail(serverId, 1).lines.at(-1)?.seq ?? 0;
  const seen: string[] = [];
  let cursor = after;
  let resolveFn: (v: T | null) => void = () => undefined;
  const result = new Promise<T | null>((resolve) => (resolveFn = resolve));
  let settled = false;
  let decided: T | null = null;
  const finish = (v: T | null, delivered = true) => {
    if (settled) return;
    settled = true;
    decided = v;
    clearTimeout(timer);
    unsubscribe();
    d.commands.end(serverId, commandId, v !== null || !delivered);
    resolveFn(v);
  };
  const consume = (lines: readonly ConsoleLine[]) => {
    let grew = false;
    for (const l of lines) {
      if (l.seq <= cursor) continue;
      cursor = l.seq;
      if (l.stream === "system") continue;
      seen.push(l.line);
      grew = true;
    }
    if (!grew || settled) return;
    const v = decide(seen, d.commands.ambiguous(serverId, commandId));
    if (v !== null) finish(v);
  };
  const unsubscribe = d.commands.subscribe(serverId, (lines) => consume(lines));
  const timer = setTimeout(() => {
    if (settled) return;
    // Lines already in the buffer but not yet delivered to the listener are part of the window.
    consume(d.consoles.tail(serverId, 2000).lines);
    if (settled) return;
    finish(opts.atDeadline ? opts.atDeadline(seen, d.commands.contended(serverId, commandId)) : null);
  }, timeoutMs);
  timer.unref();
  try {
    await d.gateway.send(nodeId, "workload.console", { workloadId: serverId, line }, { timeoutMs: 15_000, commandId, ...(opts.userId ? { userId: opts.userId } : {}) });
  } catch (err) {
    const ran = mayHaveRun(err);
    // The server's answer arrived before an error result that leaves open whether the line was written
    // (e.g. the node dropped after the write): it was decided on its own merits, so it is the result.
    // Not when the error proves the line was never written (then the "answer" was someone else's), and
    // not for errors that are not AgentCommandErrors (thrown by the gateway before dispatch, e.g. the
    // command-row insert; they still linger for ambiguity, the conservative side).
    if (decided !== null && err instanceof AgentCommandError && ran) return decided;
    // Provably unwritten: forget the command even if the feedback window already ended.
    if (!ran) d.commands.forget(serverId, commandId);
    else if (decided !== null) {
      // The entry was dropped as answered, but the answer is not ours to keep: the line may still be typed.
      d.commands.begin(serverId, commandId, opts.quiet ?? false, line);
      d.commands.end(serverId, commandId, false);
    }
    finish(null, ran);
    throw err;
  }
  consume(d.consoles.tail(serverId, 2000).lines);
  return result;
}
