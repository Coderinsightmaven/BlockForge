import { QueryClient, infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { MetricSeriesId } from "@blockforge/contracts";
import { isApiError } from "./api/errors";
import { alertsApi, auditApi, authApi, monitoringApi, nodesApi, rolesApi, usersApi } from "./api/endpoints";
import type { AuditFilters, IncidentStatus } from "./api/endpoints";
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
      mutations: { retry: false },
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
});

export const nodeQuery = (id: string) =>
  queryOptions({
    queryKey: qk.nodes.detail(id),
    queryFn: ({ signal }) => nodesApi.get(id, signal),
    staleTime: 10_000,
    refetchInterval: 30_000,
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
