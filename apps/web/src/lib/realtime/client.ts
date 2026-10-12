import { ServerFrame, Topic } from "@blockforge/contracts";
import type { ClientFrame, RealtimeEventType } from "@blockforge/contracts";

/*
 * UI realtime channel (WSS /api/v1/realtime). Realtime is a convenience, not a source of
 * truth: after every reconnect the app re-reads durable state over REST (`onReconnect`).
 *
 * - Subscriptions are ref-counted per topic: N listeners → one `subscribe` frame; the
 *   `unsubscribe` frame is sent when the last listener leaves.
 * - Every (re)connect re-sends `subscribe` for all live topics.
 * - Reconnects use exponential backoff with jitter; a heartbeat detects half-open sockets.
 */

export interface RealtimeEvent {
  topic: string;
  type: RealtimeEventType;
  ts: number;
  data: unknown;
}
export type RealtimeListener = (event: RealtimeEvent) => void;

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";
export interface RealtimeStatus {
  state: ConnectionState;
  /** Consecutive failed attempts since the last successful open. */
  attempt: number;
  /** Epoch ms of the next reconnect attempt while `reconnecting`. */
  nextRetryAt: number | null;
  lastOpenedAt: number | null;
}

export interface TopicError {
  topic: string | undefined;
  code: string;
  message: string;
}

/** Minimal WebSocket surface used by the client (so tests can inject a fake). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export interface RealtimeClientOptions {
  url: string | (() => string);
  createSocket?: WebSocketFactory;
  backoff?: Partial<BackoffOptions>;
  /** [0, 1) source for jitter; injectable for deterministic tests. */
  random?: () => number;
  now?: () => number;
  heartbeatIntervalMs?: number;
  /** Close and reconnect when nothing was received for this long. */
  heartbeatTimeoutMs?: number;
}

const OPEN = 1;
const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1000, maxMs: 30_000, factor: 2 };

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential, capped, with "equal jitter"
 * (uniform in [d/2, d]) so a fleet of browsers does not reconnect in lockstep after an outage.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions, random: () => number): number {
  const exp = Math.min(opts.maxMs, opts.initialMs * opts.factor ** Math.max(0, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}

export function defaultRealtimeUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/realtime`;
}

export class RealtimeClient {
  private ws: WebSocketLike | null = null;
  private readonly topics = new Map<string, Set<RealtimeListener>>();
  private readonly statusListeners = new Set<(s: RealtimeStatus) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(e: TopicError) => void>();
  private status: RealtimeStatus = { state: "idle", attempt: 0, nextRetryAt: null, lastOpenedAt: null };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private hasOpenedBefore = false;
  private running = false;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly createSocket: WebSocketFactory;

  constructor(private readonly opts: RealtimeClientOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  }

  /** Begin connecting (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  /** Close the socket and stop reconnecting (logout / unmount). */
  stop(): void {
    this.running = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.detach(ws);
      ws.close(1000, "client stopped");
    }
    this.setStatus({ state: "closed", attempt: 0, nextRetryAt: null });
  }

  /** Skip the remaining backoff (e.g. the browser came back online). */
  reconnectNow(): void {
    if (!this.running || this.status.state === "open" || this.status.state === "connecting") return;
    this.clearReconnectTimer();
    this.connect();
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  /** Topics with at least one listener. */
  activeTopics(): string[] {
    return [...this.topics.keys()];
  }

  subscribe(topic: string, listener: RealtimeListener): () => void {
    if (!Topic.safeParse(topic).success) throw new Error(`Invalid realtime topic: ${topic}`);
    let listeners = this.topics.get(topic);
    if (!listeners) {
      listeners = new Set();
      this.topics.set(topic, listeners);
      this.send({ op: "subscribe", topic });
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const set = this.topics.get(topic);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.topics.delete(topic);
        this.send({ op: "unsubscribe", topic });
      }
    };
  }

  onStatus(listener: (s: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Fired after every successful re-open (not the first open). */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  onTopicError(listener: (e: TopicError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // -------------------------------------------------------------------------------------------

  private connect(): void {
    if (!this.running) return;
    this.setStatus({
      state: this.hasOpenedBefore || this.status.attempt > 0 ? "reconnecting" : "connecting",
      nextRetryAt: null,
    });
    const url = typeof this.opts.url === "function" ? this.opts.url() : this.opts.url;
    let ws: WebSocketLike;
    try {
      ws = this.createSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => {
      /* a close event always follows */
    };
  }

  private handleOpen(ws: WebSocketLike): void {
    if (ws !== this.ws) return;
    const reconnected = this.hasOpenedBefore;
    this.hasOpenedBefore = true;
    this.lastMessageAt = this.now();
    for (const topic of this.topics.keys()) this.send({ op: "subscribe", topic });
    this.startHeartbeat();
    this.setStatus({ state: "open", attempt: 0, nextRetryAt: null, lastOpenedAt: this.now() });
    if (reconnected) for (const l of [...this.reconnectListeners]) l();
  }

  private handleMessage(raw: unknown): void {
    this.lastMessageAt = this.now();
    if (typeof raw !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = ServerFrame.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.op) {
      case "event": {
        const listeners = this.topics.get(frame.topic);
        if (!listeners) return;
        const event: RealtimeEvent = { topic: frame.topic, type: frame.type, ts: frame.ts, data: frame.data };
        for (const l of [...listeners]) {
          try {
            l(event);
          } catch (err) {
            console.error("[realtime] listener failed", err);
          }
        }
        return;
      }
      case "error":
        for (const l of [...this.errorListeners])
          l({ topic: frame.topic, code: frame.code, message: frame.message });
        return;
      default:
        return;
    }
  }

  private handleClose(ws: WebSocketLike): void {
    if (ws !== this.ws) return;
    this.detach(ws);
    this.ws = null;
    this.stopHeartbeat();
    if (!this.running) {
      this.setStatus({ state: "closed", nextRetryAt: null });
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const attempt = this.status.attempt;
    const delay = backoffDelay(attempt, this.backoff, this.random);
    this.setStatus({ state: "reconnecting", attempt: attempt + 1, nextRetryAt: this.now() + delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.opts.heartbeatIntervalMs ?? 25_000;
    const timeout = this.opts.heartbeatTimeoutMs ?? 60_000;
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (this.now() - this.lastMessageAt > timeout) {
        // Half-open socket: drop it without waiting for the TCP stack to notice.
        this.detach(ws);
        ws.close(4000, "heartbeat timeout");
        this.handleCloseForced(ws);
        return;
      }
      this.send({ op: "ping" });
    }, interval);
  }

  private handleCloseForced(ws: WebSocketLike): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopHeartbeat();
    if (this.running) this.scheduleReconnect();
  }

  private send(frame: ClientFrame): void {
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(frame));
  }

  private detach(ws: WebSocketLike): void {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
  }

  private setStatus(patch: Partial<RealtimeStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of [...this.statusListeners]) l(this.status);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
  }
}
