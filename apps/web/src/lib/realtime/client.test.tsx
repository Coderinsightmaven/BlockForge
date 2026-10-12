import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_ID } from "@/test/fixtures";
import { makeClient } from "@/test/fake-socket";
import { backoffDelay } from "./client";
import type { RealtimeEvent } from "./client";
import { RealtimeProvider, useRealtimeTopic } from "./provider";

const NODE_TOPIC = `node:${NODE_ID}`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelay", () => {
  const opts = { initialMs: 1000, maxMs: 8000, factor: 2 };
  it("grows exponentially with equal jitter and is capped", () => {
    expect(backoffDelay(0, opts, () => 0)).toBe(500);
    expect(backoffDelay(0, opts, () => 0.999)).toBe(1000);
    expect(backoffDelay(1, opts, () => 0)).toBe(1000);
    expect(backoffDelay(2, opts, () => 0.5)).toBe(3000);
    expect(backoffDelay(10, opts, () => 0)).toBe(4000);
    expect(backoffDelay(10, opts, () => 1)).toBe(8000);
  });
});

describe("RealtimeClient subscriptions", () => {
  it("ref-counts topics: one subscribe frame per topic, unsubscribe after the last listener", () => {
    const { client, last } = makeClient();
    client.start();
    last().open();
    const offA = client.subscribe("overview", () => {});
    const offB = client.subscribe("overview", () => {});
    expect(last().ops()).toEqual(["subscribe:overview"]);
    offA();
    expect(last().ops()).toEqual(["subscribe:overview"]);
    offA(); // idempotent
    offB();
    expect(last().ops()).toEqual(["subscribe:overview", "unsubscribe:overview"]);
    expect(client.activeTopics()).toEqual([]);
  });

  it("queues subscriptions made before the socket opens", () => {
    const { client, last } = makeClient();
    client.subscribe("nodes", () => {});
    client.start();
    expect(last().ops()).toEqual([]);
    last().open();
    expect(last().ops()).toEqual(["subscribe:nodes"]);
  });

  it("delivers events only to listeners of the frame's topic and ignores invalid frames", () => {
    const { client, last } = makeClient();
    const overview: RealtimeEvent[] = [];
    const node: RealtimeEvent[] = [];
    client.subscribe("overview", (e) => overview.push(e));
    client.subscribe(NODE_TOPIC, (e) => node.push(e));
    client.start();
    last().open();
    last().receive({ op: "event", topic: NODE_TOPIC, type: "node.metrics", ts: 1, data: { x: 1 } });
    last().receive("{not json");
    last().receive({ op: "event", topic: "overview", type: "not-a-type", ts: 1, data: null });
    last().receive({ op: "event", topic: "overview", type: "overview.updated", ts: 2, data: { ok: true } });
    expect(node).toEqual([{ topic: NODE_TOPIC, type: "node.metrics", ts: 1, data: { x: 1 } }]);
    expect(overview.map((e) => e.ts)).toEqual([2]);
  });

  it("reports topic errors", () => {
    const { client, last } = makeClient();
    const errors: unknown[] = [];
    client.onTopicError((e) => errors.push(e));
    client.start();
    last().open();
    last().receive({ op: "error", topic: "alerts", code: "FORBIDDEN", message: "alerts.view required" });
    expect(errors).toEqual([{ topic: "alerts", code: "FORBIDDEN", message: "alerts.view required" }]);
  });

  it("rejects unknown topics", () => {
    const { client } = makeClient();
    expect(() => client.subscribe("everything", () => {})).toThrow(/Invalid realtime topic/);
  });
});

describe("RealtimeClient reconnect", () => {
  it("reconnects with backoff, re-subscribes every topic and announces the reconnect", () => {
    const { client, sockets, last } = makeClient();
    const reconnects = vi.fn();
    client.onReconnect(reconnects);
    client.subscribe("overview", () => {});
    client.subscribe(NODE_TOPIC, () => {});
    client.start();
    last().open();
    expect(client.getStatus().state).toBe("open");
    expect(reconnects).not.toHaveBeenCalled();

    last().drop();
    const status = client.getStatus();
    expect(status.state).toBe("reconnecting");
    expect(status.attempt).toBe(1);
    // attempt 0: base 1000 ms, jitter 0.5 → 750 ms
    expect(status.nextRetryAt).toBe(Date.now() + 750);
    vi.advanceTimersByTime(749);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    last().open();
    expect(last().ops().sort()).toEqual([`subscribe:${NODE_TOPIC}`, "subscribe:overview"]);
    expect(reconnects).toHaveBeenCalledOnce();
    expect(client.getStatus()).toMatchObject({ state: "open", attempt: 0 });
  });

  it("backs off further on consecutive failures and resets after success", () => {
    const { client, sockets, last } = makeClient();
    client.start();
    last().drop(); // never opened
    vi.advanceTimersByTime(750); // attempt 0 → 750 ms
    expect(sockets).toHaveLength(2);
    last().drop();
    expect(client.getStatus().attempt).toBe(2);
    vi.advanceTimersByTime(1499); // attempt 1 → 1500 ms
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    last().drop();
    vi.advanceTimersByTime(3000); // attempt 2 → 3000 ms
    expect(sockets).toHaveLength(4);
    last().open();
    last().drop();
    expect(client.getStatus().attempt).toBe(1);
    expect(client.getStatus().nextRetryAt).toBe(Date.now() + 750);
  });

  it("subscriptions added while disconnected are sent on the next open", () => {
    const { client, last } = makeClient();
    client.start();
    last().open();
    last().drop();
    client.subscribe("alerts", () => {});
    vi.advanceTimersByTime(750);
    last().open();
    expect(last().ops()).toEqual(["subscribe:alerts"]);
  });

  it("stop() closes the socket and never reconnects", () => {
    const { client, sockets, last } = makeClient();
    client.start();
    last().open();
    client.stop();
    expect(last().closedWith).toBe(1000);
    expect(client.getStatus().state).toBe("closed");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("reconnectNow() skips the remaining backoff", () => {
    const { client, sockets, last } = makeClient();
    client.start();
    last().open();
    last().drop();
    client.reconnectNow();
    expect(sockets).toHaveLength(2);
  });

  it("never stacks sockets: repeated reconnectNow() while connecting is a no-op, replaced sockets are closed and muted", () => {
    const { client, sockets } = makeClient();
    const seen: number[] = [];
    client.subscribe("overview", (e) => seen.push(e.ts));
    client.start();
    sockets[0]!.open();
    sockets[0]!.drop();
    client.reconnectNow(); // backoff skipped → socket 1 (CONNECTING)
    client.reconnectNow(); // still connecting: no second socket
    client.reconnectNow();
    expect(sockets).toHaveLength(2);

    // Force a replacement while socket 1 is still connecting (e.g. a failed health check).
    client.forceReconnect();
    expect(sockets).toHaveLength(3);
    expect(sockets[1]!.closedWith).toBe(4000);

    // A late open / frame from the replaced socket must not count.
    sockets[1]!.readyState = 1;
    sockets[1]!.onopen?.({});
    sockets[1]!.receive({ op: "event", topic: "overview", type: "overview.updated", ts: 1, data: null });
    expect(seen).toEqual([]);
    expect(client.getStatus().state).not.toBe("open");

    sockets[2]!.open();
    sockets[2]!.receive({ op: "event", topic: "overview", type: "overview.updated", ts: 2, data: null });
    expect(seen).toEqual([2]);
    expect(sockets[2]!.ops()).toEqual(["subscribe:overview"]);
  });

  it("checkHealth() replaces a socket that is not open", () => {
    const { client, sockets } = makeClient();
    client.start();
    sockets[0]!.open();
    sockets[0]!.drop(); // waiting out the backoff
    client.checkHealth();
    expect(sockets).toHaveLength(2);
    client.checkHealth(); // connecting counts as not open after sleep → replaced
    expect(sockets[1]!.closedWith).toBe(4000);
    expect(sockets).toHaveLength(3);
  });

  it("checkHealth() probes an OPEN socket and reconnects when nothing answers within 5 s", () => {
    const { client, sockets } = makeClient();
    client.start();
    sockets[0]!.open();
    client.checkHealth();
    expect(sockets[0]!.ops()).toEqual(["ping"]);
    vi.advanceTimersByTime(4999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets[0]!.closedWith).toBe(4000);
    expect(sockets).toHaveLength(2);
  });

  it("checkHealth() keeps a socket that answers the probe", () => {
    const { client, sockets } = makeClient();
    client.start();
    sockets[0]!.open();
    client.checkHealth();
    vi.advanceTimersByTime(200);
    sockets[0]!.receive({ op: "pong", ts: 1 });
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closedWith).toBeNull();
    expect(client.getStatus().state).toBe("open");
  });

  it("pings while healthy and drops a silent (half-open) socket", () => {
    const { client, sockets, last } = makeClient();
    client.start();
    last().open();
    vi.advanceTimersByTime(25_000);
    expect(last().ops()).toContain("ping");
    last().receive({ op: "pong", ts: 1 });
    vi.advanceTimersByTime(25_000); // 25 s since pong: still fine
    expect(sockets[0]!.closedWith).toBeNull();
    vi.advanceTimersByTime(50_000); // > 60 s of silence
    expect(sockets[0]!.closedWith).toBe(4000);
    expect(client.getStatus().state).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });
});

describe("useRealtimeTopic", () => {
  it("shares one subscription between components and releases it on unmount", () => {
    const { client, last } = makeClient();
    const seen: string[] = [];
    function Listener({ name, topic }: { name: string; topic: string | null }) {
      useRealtimeTopic(topic, (e) => seen.push(`${name}:${e.type}`));
      return null;
    }
    const qc = new QueryClient();
    const ui = (showSecond: boolean, topic: string | null = "overview") => (
      <QueryClientProvider client={qc}>
        <RealtimeProvider client={client}>
          <Listener name="a" topic={topic} />
          {showSecond ? <Listener name="b" topic="overview" /> : null}
        </RealtimeProvider>
      </QueryClientProvider>
    );
    const { rerender, unmount } = render(ui(true));
    act(() => last().open());
    expect(last().ops()).toEqual(["subscribe:overview"]);
    act(() =>
      last().receive({ op: "event", topic: "overview", type: "overview.updated", ts: 1, data: null }),
    );
    expect(seen.sort()).toEqual(["a:overview.updated", "b:overview.updated"]);
    rerender(ui(false));
    expect(last().ops()).toEqual(["subscribe:overview"]);
    rerender(ui(false, null)); // permission revoked → topic disabled
    expect(last().ops()).toEqual(["subscribe:overview", "unsubscribe:overview"]);
    unmount();
    expect(client.getStatus().state).toBe("closed");
  });

  it("invalidates queries after a reconnect because missed events are not replayed", async () => {
    const { client, last } = makeClient();
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <RealtimeProvider client={client}>{null}</RealtimeProvider>
      </QueryClientProvider>,
    );
    act(() => last().open());
    expect(spy).not.toHaveBeenCalled();
    act(() => last().drop());
    act(() => vi.advanceTimersByTime(750));
    act(() => last().open());
    expect(spy).toHaveBeenCalledWith({ refetchType: "active" });
  });
});
