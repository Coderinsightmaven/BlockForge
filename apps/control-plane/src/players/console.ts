import { randomUUID } from "node:crypto";
import type { ConsoleBuffers, ConsoleLine } from "../agents/console-buffer.js";
import type { AgentGateway } from "../agents/gateway.js";

/** How long a console command may still be answering after it was sent (unknown senders) or timed out (ours). */
export const DEFAULT_COMMAND_LINGER_MS = 10_000;

interface Entry {
  /** Output of this command can never be a target-less player-command failure (`list uuids`). */
  quiet: boolean;
  /** null while the sender is still waiting for its feedback; afterwards it may answer late until then. */
  until: number | null;
}

/**
 * Commands that may currently be answering on each server console. Every `workload.console` send
 * is reported by the gateway (`consoleCommand`): commands sent through `sendAndAwait` are tracked
 * until their feedback is recognised (then dropped) or they time out (then kept for `lingerMs`, the
 * answer may still come); commands from other senders (console route, schedules, backups) are kept
 * for `lingerMs` because nobody knows when they are answered. A target-less feedback line
 * ("No player was found", "Nothing changed. …") is attributable to a command only when no other
 * non-quiet command is tracked for that server.
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
    gateway.on("consoleCommand", (serverId, commandId) => {
      if (this.own.has(commandId)) return;
      this.entries(serverId).set(commandId, { quiet: false, until: this.now() + this.lingerMs });
    });
  }

  private entries(serverId: string): Map<string, Entry> {
    let m = this.servers.get(serverId);
    if (!m) {
      m = new Map();
      this.servers.set(serverId, m);
    }
    return m;
  }

  private prune(serverId: string): Map<string, Entry> | undefined {
    const m = this.servers.get(serverId);
    if (!m) return undefined;
    const t = this.now();
    for (const [id, e] of m) if (e.until !== null && e.until <= t) m.delete(id);
    if (m.size === 0) this.servers.delete(serverId);
    return m.size === 0 ? undefined : m;
  }

  /** Registers one of our commands before it is sent. */
  begin(serverId: string, commandId: string, quiet: boolean): void {
    this.own.add(commandId);
    this.entries(serverId).set(commandId, { quiet, until: null });
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

  /** True when no command other than `commandId` (quiet ones aside) may be answering on `serverId`. */
  exclusive(serverId: string, commandId: string): boolean {
    const m = this.prune(serverId);
    if (!m) return true;
    for (const [id, e] of m) if (id !== commandId && !e.quiet) return false;
    return true;
  }
}

/**
 * Types `line` into a running server's console and collects the server's output that follows (by
 * console sequence number, never by timestamp: agent and control-plane clocks differ) until `match`
 * returns a value or `timeoutMs` passes. `match` sees every non-system line since the command, in
 * order, and for each line whether this command was the only one that could be answering when the
 * line arrived (`exclusive[i]`, see `ConsoleCommandTracker`). Throws only when the command could not
 * be delivered.
 */
export async function sendAndAwait<T>(
  d: { gateway: AgentGateway; consoles: ConsoleBuffers; commands: ConsoleCommandTracker },
  nodeId: string,
  serverId: string,
  line: string,
  match: (lines: readonly string[], exclusive: readonly boolean[]) => T | null,
  timeoutMs: number,
  opts: { userId?: string | null; quiet?: boolean } = {},
): Promise<T | null> {
  const commandId = randomUUID();
  // Registered before the cursor is taken: a concurrent command sees this one for every line it could share.
  d.commands.begin(serverId, commandId, opts.quiet ?? false);
  const after = d.consoles.tail(serverId, 1).lines.at(-1)?.seq ?? 0;
  const seen: string[] = [];
  const exclusive: boolean[] = [];
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
      exclusive.push(d.commands.exclusive(serverId, commandId));
      grew = true;
    }
    if (!grew || settled) return;
    const v = match(seen, exclusive);
    if (v !== null) finish(v);
  };
  const onLines = (id: string, lines: ConsoleLine[]) => {
    if (id === serverId) consume(lines);
  };
  d.gateway.on("consoleLines", onLines);
  const timer = setTimeout(() => finish(null), timeoutMs);
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
