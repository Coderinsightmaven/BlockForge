import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { REALTIME_EVENT_PAYLOADS } from "@blockforge/contracts";
import type { Server, WorkloadMetricSample } from "@blockforge/contracts";
import { qk } from "../query-keys";
import {
  applyBackupEvent,
  applyScheduleEvent,
  removeBackupFromCache,
  removeScheduleFromCache,
} from "../phase4-cache";
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
  const invalidateBackups = useThrottledInvalidate(qk.server(serverId).backups, 2000);
  const invalidateSchedules = useThrottledInvalidate(qk.server(serverId).schedules, 2000);
  useRealtimeTopic(enabled ? `server:${serverId}` : null, (event) => {
    if (event.type === "server.metrics") {
      const sample = parseServerMetrics(event.data, serverId);
      if (sample) applyServerSample(queryClient, serverId, sample);
      else invalidate();
    } else if (event.type === "server.updated") {
      const server = parseServerUpdated(event.data);
      if (server && server.id === serverId) {
        const before = queryClient.getQueryData<Server>(qk.servers.detail(serverId));
        // Show the broadcast state at once, then re-read the full DTO: per-user fields
        // (myPermissions, sftp) are not broadcast and may have changed with it (e.g. a subuser's
        // grants, an owner change, a new allocation's alias). Throttled, so bursts cost one read.
        applyServerEvent(queryClient, server);
        invalidate();
        // Allocation / image changes affect the sub-resources shown in tabs.
        if (
          before &&
          (before.dockerImage !== server.dockerImage ||
            before.allocations.length !== server.allocations.length)
        ) {
          invalidateSub();
        }
      } else invalidate();
    } else if (event.type === "backup.updated") {
      // Status/progress/size of one backup (creation, upload, rotation, lock).
      const parsed = REALTIME_EVENT_PAYLOADS["backup.updated"].safeParse(event.data);
      if (parsed.success && parsed.data.serverId === serverId) applyBackupEvent(queryClient, parsed.data);
      else invalidateBackups();
    } else if (event.type === "schedule.updated") {
      // Next/last run, running flag, edits from another session.
      const parsed = REALTIME_EVENT_PAYLOADS["schedule.updated"].safeParse(event.data);
      if (parsed.success && parsed.data.serverId === serverId) applyScheduleEvent(queryClient, parsed.data);
      else invalidateSchedules();
    } else if (event.type === "backup.deleted") {
      const parsed = REALTIME_EVENT_PAYLOADS["backup.deleted"].safeParse(event.data);
      if (parsed.success && parsed.data.serverId === serverId)
        void removeBackupFromCache(queryClient, serverId, parsed.data.backupId);
      else invalidateBackups();
    } else if (event.type === "schedule.deleted") {
      const parsed = REALTIME_EVENT_PAYLOADS["schedule.deleted"].safeParse(event.data);
      if (parsed.success && parsed.data.serverId === serverId)
        void removeScheduleFromCache(queryClient, serverId, parsed.data.scheduleId);
      else invalidateSchedules();
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
