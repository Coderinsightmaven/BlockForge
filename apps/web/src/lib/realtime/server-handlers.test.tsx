import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { Backup, Page, Schedule, Server } from "@blockforge/contracts";
import { makeClient } from "@/test/fake-socket";
import { SERVER_ID, makeBackup, makeSchedule, makeServer } from "@/test/fixtures";
import { qk } from "../query-keys";
import { RealtimeProvider } from "./provider";
import { useServerListRealtime, useServerRealtime } from "./server-handlers";

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

describe("useServerRealtime", () => {
  it("applies server.updated at once and re-reads the per-user DTO (throttled)", () => {
    vi.useFakeTimers();
    const { client, last } = makeClient();
    const qc = new QueryClient();
    qc.setQueryData(qk.servers.detail(SERVER_ID), makeServer({ state: "stopped" }));
    const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
    function Live() {
      useServerRealtime(SERVER_ID, true);
      return null;
    }
    render(
      <QueryClientProvider client={qc}>
        <RealtimeProvider client={client}>
          <Live />
        </RealtimeProvider>
      </QueryClientProvider>,
    );
    act(() => last().open());
    const { myPermissions: _p, sftp: _s, ...broadcast } = makeServer({ state: "running" });
    const updated = (ts: number) =>
      act(() =>
        last().receive({
          op: "event",
          topic: `server:${SERVER_ID}`,
          type: "server.updated",
          ts,
          data: broadcast,
        }),
      );
    updated(1);
    // Immediate cache write; per-user fields kept from REST.
    const cached = qc.getQueryData<Server>(qk.servers.detail(SERVER_ID))!;
    expect(cached.state).toBe("running");
    expect(cached.myPermissions.length).toBeGreaterThan(0);
    // A burst of updates causes one detail refetch after the throttle window.
    updated(2);
    updated(3);
    expect(invalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2000));
    const detailCalls = invalidate.mock.calls.filter(
      ([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(qk.servers.detail(SERVER_ID)),
    );
    expect(detailCalls).toHaveLength(1);
  });
});

describe("useServerRealtime Phase 4 events", () => {
  it("applies backup/schedule updated and deleted events to the open tabs' lists", () => {
    const { client, last } = makeClient();
    const qc = new QueryClient();
    qc.setQueryData(qk.servers.detail(SERVER_ID), makeServer());
    qc.setQueryData<Backup[]>(qk.server(SERVER_ID).backups, [makeBackup({ status: "running" })]);
    qc.setQueryData<Schedule[]>(qk.server(SERVER_ID).schedules, [makeSchedule()]);
    function Live() {
      useServerRealtime(SERVER_ID, true);
      return null;
    }
    render(
      <QueryClientProvider client={qc}>
        <RealtimeProvider client={client}>
          <Live />
        </RealtimeProvider>
      </QueryClientProvider>,
    );
    act(() => last().open());
    const send = (type: string, data: unknown) =>
      act(() => last().receive({ op: "event", topic: `server:${SERVER_ID}`, type, ts: 1, data }));
    send("backup.updated", makeBackup({ status: "completed", sizeBytes: 99 }));
    send("schedule.updated", makeSchedule({ running: true, lastRunAt: 5 }));
    // Another server's backup on this topic is ignored.
    send("backup.updated", makeBackup({ id: OTHER, serverId: OTHER }));
    const backups = qc.getQueryData<Backup[]>(qk.server(SERVER_ID).backups)!;
    expect(backups.map((b) => [b.status, b.sizeBytes])).toEqual([["completed", 99]]);
    const updatedSchedule = qc.getQueryData<Schedule[]>(qk.server(SERVER_ID).schedules)![0];
    send("schedule.deleted", { serverId: SERVER_ID, scheduleId: makeSchedule().id });
    send("backup.deleted", { serverId: SERVER_ID, backupId: makeBackup().id });
    expect(qc.getQueryData<Backup[]>(qk.server(SERVER_ID).backups)).toEqual([]);
    expect(qc.getQueryData<Schedule[]>(qk.server(SERVER_ID).schedules)).toEqual([]);
    expect(updatedSchedule).toMatchObject({
      running: true,
      lastRunAt: 5,
    });
  });
});
