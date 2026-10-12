/**
 * In-memory WebSocket double for tests: tests drive open/message/close explicitly.
 * Never imported by application code.
 */
import { RealtimeClient } from "@/lib/realtime/client";
import type { WebSocketLike } from "@/lib/realtime/client";

/** In-memory WebSocket double: tests drive open/message/close explicitly. */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.closedWith = code;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  ops() {
    return this.sent.map((f) => (f.topic ? `${String(f.op)}:${String(f.topic)}` : String(f.op)));
  }
}

export function makeClient(opts: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const client = new RealtimeClient({
    url: "ws://test/api/v1/realtime",
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    random: () => 0.5,
    backoff: { initialMs: 1000, maxMs: 8000, factor: 2 },
    heartbeatIntervalMs: 25_000,
    heartbeatTimeoutMs: 60_000,
    ...opts,
  });
  const last = () => sockets[sockets.length - 1]!;
  return { client, sockets, last };
}
