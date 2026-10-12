import type { ConsoleLinesEvent, LogLine } from "@blockforge/contracts";
import { RingBuffer } from "../lib/ring-buffer.js";

export const CONSOLE_BUFFER_LINES = 5000;

export type ConsoleLine = ConsoleLinesEvent["lines"][number];

interface ServerConsole {
  buffer: RingBuffer<ConsoleLine>;
  nextSeq: number;
  dropped: number;
  lastAppendAt: number;
}

/**
 * Per-server ring buffer of the most recent 5000 console lines. `seq` is monotonic per server
 * (for the life of the process) so clients can detect gaps after reconnecting.
 */
export class ConsoleBuffers {
  private readonly consoles = new Map<string, ServerConsole>();

  constructor(private readonly capacity = CONSOLE_BUFFER_LINES) {}

  private get(serverId: string): ServerConsole {
    let c = this.consoles.get(serverId);
    if (!c) {
      c = { buffer: new RingBuffer(this.capacity), nextSeq: 1, dropped: 0, lastAppendAt: Date.now() };
      this.consoles.set(serverId, c);
    }
    return c;
  }

  append(serverId: string, lines: readonly LogLine[], dropped = 0): ConsoleLine[] {
    const c = this.get(serverId);
    c.lastAppendAt = Date.now();
    c.dropped += dropped;
    const out: ConsoleLine[] = [];
    for (const l of lines) {
      const line: ConsoleLine = { seq: c.nextSeq++, ts: l.ts, stream: l.stream, line: l.line };
      c.buffer.push(line);
      out.push(line);
    }
    return out;
  }

  /** Appends a control-plane generated line (e.g. "[BlockForge] server stopped"). */
  appendSystem(serverId: string, ts: number, line: string): ConsoleLine {
    const c = this.get(serverId);
    c.lastAppendAt = Date.now();
    const entry: ConsoleLine = { seq: c.nextSeq++, ts, stream: "system", line };
    c.buffer.push(entry);
    return entry;
  }

  tail(serverId: string, n: number): ConsoleLinesEvent {
    const c = this.consoles.get(serverId);
    return { serverId, lines: c ? c.buffer.tail(Math.max(0, n)) : [], ...(c && c.dropped ? { dropped: c.dropped } : {}) };
  }

  remove(serverId: string): void {
    this.consoles.delete(serverId);
  }

  /** Frees buffers of servers that produced no output for `idleMs` (or no longer exist). */
  prune(idleMs: number, exists: (serverId: string) => boolean = () => true): number {
    const cutoff = Date.now() - idleMs;
    let removed = 0;
    for (const [id, c] of this.consoles) {
      if (c.lastAppendAt < cutoff || !exists(id)) {
        this.consoles.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.consoles.size;
  }
}
