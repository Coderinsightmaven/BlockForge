import { QueryClient, infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { MetricSeriesId } from "@blockforge/contracts";
import { isApiError } from "./api/errors";
import { alertsApi, auditApi, authApi, monitoringApi, nodesApi, rolesApi, usersApi } from "./api/endpoints";
import type { AuditFilters, IncidentStatus } from "./api/endpoints";
import { shareNode, shareNodeList } from "./node-cache";
import {
  accountApi,
  allocationsApi,
  catalogApi,
  filesApi,
  jobsApi,
  serversApi,
  templatesApi,
} from "./api/servers-api";
import type { ServerListFilter } from "./api/servers-api";
import { shareServer, shareServerPages } from "./server-cache";
import { qk } from "./query-keys";
import { refreshIntervalFor, resolveTimeRange, timeRangeKey } from "./time-range";
import type { TimeRange } from "./time-range";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        // Only transient failures are retried; 4xx answers are final.
        retry: (count, err) => (isApiError(err) ? err.isRetryable && count < 2 : count < 1),
      },
      // Mutation results/variables can hold one-time secrets (enrollment tokens, MFA secrets,
      // passwords): never keep them once no component observes the mutation.
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

export const meQuery = queryOptions({
  queryKey: qk.auth.me,
  queryFn: ({ signal }) => authApi.me(signal),
  staleTime: 60_000,
  retry: false,
});

export const setupStatusQuery = queryOptions({
  queryKey: qk.auth.setup,
  queryFn: ({ signal }) => authApi.setupStatus(signal),
  staleTime: 0,
  retry: false,
});

export const overviewQuery = queryOptions({
  queryKey: qk.overview,
  queryFn: ({ signal }) => monitoringApi.overview(signal),
  staleTime: 10_000,
  // Realtime pushes updates; polling is the fallback when the socket is down.
  refetchInterval: 30_000,
});

export const nodesQuery = queryOptions({
  queryKey: qk.nodes.list,
  queryFn: ({ signal }) => nodesApi.list(signal),
  staleTime: 10_000,
  refetchInterval: 30_000,
  // A REST refetch must not replace a newer live sample received over realtime.
  structuralSharing: shareNodeList,
});

export const nodeQuery = (id: string) =>
  queryOptions({
    queryKey: qk.nodes.detail(id),
    queryFn: ({ signal }) => nodesApi.get(id, signal),
    staleTime: 10_000,
    refetchInterval: 30_000,
    structuralSharing: shareNode,
  });

export const enrollmentTokensQuery = queryOptions({
  queryKey: qk.nodes.tokens,
  queryFn: ({ signal }) => nodesApi.listEnrollmentTokens(signal),
  staleTime: 15_000,
});

export const usersQuery = infiniteQueryOptions({
  queryKey: qk.users.list,
  queryFn: ({ signal, pageParam }) => usersApi.list({ limit: 100, cursor: pageParam }, signal),
  initialPageParam: null as string | null,
  getNextPageParam: (last) => last.nextCursor,
  staleTime: 30_000,
});

export const rolesQuery = queryOptions({
  queryKey: qk.roles,
  queryFn: ({ signal }) => rolesApi.list(signal),
  staleTime: 5 * 60_000,
});

export const auditQuery = (filters: AuditFilters) =>
  infiniteQueryOptions({
    queryKey: qk.audit.list(filters),
    queryFn: ({ signal, pageParam }) =>
      auditApi.list({ ...filters, limit: 50, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
  });

export const incidentsQuery = (status: IncidentStatus | "all") =>
  infiniteQueryOptions({
    queryKey: qk.alerts.incidents(status),
    queryFn: ({ signal, pageParam }) =>
      alertsApi.incidents(
        { status: status === "all" ? undefined : status, limit: 50, cursor: pageParam },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

export const alertRulesQuery = queryOptions({
  queryKey: qk.alerts.rules,
  queryFn: ({ signal }) => alertsApi.rules(signal),
  staleTime: 30_000,
});

export const channelsQuery = queryOptions({
  queryKey: qk.alerts.channels,
  queryFn: ({ signal }) => alertsApi.channels(signal),
  staleTime: 30_000,
});

export interface MetricTarget {
  series: MetricSeriesId;
  nodeId?: string;
  serverId?: string;
}

/**
 * Range query for a whitelisted series. Relative ranges re-resolve "now" on every fetch and
 * auto-refresh; the previous result is kept while refetching so charts never flash.
 * Pass `resolved` to pin several queries to the exact same window (aligned steps).
 */
export const metricRangeQuery = (
  target: MetricTarget,
  range: TimeRange,
  resolved?: { from: number; to: number },
) =>
  queryOptions({
    queryKey: [
      ...qk.metrics.range({ ...target, range: timeRangeKey(range) }),
      resolved ? `${resolved.from}-${resolved.to}` : null,
    ] as const,
    queryFn: ({ signal }) => {
      const { from, to } = resolved ?? resolveTimeRange(range);
      return monitoringApi.range({ ...target, from, to }, signal);
    },
    refetchInterval: resolved ? false : refreshIntervalFor(range),
    // Pinned windows roll forward by changing their key; drop superseded windows quickly.
    gcTime: resolved ? 30_000 : 5 * 60_000,
    staleTime: range.kind === "absolute" ? Infinity : 5_000,
    placeholderData: keepPreviousData,
  });

// ---------------------------------------------------------------------------------------------
// Phase 3: servers, templates, catalogue, allocations, files, jobs, account

export const serversQuery = (filter: ServerListFilter, q: string) =>
  infiniteQueryOptions({
    queryKey: qk.servers.list(filter, q),
    queryFn: ({ signal, pageParam }) =>
      serversApi.list({ filter, q: q || undefined, limit: 100, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 10_000,
    // Live state arrives per server over realtime; this is the fallback when the socket is down.
    refetchInterval: 60_000,
    structuralSharing: shareServerPages,
  });

export const serverQuery = (id: string) =>
  queryOptions({
    queryKey: qk.servers.detail(id),
    queryFn: ({ signal }) => serversApi.get(id, signal),
    staleTime: 10_000,
    refetchInterval: 60_000,
    structuralSharing: shareServer,
  });

export const serverStartupQuery = (id: string) =>
  queryOptions({
    queryKey: qk.server(id).startup,
    queryFn: ({ signal }) => serversApi.startup(id, signal),
    staleTime: 15_000,
  });

export const serverSubusersQuery = (id: string) =>
  queryOptions({
    queryKey: qk.server(id).subusers,
    queryFn: ({ signal }) => serversApi.subusers(id, signal),
    staleTime: 15_000,
  });

export const serverAllocationsQuery = (id: string) =>
  queryOptions({
    queryKey: qk.server(id).allocations,
    queryFn: ({ signal }) => serversApi.allocations(id, signal),
    staleTime: 15_000,
  });

export const serverActivityQuery = (id: string, filters: AuditFilters) =>
  infiniteQueryOptions({
    queryKey: qk.server(id).activity(filters),
    queryFn: ({ signal, pageParam }) =>
      serversApi.activity(id, { ...filters, limit: 50, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
  });

export const fileListQuery = (id: string, path: string) =>
  queryOptions({
    queryKey: qk.server(id).files(path),
    queryFn: ({ signal }) => filesApi.list(id, path, signal),
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });

export const fileSearchQuery = (id: string, path: string, q: string) =>
  queryOptions({
    queryKey: qk.server(id).search(path, q),
    queryFn: ({ signal }) => filesApi.search(id, path, q, signal),
    staleTime: 5_000,
  });

export const templatesQuery = queryOptions({
  queryKey: qk.templates.list,
  queryFn: ({ signal }) => templatesApi.list(signal),
  staleTime: 60_000,
});

export const templateQuery = (id: string) =>
  queryOptions({
    queryKey: qk.templates.detail(id),
    queryFn: ({ signal }) => templatesApi.get(id, signal),
    staleTime: 30_000,
  });

/** Upstream catalogue data changes slowly and is cached by the control plane too. */
export const softwareQuery = queryOptions({
  queryKey: qk.catalog.software,
  queryFn: ({ signal }) => catalogApi.software(signal),
  staleTime: 10 * 60_000,
});

export const versionsQuery = (software: string) =>
  queryOptions({
    queryKey: qk.catalog.versions(software),
    queryFn: ({ signal }) => catalogApi.versions(software, signal),
    staleTime: 10 * 60_000,
  });

export const buildsQuery = (software: string, version: string) =>
  queryOptions({
    queryKey: qk.catalog.builds(software, version),
    queryFn: ({ signal }) => catalogApi.builds(software, version, signal),
    staleTime: 5 * 60_000,
  });

export const planQuery = (software: string, version: string, build: string) =>
  queryOptions({
    queryKey: qk.catalog.plan(software, version, build),
    queryFn: ({ signal }) => catalogApi.plan(software, version, build, signal),
    staleTime: 5 * 60_000,
    retry: false,
  });

export const nodeAllocationsQuery = (nodeId: string, filter: "all" | "free" | "used") =>
  infiniteQueryOptions({
    queryKey: qk.nodes.allocations(nodeId, filter),
    // The API filters "free"; "used" is filtered client-side from the full list.
    queryFn: ({ signal, pageParam }) =>
      allocationsApi.listForNode(
        nodeId,
        { free: filter === "free" ? true : undefined, limit: 500, cursor: pageParam },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
  });

export const jobQuery = (id: string) =>
  queryOptions({
    queryKey: qk.jobs.detail(id),
    queryFn: ({ signal }) => jobsApi.get(id, signal),
    staleTime: 2_000,
  });

export const sshKeysQuery = queryOptions({
  queryKey: qk.account.sshKeys,
  queryFn: ({ signal }) => accountApi.sshKeys(signal),
  staleTime: 60_000,
});
