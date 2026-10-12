import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { Page, Server } from "@blockforge/contracts";
import { makeClient } from "@/test/fake-socket";
import { SERVER_ID, makeServer } from "@/test/fixtures";
import { qk } from "../query-keys";
import { RealtimeProvider } from "./provider";
import { useServerListRealtime } from "./server-handlers";

const OTHER = "44444444-4444-4444-8444-444444444444";

afterEach(() => vi.useRealTimers());

describe("useServerListRealtime", () => {
  it("subscribes one topic per visible server and batches cache writes", () => {
    vi.useFakeTimers();
    const { client, last } = makeClient();
    const qc = new QueryClient();
    const servers = [makeServer(), makeServer({ id: OTHER, shortId: "44444444", name: "Creative" })];
    qc.setQueryData<InfiniteData<Page<Server>>>(qk.servers.list("mine", ""), {
      pages: [{ items: servers, nextCursor: null }],
      pageParams: [null],
    });
    const writes = vi.spyOn(qc, "setQueriesData");
    function Live({ ids }: { ids: string[] }) {
      useServerListRealtime(ids, true, 1000);
      return null;
    }
    const ui = (ids: string[]) => (
      <QueryClientProvider client={qc}>
        <RealtimeProvider client={client}>
          <Live ids={ids} />
        </RealtimeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(ui([SERVER_ID, OTHER]));
    act(() => last().open());
    expect(last().ops().sort()).toEqual([`subscribe:server:${OTHER}`, `subscribe:server:${SERVER_ID}`]);

    const metrics = (serverId: string, ts: number, cpuPct: number) =>
      act(() =>
        last().receive({
          op: "event",
          topic: `server:${serverId}`,
          type: "server.metrics",
          ts,
          data: { serverId, sample: { workloadId: serverId, ts, running: true, cpuPct } },
        }),
      );
    for (let i = 1; i <= 20; i++) metrics(SERVER_ID, 1000 + i, i);
    metrics(OTHER, 2000, 50);
    // Mismatched subject ids are ignored.
    act(() =>
      last().receive({
        op: "event",
        topic: `server:${SERVER_ID}`,
        type: "server.metrics",
        ts: 1,
        data: { serverId: OTHER, sample: { workloadId: OTHER, ts: 9999, running: true, cpuPct: 1 } },
      }),
    );
    expect(writes).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    // One flush: one list write per server, with the newest sample only.
    expect(writes).toHaveBeenCalledTimes(2);
    const items = qc.getQueryData<InfiniteData<Page<Server>>>(qk.servers.list("mine", ""))!.pages[0]!.items;
    expect(items.find((s) => s.id === SERVER_ID)!.latest?.cpuPct).toBe(20);
    expect(items.find((s) => s.id === OTHER)!.latest?.cpuPct).toBe(50);

    rerender(ui([SERVER_ID]));
    expect(last().ops()).toContain(`unsubscribe:server:${OTHER}`);
  });
});
