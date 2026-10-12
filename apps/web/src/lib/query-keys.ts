import type { MetricSeriesId } from "@blockforge/contracts";
import type { AuditFilters, IncidentStatus } from "./api/endpoints";
import type { ServerListFilter } from "./api/servers-api";

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
    allocations: (id: string, filter: "all" | "free" | "used") =>
      ["nodes", "allocations", id, filter] as const,
    allocationsAll: (id: string) => ["nodes", "allocations", id] as const,
  },
  servers: {
    all: ["servers"] as const,
    lists: ["servers", "list"] as const,
    list: (filter: ServerListFilter, q: string) => ["servers", "list", filter, q] as const,
    detail: (id: string) => ["servers", "detail", id] as const,
    placement: (body: unknown) => ["servers", "placement", body] as const,
  },
  /** Per-server sub-resources; `qk.server(id).all` invalidates all of them. */
  server: (id: string) => ({
    all: ["server", id] as const,
    startup: ["server", id, "startup"] as const,
    subusers: ["server", id, "subusers"] as const,
    allocations: ["server", id, "allocations"] as const,
    activity: (filters: AuditFilters) => ["server", id, "activity", filters] as const,
    filesAll: ["server", id, "files"] as const,
    files: (path: string) => ["server", id, "files", path] as const,
    search: (path: string, q: string) => ["server", id, "files-search", path, q] as const,
    file: (path: string) => ["server", id, "file", path] as const,
  }),
  templates: {
    all: ["templates"] as const,
    list: ["templates", "list"] as const,
    detail: (id: string) => ["templates", "detail", id] as const,
  },
  catalog: {
    software: ["catalog", "software"] as const,
    versions: (software: string) => ["catalog", "versions", software] as const,
    builds: (software: string, version: string) => ["catalog", "builds", software, version] as const,
    plan: (software: string, version: string, build: string) =>
      ["catalog", "plan", software, version, build] as const,
  },
  jobs: {
    detail: (id: string) => ["jobs", "detail", id] as const,
    logs: (id: string) => ["jobs", "logs", id] as const,
  },
  account: {
    sshKeys: ["account", "ssh-keys"] as const,
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
