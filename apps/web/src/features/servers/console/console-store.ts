import type { ConsoleLinesEvent } from "@blockforge/contracts";

export type ConsoleStream = "stdout" | "stderr" | "system";

export interface ConsoleLine {
  /**
   * Monotonic per server for agent lines; fractional for client-side notices; ≤ 0 for lines kept
   * from before a control-plane sequence restart.
   */
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
 * A line with an already-seen seq but output newer than this margin past the newest line we hold
 * cannot be a duplicate: the control plane's sequence restarted (process restart, or its idle
 * buffer for this server was pruned). The margin absorbs small ts disorder between streams.
 */
export const SEQ_RESTART_TS_MARGIN_MS = 2_000;

type IncomingLine = ConsoleLinesEvent["lines"][number];

/**
 * Ordered, de-duplicated console buffer fed by `GET console/history` and `console.lines` events.
 *
 * - Lines are keyed by `seq`; history and live events can overlap or arrive out of order.
 * - A jump in `seq` (missed lines while disconnected, or inside one batch) inserts a notice and
 *   asks for a history refetch via `onGap`.
 * - `dropped` (server rate limiting) inserts a notice: in history it is the server's cumulative
 *   counter, so only the increase since the last announcement is reported; on live events it is
 *   that batch's increment.
 * - The control plane's seq can restart; held lines are then re-based below the new sequence
 *   (kept on screen, above a notice) instead of the new output being discarded as duplicates.
 * - Subscribers are notified at most once per animation frame, so a burst of 500 lines causes
 *   one render, not 500.
 */
export class ConsoleStore {
  private lines: ConsoleLine[] = [];
  private lastSeq: number | null = null;
  /** Lines with seq ≤ floor were cleared from the view by the user and stay hidden. */
  private floor: number | null = null;
  /** ts of the newest real line seen (survives clear()); used to recognise a seq restart. */
  private newestTs: number | null = null;
  /** Server-side dropped-line counter already announced (history reports it cumulatively). */
  private droppedAnnounced = 0;
  /** Real lines appended so far (monotonic; unaffected by the ring cap). */
  private appended = 0;
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

  /** Count of real lines appended since creation — use differences (e.g. "N new while paused"). */
  get appendedCount(): number {
    return this.appended;
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
    if (this.restarted(event.lines)) this.rebase();
    const visible = event.lines.filter((l) => this.floor === null || l.seq > this.floor);
    // Real lines are keyed by their integer seq; client notices (fractional seq) by a separate key.
    const bySeq = new Map<string, ConsoleLine>();
    for (const l of this.lines) bySeq.set(l.local ? `n${l.seq}` : `s${l.seq}`, l);
    for (const l of visible) {
      if (!bySeq.has(`s${l.seq}`)) this.appended++;
      bySeq.set(`s${l.seq}`, { ...l });
    }
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    this.lines = merged.slice(-this.max);
    let newest: IncomingLine | null = null;
    for (const l of visible) if (newest === null || l.seq > newest.seq) newest = l;
    if (newest && (this.lastSeq === null || newest.seq > this.lastSeq)) this.advance(newest);
    const dropped = event.dropped ?? 0;
    if (dropped > this.droppedAnnounced) {
      this.notice(
        `${dropped - this.droppedAnnounced} line(s) were dropped by the server (output rate limit).`,
      );
    }
    // A lower value than announced means the server's counter restarted with its buffer.
    this.droppedAnnounced = dropped;
    this.changed();
  }

  /** Append a live `console.lines` event (`dropped` there is the increment for this batch). */
  push(event: ConsoleLinesEvent): void {
    if (this.restarted(event.lines)) {
      this.rebase();
      this.opts.onGap?.(); // reload the new buffer: lines before this batch may be missing
    }
    const fresh = event.lines
      .filter(
        (l) => (this.lastSeq === null || l.seq > this.lastSeq) && (this.floor === null || l.seq > this.floor),
      )
      .sort((a, b) => a.seq - b.seq);
    if (fresh.length === 0 && !event.dropped) return;
    // Gaps before the batch and inside it (lines lost between frames).
    let missed = 0;
    let prev = this.lastSeq ?? this.floor;
    for (const l of fresh) {
      if (prev !== null && l.seq > prev + 1) missed += l.seq - prev - 1;
      prev = l.seq;
    }
    if (missed > 0) {
      this.notice(`${missed} line(s) missed — reloading history.`);
      this.opts.onGap?.();
    }
    for (const l of fresh) this.lines.push({ ...l });
    this.appended += fresh.length;
    if (fresh.length) this.advance(fresh[fresh.length - 1]!);
    if (event.dropped) {
      this.droppedAnnounced += event.dropped;
      this.notice(`${event.dropped} line(s) were dropped by the server (output rate limit).`);
    }
    this.trim();
    this.changed();
  }

  /** Client-side notice rendered as a system line. */
  notice(text: string, ts = Date.now()): void {
    this.localSeq += 1;
    // Sort right after the last real line seen.
    this.lines.push({
      seq: (this.lastSeq ?? this.floor ?? 0) + this.localSeq / 1e6,
      ts,
      stream: "system",
      line: text,
      local: true,
    });
    this.trim();
    this.changed();
  }

  /**
   * Clear the view. Everything up to the newest line stays hidden (a history reload must not bring
   * it back); gap detection continues from that floor.
   */
  clear(): void {
    if (this.lastSeq !== null) this.floor = Math.max(this.floor ?? -Infinity, this.lastSeq);
    this.lastSeq = null;
    this.lines = [];
    this.changed();
  }

  dispose(): void {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    this.listeners.clear();
  }

  private advance(line: IncomingLine): void {
    this.lastSeq = line.seq;
    this.newestTs = line.ts;
  }

  /** Binary search for the real line with this seq (lines are sorted by seq). */
  private findReal(seq: number): ConsoleLine | undefined {
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const l = this.lines[mid]!;
      if (l.seq < seq) lo = mid + 1;
      else if (l.seq > seq) hi = mid - 1;
      else return l.local ? undefined : l;
    }
    return undefined;
  }

  /**
   * Did the control plane's sequence restart? Either a seq we hold arrives with different content,
   * or a seq at/below the newest one seen carries output clearly newer than anything we have.
   * Only lines at/below the newest seq are inspected, so a normal live batch costs nothing extra.
   */
  private restarted(incoming: readonly IncomingLine[]): boolean {
    const reference = this.lastSeq ?? this.floor;
    if (reference === null) return false;
    for (const l of incoming) {
      if (l.seq > reference) continue;
      const held = this.findReal(l.seq);
      if (held) {
        if (held.ts !== l.ts || held.line !== l.line || held.stream !== l.stream) return true;
      } else if (this.newestTs !== null && l.ts > this.newestTs + SEQ_RESTART_TS_MARGIN_MS) {
        return true;
      }
    }
    return false;
  }

  /** Move held lines below the new sequence (seq ≤ 0) so they stay visible above the new output. */
  private rebase(): void {
    let top = Math.max(this.lastSeq ?? 0, this.floor ?? 0);
    for (const l of this.lines) top = Math.max(top, Math.ceil(l.seq));
    const shift = top + 1;
    this.lines = this.lines.map((l) => ({ ...l, seq: l.seq - shift }));
    this.lastSeq = null;
    this.floor = null;
    this.droppedAnnounced = 0;
    this.localSeq = 0;
    this.notice("The console sequence restarted on the control plane; earlier lines are kept above.");
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
