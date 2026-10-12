import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { REALTIME_EVENT_PAYLOADS } from "@blockforge/contracts";
import type { Server, WorkloadMetricSample } from "@blockforge/contracts";
import { qk } from "../query-keys";
import { applyServerEvent, applyServerSample, type ServerBroadcast } from "../server-cache";
import { useThrottledInvalidate } from "./handlers";
import { useRealtimeClient, useRealtimeTopic } from "./provider";
import type { RealtimeEvent } from "./client";

export function parseServerMetrics(data: unknown, serverId?: string): WorkloadMetricSample | null {
  const parsed = REALTIME_EVENT_PAYLOADS["server.metrics"].safeParse(data);
  if (!parsed.success) return null;
  if (serverId && parsed.data.serverId !== serverId) return null;
  return parsed.data.sample;
}

export function parseServerUpdated(data: unknown): ServerBroadcast | null {
  const parsed = REALTIME_EVENT_PAYLOADS["server.updated"].safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Live state + metrics for one server page from `server:<id>`. */
export function useServerRealtime(serverId: string, enabled: boolean): void {
  const queryClient = useQueryClient();
  const invalidate = useThrottledInvalidate(qk.servers.detail(serverId), 2000);
  const invalidateSub = useThrottledInvalidate(qk.server(serverId).all, 3000);
  useRealtimeTopic(enabled ? `server:${serverId}` : null, (event) => {
    if (event.type === "server.metrics") {
      const sample = parseServerMetrics(event.data, serverId);
      if (sample) applyServerSample(queryClient, serverId, sample);
      else invalidate();
    } else if (event.type === "server.updated") {
      const server = parseServerUpdated(event.data);
      if (server && server.id === serverId) {
        const before = queryClient.getQueryData<Server>(qk.servers.detail(serverId));
        applyServerEvent(queryClient, server);
        // Allocation / image changes affect the sub-resources shown in tabs.
        if (
          before &&
          (before.dockerImage !== server.dockerImage ||
            before.allocations.length !== server.allocations.length)
        ) {
          invalidateSub();
        }
      } else invalidate();
    }
  });
}

/**
 * Live state for many servers (dashboard cards). One ref-counted subscription per visible server;
 * incoming events are buffered and applied to the cache at most once per `flushMs`, so 100 servers
 * reporting every few seconds cause one render per interval instead of hundreds.
 */
export function useServerListRealtime(serverIds: readonly string[], enabled: boolean, flushMs = 1000): void {
  const client = useRealtimeClient();
  const queryClient = useQueryClient();
  const pending = useRef(new Map<string, { server?: ServerBroadcast; sample?: WorkloadMetricSample }>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = useMemo(() => [...serverIds].sort().join(","), [serverIds]);

  useEffect(() => {
    if (!client || !enabled || !key) return;
    const flush = () => {
      timer.current = null;
      const batch = pending.current;
      pending.current = new Map();
      for (const [id, u] of batch) {
        if (u.server) applyServerEvent(queryClient, u.server);
        if (u.sample) applyServerSample(queryClient, id, u.sample);
      }
    };
    const schedule = () => {
      if (!timer.current) timer.current = setTimeout(flush, flushMs);
    };
    const onEvent = (id: string) => (event: RealtimeEvent) => {
      const entry = pending.current.get(id) ?? {};
      if (event.type === "server.metrics") {
        const sample = parseServerMetrics(event.data, id);
        if (!sample) return;
        if (!entry.sample || entry.sample.ts <= sample.ts) entry.sample = sample;
      } else if (event.type === "server.updated") {
        const server = parseServerUpdated(event.data);
        if (!server || server.id !== id) return;
        entry.server = server;
      } else return;
      pending.current.set(id, entry);
      schedule();
    };
    const offs = key.split(",").map((id) => client.subscribe(`server:${id}`, onEvent(id)));
    return () => {
      for (const off of offs) off();
      // Apply what is buffered rather than dropping it when the visible set changes.
      if (timer.current) {
        clearTimeout(timer.current);
        flush();
      }
    };
  }, [client, queryClient, enabled, key, flushMs]);
}
