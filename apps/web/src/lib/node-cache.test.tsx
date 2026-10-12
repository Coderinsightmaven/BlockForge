import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node, NodeMetricSample } from "@blockforge/contracts";
import { makeClient } from "@/test/fake-socket";
import { NODE_ID, jsonResponse, makeNode } from "@/test/fixtures";
import { mergeNodeLatest, mergeNodeList, upsertNodeInCache } from "./node-cache";
import { nodeQuery, nodesQuery } from "./queries";
import { qk } from "./query-keys";
import { useNodeDetailRealtime } from "./realtime/handlers";
import { RealtimeProvider } from "./realtime/provider";

function sample(ts: number, usagePct = 10): NodeMetricSample {
  return {
    ts,
    cpu: { usagePct },
    memory: { totalBytes: 100, usedBytes: 50, availableBytes: 50 },
    filesystems: [],
    diskIo: [],
    network: [],
  };
}
const withSample = (ts: number | null, extra: Partial<Node> = {}) =>
  makeNode({ latest: ts === null ? null : sample(ts), ...extra });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mergeNodeLatest", () => {
  it("keeps a newer cached live sample over an older (or missing) REST one", () => {
    expect(mergeNodeLatest(withSample(1000, { name: "renamed" }), withSample(2000))).toMatchObject({
      name: "renamed",
      latest: { ts: 2000 },
    });
    expect(mergeNodeLatest(withSample(null), withSample(2000)).latest?.ts).toBe(2000);
  });
  it("takes the incoming sample when it is newer or equal, or when nothing is cached", () => {
    expect(mergeNodeLatest(withSample(3000), withSample(2000)).latest?.ts).toBe(3000);
    expect(mergeNodeLatest(withSample(2000), withSample(2000)).latest?.ts).toBe(2000);
    expect(mergeNodeLatest(withSample(1000), undefined).latest?.ts).toBe(1000);
  });
  it("merges lists per node id", () => {
    const other = makeNode({ id: "33333333-3333-4333-8333-333333333333", latest: sample(5) });
    const merged = mergeNodeList([withSample(1000), other], [withSample(9000)]);
    expect(merged.map((n) => n.latest?.ts)).toEqual([9000, 5]);
  });
});

describe("node queries never regress the live sample", () => {
  it("GET /nodes/:id refetch keeps the newer cached sample", async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.nodes.detail(NODE_ID), withSample(2000));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(withSample(1000, { name: "from-rest" }))),
    );
    await qc.fetchQuery({ ...nodeQuery(NODE_ID), staleTime: 0 });
    // What components observe is the stored (structurally shared) data.
    const stored = qc.getQueryData<Node>(qk.nodes.detail(NODE_ID));
    expect(stored?.name).toBe("from-rest");
    expect(stored?.latest?.ts).toBe(2000);
  });

  it("GET /nodes refetch keeps newer samples but accepts newer REST samples", async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.nodes.list, [withSample(2000)]);
    const storedTs = () => qc.getQueryData<Node[]>(qk.nodes.list)?.[0]?.latest?.ts;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([withSample(1500)])),
    );
    await qc.fetchQuery({ ...nodesQuery, staleTime: 0 });
    expect(storedTs()).toBe(2000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([withSample(4000)])),
    );
    await qc.fetchQuery({ ...nodesQuery, staleTime: 0 });
    expect(storedTs()).toBe(4000);
  });

  it("node.updated / mutation responses (upsertNodeInCache) keep the newer sample", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.nodes.list, [withSample(2000)]);
    qc.setQueryData(qk.nodes.detail(NODE_ID), withSample(2000));
    upsertNodeInCache(qc, withSample(1000, { status: "maintenance" }));
    expect(qc.getQueryData<Node[]>(qk.nodes.list)?.[0]).toMatchObject({
      status: "maintenance",
      latest: { ts: 2000 },
    });
    expect(qc.getQueryData<Node>(qk.nodes.detail(NODE_ID))).toMatchObject({
      status: "maintenance",
      latest: { ts: 2000 },
    });
  });
});

describe("useNodeDetailRealtime", () => {
  function mount() {
    vi.useFakeTimers();
    const { client, last } = makeClient();
    const qc = new QueryClient();
    qc.setQueryData(qk.nodes.detail(NODE_ID), withSample(1000));
    qc.setQueryData(qk.nodes.list, [withSample(1000)]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    function Live() {
      useNodeDetailRealtime(NODE_ID, true);
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
    const emit = (type: string, data: unknown) =>
      act(() => last().receive({ op: "event", topic: `node:${NODE_ID}`, type, ts: 1, data }));
    return { qc, invalidate, emit };
  }

  it("patches list and detail caches from a valid {nodeId, sample} payload", () => {
    const { qc, invalidate, emit } = mount();
    emit("node.metrics", { nodeId: NODE_ID, sample: sample(5000, 77) });
    expect(qc.getQueryData<Node>(qk.nodes.detail(NODE_ID))?.latest).toMatchObject({
      ts: 5000,
      cpu: { usagePct: 77 },
    });
    expect(qc.getQueryData<Node[]>(qk.nodes.list)?.[0]?.latest?.ts).toBe(5000);
    act(() => vi.advanceTimersByTime(5000));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("falls back to a throttled REST refetch when node.metrics does not parse", () => {
    const { qc, invalidate, emit } = mount();
    emit("node.metrics", { nodeId: NODE_ID, sample: { cpu: "broken" } });
    emit("node.metrics", "garbage");
    expect(qc.getQueryData<Node>(qk.nodes.detail(NODE_ID))?.latest?.ts).toBe(1000);
    expect(invalidate).not.toHaveBeenCalled(); // throttled (trailing edge)
    act(() => vi.advanceTimersByTime(2000));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.nodes.detail(NODE_ID) });
  });

  it("ignores samples for another node but still refetches", () => {
    const { qc, invalidate, emit } = mount();
    emit("node.metrics", { nodeId: "33333333-3333-4333-8333-333333333333", sample: sample(9000) });
    expect(qc.getQueryData<Node>(qk.nodes.detail(NODE_ID))?.latest?.ts).toBe(1000);
    act(() => vi.advanceTimersByTime(2000));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
