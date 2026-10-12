import { useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { Node, NodeMetricSample, OverviewSummary } from "@blockforge/contracts";
import type { Node as NodeT, NodeMetricSample as NodeMetricSampleT } from "@blockforge/contracts";
import { qk } from "../query-keys";
import { useRealtimeTopic } from "./provider";

/*
 * Realtime → query-cache glue. Event payloads are validated against the contract schemas; a
 * payload that does not parse is treated as a hint and triggers a (throttled) REST refetch
 * instead of being trusted.
 */

/** Pull a `NodeMetricSample` out of a `node.metrics` payload (bare sample or `{nodeId, sample}`). */
export function extractNodeSample(data: unknown, nodeId?: string): NodeMetricSampleT | null {
  const direct = NodeMetricSample.safeParse(data);
  if (direct.success) return direct.data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (nodeId && typeof obj.nodeId === "string" && obj.nodeId !== nodeId) return null;
    for (const key of ["sample", "latest", "metrics"]) {
      const nested = NodeMetricSample.safeParse(obj[key]);
      if (nested.success) return nested.data;
    }
  }
  return null;
}

/** `node.updated` payload: a full `Node`, or `{node}`. */
export function extractNode(data: unknown): NodeT | null {
  const direct = Node.safeParse(data);
  if (direct.success) return direct.data;
  if (data && typeof data === "object") {
    const nested = Node.safeParse((data as Record<string, unknown>).node);
    if (nested.success) return nested.data;
  }
  return null;
}

/** Trailing-edge throttled invalidation of a query prefix. */
export function useThrottledInvalidate(queryKey: QueryKey, ms = 2000): () => void {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: keyRef.current });
    }, ms);
  }, [queryClient, ms]);
}

export function upsertNodeInCache(queryClient: ReturnType<typeof useQueryClient>, node: NodeT): void {
  queryClient.setQueryData<NodeT[]>(qk.nodes.list, (list) => {
    if (!list) return list;
    const i = list.findIndex((n) => n.id === node.id);
    if (i === -1) return [...list, node];
    const next = list.slice();
    next[i] = node;
    return next;
  });
  queryClient.setQueryData<NodeT>(qk.nodes.detail(node.id), node);
}

/** Keeps the node list (and cached details) live from the `nodes` topic. */
export function useNodeListRealtime(enabled: boolean): void {
  const queryClient = useQueryClient();
  const invalidate = useThrottledInvalidate(qk.nodes.all, 3000);
  useRealtimeTopic(enabled ? "nodes" : null, (event) => {
    if (event.type !== "node.updated") return;
    const node = extractNode(event.data);
    if (node) upsertNodeInCache(queryClient, node);
    else invalidate();
  });
}

/** Live metrics + state for one node from the `node:<id>` topic. */
export function useNodeDetailRealtime(nodeId: string, enabled: boolean): void {
  const queryClient = useQueryClient();
  const invalidate = useThrottledInvalidate(qk.nodes.detail(nodeId), 2000);
  useRealtimeTopic(enabled ? `node:${nodeId}` : null, (event) => {
    if (event.type === "node.metrics") {
      const sample = extractNodeSample(event.data, nodeId);
      if (!sample) return;
      const patch = (n: NodeT | undefined) =>
        n && (!n.latest || n.latest.ts <= sample.ts) ? { ...n, latest: sample } : n;
      queryClient.setQueryData<NodeT>(qk.nodes.detail(nodeId), patch);
      queryClient.setQueryData<NodeT[]>(qk.nodes.list, (list) =>
        list?.map((n) => (n.id === nodeId ? (patch(n) ?? n) : n)),
      );
    } else if (event.type === "node.updated") {
      const node = extractNode(event.data);
      if (node && node.id === nodeId) upsertNodeInCache(queryClient, node);
      else invalidate();
    }
  });
}

export function useOverviewRealtime(enabled: boolean): void {
  const queryClient = useQueryClient();
  const invalidate = useThrottledInvalidate(qk.overview, 3000);
  useRealtimeTopic(enabled ? "overview" : null, (event) => {
    if (event.type !== "overview.updated") return;
    const parsed = OverviewSummary.safeParse(event.data);
    if (parsed.success) queryClient.setQueryData(qk.overview, parsed.data);
    else invalidate();
  });
}

/** Incident lists refetch when an `alert.updated` arrives (they are paginated, so no patching). */
export function useAlertsRealtime(enabled: boolean): void {
  const invalidate = useThrottledInvalidate(["alerts", "incidents"], 1500);
  useRealtimeTopic(enabled ? "alerts" : null, (event) => {
    if (event.type === "alert.updated") invalidate();
  });
}
