import type { ConsoleBuffers, ConsoleLine } from "../agents/console-buffer.js";
import type { AgentGateway } from "../agents/gateway.js";

/**
 * Types `line` into a running server's console and collects the server's output that follows (by
 * console sequence number, never by timestamp: agent and control-plane clocks differ) until `match`
 * returns a value or `timeoutMs` passes. `match` sees every non-system line since the command, in
 * order. Throws only when the command could not be delivered.
 */
export async function sendAndAwait<T>(
  d: { gateway: AgentGateway; consoles: ConsoleBuffers },
  nodeId: string,
  serverId: string,
  line: string,
  match: (lines: readonly string[]) => T | null,
  timeoutMs: number,
  opts: { userId?: string | null } = {},
): Promise<T | null> {
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
    const v = match(seen);
    if (v !== null) finish(v);
  };
  const onLines = (id: string, lines: ConsoleLine[]) => {
    if (id === serverId) consume(lines);
  };
  d.gateway.on("consoleLines", onLines);
  const timer = setTimeout(() => finish(null), timeoutMs);
  timer.unref();
  try {
    await d.gateway.send(nodeId, "workload.console", { workloadId: serverId, line }, { timeoutMs: 15_000, ...(opts.userId ? { userId: opts.userId } : {}) });
  } catch (err) {
    finish(null);
    throw err;
  }
  consume(d.consoles.tail(serverId, 2000).lines);
  return result;
}
