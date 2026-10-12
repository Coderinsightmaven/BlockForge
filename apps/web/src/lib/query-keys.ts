import type { MetricSeriesId } from "@blockforge/contracts";
import type { AuditFilters, IncidentStatus } from "./api/endpoints";

/**
 * Query keys, hierarchical so a prefix invalidates a whole area
 * (e.g. `invalidateQueries({ queryKey: qk.nodes.all })`).
 */
export const qk = {
  auth: {
    me: ["auth", "me"] as const,
    setup: ["auth", "setup"] as const,
  },
  overview: ["overview"] as const,
  nodes: {
    all: ["nodes"] as const,
    list: ["nodes", "list"] as const,
    detail: (id: string) => ["nodes", "detail", id] as const,
    tokens: ["nodes", "enrollment-tokens"] as const,
  },
  metrics: {
    all: ["metrics"] as const,
    range: (p: { series: MetricSeriesId; nodeId?: string; serverId?: string; range: string }) =>
      ["metrics", p.series, p.nodeId ?? null, p.serverId ?? null, p.range] as const,
  },
  users: {
    all: ["users"] as const,
    list: ["users", "list"] as const,
  },
  roles: ["roles"] as const,
  audit: {
    all: ["audit"] as const,
    list: (filters: AuditFilters) => ["audit", "list", filters] as const,
    verify: ["audit", "verify"] as const,
  },
  alerts: {
    all: ["alerts"] as const,
    incidents: (status: IncidentStatus | "all") => ["alerts", "incidents", status] as const,
    rules: ["alerts", "rules"] as const,
    channels: ["alerts", "channels"] as const,
  },
};
