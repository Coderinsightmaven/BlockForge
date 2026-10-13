import { randomUUID } from "node:crypto";
import { isSaveConfirmation, isSaveFailure } from "@blockforge/minecraft";
import type { ConsoleBuffers, ConsoleLine } from "../agents/console-buffer.js";
import type { AgentGateway } from "../agents/gateway.js";

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
 * reports the save finished ("Saved the game"/"Saved the world", or a save failure) plus the linger
 * time, and at most this long when no such line comes.
 */
export const SAVE_HOLD_MAX_MS = 15 * 60_000;
/** Upper bound of tracked commands per server (beyond it the oldest settled ones are dropped). */
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
  /** Own commands: another non-quiet command was possibly answering at some point while this one waited. */
  contended: boolean;
}

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
  ) {
    gateway.on("consoleCommand", (serverId, commandId, line) => {
      if (this.own.has(commandId)) return;
      const t = this.now();
      const save = /^save-all(?:\s|$)/i.test(line.trim());
      this.insert(serverId, commandId, save ? { quiet: false, own: false, until: null, saveDeadline: t + SAVE_HOLD_MAX_MS, contended: false } : { quiet: false, own: false, until: t + this.lingerMs, contended: false });
    });
    gateway.on("consoleLines", (serverId, lines) => {
      const m = this.servers.get(serverId);
      if (!m || !lines.some((l) => l.stream !== "system" && (isSaveConfirmation(l.line) || isSaveFailure(l.line)))) return;
      const until = this.now() + this.lingerMs;
      for (const e of m.values()) {
        if (e.saveDeadline !== undefined) {
          delete e.saveDeadline;
          e.until = until;
        }
      }
    });
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
      }
    }
    m.set(commandId, entry);
    if (m.size > MAX_ENTRIES_PER_SERVER) {
      // Drop the oldest entries that nobody waits on (Map keeps insertion order); waiting own commands stay.
      for (const [id, e] of m) {
        if (m.size <= MAX_ENTRIES_PER_SERVER) break;
        if (!(e.own && e.until === null)) m.delete(id);
      }
    }
  }

  /** Registers one of our commands before it is sent. */
  begin(serverId: string, commandId: string, quiet: boolean): void {
    this.own.add(commandId);
    this.insert(serverId, commandId, { quiet, own: true, until: null, contended: false });
  }

  /** Our command finished: `answered` drops it; otherwise it may still answer for `lingerMs`. */
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
 * sees every non-system line since the command, in order, each time output arrives, and ends the
 * wait with a non-null value. Otherwise the wait lasts `timeoutMs` and `opts.atDeadline` decides
 * (null when absent). Throws only when the command could not be delivered.
 */
export async function sendAndAwait<T>(
  d: { gateway: AgentGateway; consoles: ConsoleBuffers; commands: ConsoleCommandTracker },
  nodeId: string,
  serverId: string,
  line: string,
  decide: (lines: readonly string[]) => T | null,
  timeoutMs: number,
  opts: AwaitOptions<T> = {},
): Promise<T | null> {
  const commandId = randomUUID();
  // Registered before the cursor is taken: a concurrent command sees this one for every line it could share.
  d.commands.begin(serverId, commandId, opts.quiet ?? false);
  const after = d.consoles.tail(serverId, 1).lines.at(-1)?.seq ?? 0;
  const seen: string[] = [];
  let cursor = after;
  let resolveFn: (v: T | null) => void = () => undefined;
  const result = new Promise<T | null>((resolve) => (resolveFn = resolve));
  let settled = false;
  const finish = (v: T | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    d.gateway.off("consoleLines", onLines);
    d.commands.end(serverId, commandId, v !== null);
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
    const v = decide(seen);
    if (v !== null) finish(v);
  };
  const onLines = (id: string, lines: ConsoleLine[]) => {
    if (id === serverId) consume(lines);
  };
  d.gateway.on("consoleLines", onLines);
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
    finish(null);
    throw err;
  }
  consume(d.consoles.tail(serverId, 2000).lines);
  return result;
}
