import { useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { Node, NodeMetricSample } from "@blockforge/contracts";
import { upsertNodeInCache } from "../node-cache";
import { qk } from "../query-keys";
import { useRealtimeTopic } from "./provider";
import { SHELL_EVENT_PAYLOADS } from "./payloads";

export { upsertNodeInCache };

/*
 * Realtime → query-cache glue. Payloads are validated against `REALTIME_EVENT_PAYLOADS`; a payload
 * that does not parse (or names another subject) is treated as a hint and triggers a throttled
 * REST refetch instead of being trusted or silently dropped.
 */

/** `node.metrics` payload `{nodeId, sample}` → the sample, if it is for `nodeId`. */
export function extractNodeSample(data: unknown, nodeId?: string): NodeMetricSample | null {
  const parsed = SHELL_EVENT_PAYLOADS["node.metrics"].safeParse(data);
  if (!parsed.success) return null;
  if (nodeId && parsed.data.nodeId !== nodeId) return null;
  return parsed.data.sample;
}

/** `node.updated` payload: the bare `Node` DTO. */
export function extractNode(data: unknown): Node | null {
  const parsed = SHELL_EVENT_PAYLOADS["node.updated"].safeParse(data);
  return parsed.success ? parsed.data : null;
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
      if (!sample) {
        // Unusable live sample: fall back to REST so the tiles do not silently freeze.
        invalidate();
        return;
      }
      const patch = (n: Node | undefined) =>
        n && (!n.latest || n.latest.ts <= sample.ts) ? { ...n, latest: sample } : n;
      queryClient.setQueryData<Node>(qk.nodes.detail(nodeId), patch);
      queryClient.setQueryData<Node[]>(qk.nodes.list, (list) =>
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
    const parsed = SHELL_EVENT_PAYLOADS["overview.updated"].safeParse(event.data);
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
