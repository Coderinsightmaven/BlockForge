import type { ConsoleLinesEvent } from "@blockforge/contracts";

export type ConsoleStream = "stdout" | "stderr" | "system";

export interface ConsoleLine {
  /** Monotonic per server for agent lines; negative for client-side notices. */
  seq: number;
  ts: number;
  stream: ConsoleStream;
  line: string;
  /** Inserted by the client (gap/drop/reconnect notices), not from the server. */
  local?: boolean;
}

/** Lines kept in memory per open console. */
export const CONSOLE_MAX_LINES = 5000;

/**
 * Ordered, de-duplicated console buffer fed by `GET console/history` and `console.lines` events.
 *
 * - Lines are keyed by `seq`; history and live events can overlap or arrive out of order.
 * - A jump in `seq` (missed lines while disconnected) inserts a notice and asks for a history
 *   refetch via `onGap`; `dropped` (server rate limiting) inserts a notice too.
 * - Subscribers are notified at most once per animation frame, so a burst of 500 lines causes
 *   one render, not 500.
 */
export class ConsoleStore {
  private lines: ConsoleLine[] = [];
  private lastSeq: number | null = null;
  private localSeq = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private frame: number | null = null;
  private readonly schedule: (cb: () => void) => number;
  private readonly cancel: (id: number) => void;

  constructor(
    private readonly opts: {
      max?: number;
      onGap?: () => void;
      /** Injectable for tests (defaults to requestAnimationFrame). */
      schedule?: (cb: () => void) => number;
      cancel?: (id: number) => void;
    } = {},
  ) {
    this.schedule = opts.schedule ?? ((cb) => requestAnimationFrame(cb));
    this.cancel = opts.cancel ?? ((id) => cancelAnimationFrame(id));
  }

  get max(): number {
    return this.opts.max ?? CONSOLE_MAX_LINES;
  }

  getSnapshot = (): number => this.version;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  all(): readonly ConsoleLine[] {
    return this.lines;
  }

  /** Merge a history response (authoritative for the seqs it covers). */
  loadHistory(event: ConsoleLinesEvent): void {
    // Real lines are keyed by their integer seq; client notices (fractional seq) by a separate key.
    const bySeq = new Map<string, ConsoleLine>();
    for (const l of this.lines) bySeq.set(l.local ? `n${l.seq}` : `s${l.seq}`, l);
    for (const l of event.lines) bySeq.set(`s${l.seq}`, { ...l });
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    this.lines = merged.slice(-this.max);
    const real = this.lines.filter((l) => !l.local);
    this.lastSeq = real.length ? real[real.length - 1]!.seq : this.lastSeq;
    if (event.dropped)
      this.notice(`${event.dropped} line(s) were dropped by the server (output rate limit).`);
    this.changed();
  }

  /** Append a live `console.lines` event. */
  push(event: ConsoleLinesEvent): void {
    const fresh = event.lines
      .filter((l) => this.lastSeq === null || l.seq > this.lastSeq)
      .sort((a, b) => a.seq - b.seq);
    if (fresh.length === 0 && !event.dropped) return;
    const first = fresh[0];
    if (first && this.lastSeq !== null && first.seq > this.lastSeq + 1) {
      const missed = first.seq - this.lastSeq - 1;
      this.notice(`${missed} line(s) missed while disconnected — reloading history.`);
      this.opts.onGap?.();
    }
    for (const l of fresh) this.lines.push({ ...l });
    if (fresh.length) this.lastSeq = fresh[fresh.length - 1]!.seq;
    if (event.dropped)
      this.notice(`${event.dropped} line(s) were dropped by the server (output rate limit).`);
    this.trim();
    this.changed();
  }

  /** Client-side notice rendered as a system line. */
  notice(text: string, ts = Date.now()): void {
    this.localSeq += 1;
    // Sort right after the last real line seen.
    this.lines.push({
      seq: (this.lastSeq ?? 0) + this.localSeq / 1e6,
      ts,
      stream: "system",
      line: text,
      local: true,
    });
    this.trim();
    this.changed();
  }

  clear(): void {
    this.lines = [];
    this.changed();
  }

  dispose(): void {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    this.listeners.clear();
  }

  private trim(): void {
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  private changed(): void {
    if (this.frame !== null) return;
    this.frame = this.schedule(() => {
      this.frame = null;
      this.lines = this.lines.slice(); // new array identity per published version
      this.version++;
      for (const l of [...this.listeners]) l();
    });
  }
}
