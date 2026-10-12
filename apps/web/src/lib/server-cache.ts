import { replaceEqualDeep } from "@tanstack/react-query";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { Page, Server, WorkloadMetricSample } from "@blockforge/contracts";
import { qk } from "./query-keys";

/*
 * Server DTOs reach the cache from REST (list, detail, mutation responses), `server.updated`
 * events and `server.metrics` samples. Two rules:
 *  - the newest `latest` sample wins (a REST read can be older than the live sample);
 *  - per-user fields (`myPermissions`, `sftp`) of an event payload are not trusted over the
 *    cached REST values, because a broadcast DTO may have been computed for another user.
 */

export function mergeServerLatest(incoming: Server, cached: Server | undefined): Server {
  const keep = cached?.latest;
  if (!keep || cached.id !== incoming.id) return incoming;
  if (incoming.latest && incoming.latest.ts >= keep.ts) return incoming;
  return { ...incoming, latest: keep };
}

export function shareServer(oldData: unknown, newData: unknown): unknown {
  return replaceEqualDeep(oldData, mergeServerLatest(newData as Server, oldData as Server | undefined));
}

export function shareServerPages(oldData: unknown, newData: unknown): unknown {
  const prev = oldData as InfiniteData<Page<Server>> | undefined;
  const next = newData as InfiniteData<Page<Server>>;
  if (!prev) return next;
  const byId = new Map(prev.pages.flatMap((p) => p.items).map((s) => [s.id, s]));
  const merged = {
    ...next,
    pages: next.pages.map((p) => ({ ...p, items: p.items.map((s) => mergeServerLatest(s, byId.get(s.id))) })),
  };
  return replaceEqualDeep(prev, merged);
}

type ServerPatch = (s: Server) => Server;

/** Apply `patch` to a server wherever it is cached (detail + every list page). */
export function patchServerInCache(queryClient: QueryClient, id: string, patch: ServerPatch): void {
  queryClient.setQueryData<Server>(qk.servers.detail(id), (s) => (s ? patch(s) : s));
  queryClient.setQueriesData<InfiniteData<Page<Server>>>({ queryKey: qk.servers.lists }, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((p) => {
      const i = p.items.findIndex((s) => s.id === id);
      if (i === -1) return p;
      changed = true;
      const items = p.items.slice();
      items[i] = patch(items[i]!);
      return { ...p, items };
    });
    return changed ? { ...data, pages } : data;
  });
}

/** A full DTO from REST (mutation response): trust it, but keep a newer live sample. */
export function upsertServerInCache(queryClient: QueryClient, server: Server): void {
  patchServerInCache(queryClient, server.id, (cached) => mergeServerLatest(server, cached));
  if (!queryClient.getQueryData(qk.servers.detail(server.id))) {
    queryClient.setQueryData(qk.servers.detail(server.id), server);
  }
}

/** `server.updated` payload: per-user fields are not broadcast (contracts `REALTIME_EVENT_PAYLOADS`). */
export type ServerBroadcast = Omit<Server, "myPermissions" | "sftp">;

/** A `server.updated` event: keep the cached per-user fields and a newer sample. */
export function applyServerEvent(queryClient: QueryClient, server: ServerBroadcast): void {
  patchServerInCache(queryClient, server.id, (cached) =>
    mergeServerLatest({ ...server, myPermissions: cached.myPermissions, sftp: cached.sftp }, cached),
  );
}

export function applyServerSample(queryClient: QueryClient, id: string, sample: WorkloadMetricSample): void {
  patchServerInCache(queryClient, id, (s) =>
    !s.latest || s.latest.ts <= sample.ts ? { ...s, latest: sample } : s,
  );
}
