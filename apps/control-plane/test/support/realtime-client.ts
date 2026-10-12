import { REALTIME_EVENT_PAYLOADS, ServerFrame, type RealtimeEventType } from "@blockforge/contracts";
import WebSocket from "ws";
import type { ApiClient, TestApp } from "./app.js";
import { TEST_PUBLIC_URL } from "./env.js";

type Frame = ServerFrame;

/** Browser-like realtime client: cookie auth + Origin header; validates every frame against the contracts. */
export class UiSocket {
  ws: WebSocket | null = null;
  readonly frames: Frame[] = [];
  readonly invalid: unknown[] = [];
  closeCode: number | null = null;
  private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];

  static async open(t: TestApp, client: ApiClient, origin = TEST_PUBLIC_URL): Promise<UiSocket> {
    const s = new UiSocket();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${t.wsBaseUrl}/api/v1/realtime`, { headers: { cookie: client.cookieHeader(), origin } });
      ws.on("open", () => {
        s.ws = ws;
        resolve();
      });
      ws.on("unexpected-response", (_req, res) => reject(Object.assign(new Error(`upgrade refused: ${res.statusCode}`), { status: res.statusCode })));
      ws.on("error", reject);
      ws.on("close", (code) => {
        s.closeCode = code;
      });
      ws.on("message", (data) => {
        const raw = JSON.parse(data.toString());
        const parsed = ServerFrame.safeParse(raw);
        if (!parsed.success) {
          s.invalid.push(raw);
          return;
        }
        const frame = parsed.data;
        if (frame.op === "event") {
          const payload = REALTIME_EVENT_PAYLOADS[frame.type as RealtimeEventType].safeParse(frame.data);
          if (!payload.success) s.invalid.push({ type: frame.type, data: frame.data, issues: payload.error.issues });
        }
        s.frames.push(frame);
        const matched = s.waiters.filter((w) => w.match(frame));
        s.waiters = s.waiters.filter((w) => !matched.includes(w));
        for (const w of matched) w.resolve(frame);
      });
    });
    return s;
  }

  waitFor(match: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for realtime frame")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  waitForEvent(topic: string, type: RealtimeEventType, timeoutMs = 5000, pred: (data: unknown) => boolean = () => true): Promise<Frame & { op: "event" }> {
    return this.waitFor((f) => f.op === "event" && f.topic === topic && f.type === type && pred(f.data), timeoutMs) as Promise<Frame & { op: "event" }>;
  }

  async subscribe(topic: string): Promise<Frame> {
    this.ws?.send(JSON.stringify({ op: "subscribe", topic }));
    return this.waitFor((f) => (f.op === "subscribed" || f.op === "error") && f.topic === topic);
  }

  send(raw: string): void {
    this.ws?.send(raw);
  }

  close(): void {
    this.ws?.close();
  }
}
