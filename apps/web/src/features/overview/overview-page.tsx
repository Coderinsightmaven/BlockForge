import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, Gamepad2, Server, ServerCog, Users } from "lucide-react";
import { Suspense } from "react";
import type { ReactNode } from "react";
import type { Me, OverviewSummary, ServerState } from "@blockforge/contracts";
import {
  formatBytes,
  formatBytesPerSecond,
  formatCores,
  formatMillicores,
  formatNumber,
  percentOf,
} from "@/lib/format";
import { canAny, hasGlobal } from "@/lib/permissions";
import { overviewQuery } from "@/lib/queries";
import { useOverviewRealtime } from "@/lib/realtime/handlers";
import type { TimeRange } from "@/lib/time-range";
import { retryableLazy } from "@/lib/lazy";

import { TimeRangePicker } from "@/components/charts/time-range-picker";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, NoPermission } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { ChunkBoundary, ChunkError } from "@/components/common/chunk-boundary";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Meter } from "@/components/ui/meter";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ALERT_SEVERITY_META,
  NODE_CONNECTION_META,
  NODE_STATUS_META,
  SERVER_STATE_META,
  StatusDot,
  statusMeta,
} from "@/components/ui/status";
import type { StatusMeta } from "@/components/ui/status";
import { InfoTip } from "@/components/ui/tooltip";
import { useEnrollmentDialog } from "@/features/nodes/enrollment-dialog";
import { CapacityRow, CapacityLegend } from "./capacity";

// Charts sit below the live summary: load uPlot after the summary has painted.
const MetricChart = retryableLazy(() =>
  import("@/components/charts/metric-chart").then((m) => ({ default: m.MetricChart })),
);

function StatTile({
  title,
  icon: Icon,
  value,
  sub,
  breakdown,
  to,
}: {
  title: string;
  icon: typeof Server;
  value: ReactNode;
  sub?: ReactNode;
  breakdown?: Array<{ meta: StatusMeta; count: number }>;
  to?: "/nodes" | "/alerts" | "/servers";
}) {
  const body = (
    <Card className="h-full">
      <CardContent className="flex flex-col gap-2 pt-3.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon className="size-4" aria-hidden />
          {title}
        </div>
        <div className="text-2xl leading-none font-semibold">{value}</div>
        {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
        {breakdown && breakdown.length ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {breakdown.map(({ meta, count }) => (
              <li key={meta.label} className="flex items-center gap-1 text-xs">
                <StatusDot meta={meta} />
                <span className="font-medium tabular">{count}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
  return to ? (
    <Link to={to} className="block rounded-lg hover:ring-1 hover:ring-ring/40">
      {body}
    </Link>
  ) : (
    body
  );
}

function ServersTile({ servers }: { servers: OverviewSummary["servers"] }) {
  const entries = Object.entries(servers.byState)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => ({ meta: statusMeta(SERVER_STATE_META, state as ServerState), count }));
  return (
    <StatTile
      title="Minecraft servers"
      icon={Gamepad2}
      to="/servers"
      value={formatNumber(servers.total, 0)}
      sub={servers.total === 0 ? "No servers yet." : undefined}
      breakdown={entries}
    />
  );
}

function ListCard({ title, info, children }: { title: string; info?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>{title}</CardTitle>
          {info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-3" aria-busy aria-label="Loading overview">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </div>
  );
}

export function OverviewPage({
  me,
  range,
  onRangeChange,
}: {
  me: Me;
  range: TimeRange;
  onRangeChange: (r: TimeRange) => void;
}) {
  const allowed = canAny(me, "monitoring.view");
  useOverviewRealtime(allowed);
  const { data, isPending, error, refetch } = useQuery({ ...overviewQuery, enabled: allowed });
  const enrollment = useEnrollmentDialog();
  const canEnroll = hasGlobal(me, "nodes.enroll");
  const canGlobalCharts = hasGlobal(me, "monitoring.view");

  if (!allowed) return <NoPermission what="view monitoring data" />;

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          data ? (
            <>
              Live summary of everything you can access · updated <Timestamp ts={data.generatedAt} />
            </>
          ) : (
            "Live summary of everything you can access"
          )
        }
      />
      {isPending ? (
        <OverviewSkeleton />
      ) : error && !data ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} title="Could not load the overview" />
        </Card>
      ) : data ? (
        <div className="flex flex-col gap-3">
          {data.nodes.total === 0 ? (
            <Card>
              <EmptyState
                icon={ServerCog}
                title="No nodes enrolled yet"
                description="BlockForge runs Minecraft servers on nodes: machines running the BlockForge agent. Enroll your first node to start collecting real metrics."
                action={
                  canEnroll ? (
                    <Button onClick={enrollment.open}>
                      <ServerCog aria-hidden />
                      Enroll first node
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Ask an administrator with node-enrollment permission.
                    </span>
                  )
                }
              />
            </Card>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              title="Nodes"
              icon={Server}
              to="/nodes"
              value={formatNumber(data.nodes.total, 0)}
              breakdown={[
                { meta: NODE_CONNECTION_META.online, count: data.nodes.online },
                { meta: NODE_CONNECTION_META.degraded, count: data.nodes.degraded },
                { meta: NODE_CONNECTION_META.unreachable, count: data.nodes.unreachable },
                { meta: NODE_CONNECTION_META.offline, count: data.nodes.offline },
                { meta: NODE_STATUS_META.pending, count: data.nodes.pending },
              ].filter((b) => b.count > 0)}
            />
            <ServersTile servers={data.servers} />
            <StatTile
              title="Players online"
              icon={Users}
              value={formatNumber(data.players.online, 0)}
              sub={`Reported by ${data.players.reportingServers} server${data.players.reportingServers === 1 ? "" : "s"}`}
            />
            <StatTile
              title="Active alerts"
              icon={Bell}
              to="/alerts"
              value={formatNumber(
                data.activeAlerts.critical + data.activeAlerts.warning + data.activeAlerts.info,
                0,
              )}
              breakdown={[
                { meta: ALERT_SEVERITY_META.critical, count: data.activeAlerts.critical },
                { meta: ALERT_SEVERITY_META.warning, count: data.activeAlerts.warning },
                { meta: ALERT_SEVERITY_META.info, count: data.activeAlerts.info },
              ]}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-1.5">
                  <CardTitle>CPU</CardTitle>
                  <InfoTip label="About CPU figures">
                    Capacity is the CPU that nodes offer to BlockForge. Allocated is the sum of CPU limits
                    reserved by servers. Usage is what the hosts are actually busy with right now (all
                    processes, weighted by core count).
                  </InfoTip>
                </div>
                <span className="text-xs text-muted-foreground tabular">
                  {formatMillicores(data.cpu.capacityMillicores)} capacity
                </span>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <CapacityRow
                  kind="allocated"
                  label="Allocated to servers"
                  value={formatMillicores(data.cpu.allocatedMillicores)}
                  pct={percentOf(data.cpu.allocatedMillicores, data.cpu.capacityMillicores)}
                />
                <CapacityRow
                  kind="used"
                  label="Actually in use"
                  value={
                    data.cpu.usagePct === null
                      ? "No data"
                      : `≈ ${formatCores(((data.cpu.usagePct / 100) * data.cpu.capacityMillicores) / 1000)}`
                  }
                  pct={data.cpu.usagePct}
                />
                <CapacityLegend />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-1.5">
                  <CardTitle>Memory</CardTitle>
                  <InfoTip label="About memory figures">
                    Allocated is the memory servers are permitted to use (their limits) — a reservation, not
                    consumption. In use is what the node operating systems report as used right now. A server
                    with an 8 GiB limit that uses 2.5 GiB counts 8 GiB allocated but only 2.5 GiB in use.
                    Available is memory the OS can hand out without swapping (free plus reclaimable cache).
                  </InfoTip>
                </div>
                <span className="text-xs text-muted-foreground tabular">
                  {formatBytes(data.memory.totalBytes)} total
                </span>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <CapacityRow
                  kind="allocated"
                  label="Allocated to servers"
                  value={formatBytes(data.memory.allocatedBytes)}
                  pct={percentOf(data.memory.allocatedBytes, data.memory.totalBytes)}
                />
                <CapacityRow
                  kind="used"
                  label="Actually in use"
                  value={data.memory.usedBytes === null ? "No data" : formatBytes(data.memory.usedBytes)}
                  pct={percentOf(data.memory.usedBytes, data.memory.totalBytes)}
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Available</span>
                  <span className="font-medium tabular">
                    {data.memory.availableBytes === null
                      ? "No data"
                      : formatBytes(data.memory.availableBytes)}
                  </span>
                </div>
                {data.memory.totalBytes > 0 && data.memory.allocatedBytes > data.memory.totalBytes ? (
                  <Callout tone="warning">
                    Allocations exceed physical memory by{" "}
                    {formatBytes(data.memory.allocatedBytes - data.memory.totalBytes)} (overcommitted).
                    Servers may be killed if they all use their full limits.
                  </Callout>
                ) : null}
                <CapacityLegend />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ListCard title="Storage" info="Combined capacity and usage of the filesystems nodes report.">
              {data.storage.totalBytes === null ? (
                <p className="text-sm text-muted-foreground">No data</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="text-lg font-semibold">
                    {formatBytes(data.storage.usedBytes)}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      of {formatBytes(data.storage.totalBytes)}
                    </span>
                  </div>
                  <Meter
                    value={percentOf(data.storage.usedBytes, data.storage.totalBytes)}
                    label="Storage used"
                  />
                </div>
              )}
            </ListCard>
            <ListCard
              title="Network"
              info="Current aggregate receive (ingress) and transmit (egress) rate across all node interfaces."
            >
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Ingress (rx)</dt>
                  <dd className="font-semibold tabular">
                    {data.network.rxBytesPerSec === null
                      ? "No data"
                      : formatBytesPerSecond(data.network.rxBytesPerSec)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Egress (tx)</dt>
                  <dd className="font-semibold tabular">
                    {data.network.txBytesPerSec === null
                      ? "No data"
                      : formatBytesPerSecond(data.network.txBytesPerSec)}
                  </dd>
                </div>
              </dl>
            </ListCard>
            <ListCard title="Backup health">
              {data.backups === null ? (
                <p className="text-sm text-muted-foreground">
                  Not configured yet. Backups arrive in Phase 6.
                </p>
              ) : !data.backups.configured ? (
                <p className="text-sm text-muted-foreground">No backup schedule configured.</p>
              ) : (
                <dl className="grid gap-1.5 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Last success</dt>
                    <dd>
                      <Timestamp ts={data.backups.lastSuccessAt} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Failed (24 h)</dt>
                    <dd className={data.backups.failedLast24h > 0 ? "font-semibold text-danger" : "tabular"}>
                      {data.backups.failedLast24h}
                    </dd>
                  </div>
                </dl>
              )}
            </ListCard>
            <ListCard title="Pending updates">
              {data.pendingUpdates === null ? (
                <p className="text-sm text-muted-foreground">
                  Not tracked yet. Software updates arrive in Phase 4.
                </p>
              ) : (
                <div className="text-lg font-semibold tabular">{data.pendingUpdates}</div>
              )}
            </ListCard>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <ListCard title="Recent crashes">
              {data.recentCrashes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No crashes recorded.</p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {data.recentCrashes.map((c) => (
                    <li
                      key={`${c.serverId}-${c.at}`}
                      className="flex items-center justify-between gap-2 py-1.5 text-sm"
                    >
                      <span className="truncate">{c.serverName}</span>
                      <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                        {c.exitCode !== null ? <span className="font-mono">exit {c.exitCode}</span> : null}
                        <Timestamp ts={c.at} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </ListCard>
            <ListCard
              title="Recent failed jobs"
              info="Deployments and other background jobs that failed recently."
            >
              {data.recentFailedJobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No failed jobs.</p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {data.recentFailedJobs.map((j) => (
                    <li key={j.jobId} className="flex flex-col gap-0.5 py-1.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">
                          {j.type}
                          {j.targetName ? (
                            <span className="font-normal text-muted-foreground"> · {j.targetName}</span>
                          ) : null}
                        </span>
                        <Timestamp ts={j.at} className="text-xs text-muted-foreground" />
                      </div>
                      <span className="text-xs break-words text-muted-foreground">{j.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </ListCard>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="history-heading" className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="history-heading" className="text-sm font-semibold">
            History
          </h2>
          <TimeRangePicker value={range} onChange={onRangeChange} />
        </div>
        {canGlobalCharts ? (
          <ChunkBoundary fallback={(retry) => <ChunkError what="the charts" retry={retry} />}>
            <Suspense
              fallback={
                <div className="grid gap-3 xl:grid-cols-2">
                  {Array.from({ length: 4 }, (_, k) => (
                    <Skeleton key={k} className="h-64" />
                  ))}
                </div>
              }
            >
              <div className="grid gap-3 xl:grid-cols-2">
                <MetricChart
                  title="CPU usage"
                  target={{ series: "global.cpu.usage" }}
                  range={range}
                  info="Average utilisation across all nodes, weighted by core count."
                />
                <MetricChart
                  title="Memory"
                  target={{ series: "global.memory" }}
                  range={range}
                  info="Physical memory across nodes. Lines are labelled by kind (e.g. used vs available); allocation is a reservation and is shown separately when reported."
                />
                <MetricChart
                  title="Network throughput"
                  target={{ series: "global.net.throughput" }}
                  range={range}
                  info="Aggregate receive / transmit rate across node interfaces."
                />
                <MetricChart
                  title="Disk throughput"
                  target={{ series: "global.disk.throughput" }}
                  range={range}
                  info="Aggregate read / write rate across node block devices."
                />
                <MetricChart
                  title="Players online"
                  target={{ series: "global.players" }}
                  range={range}
                  info="Players reported by server list pings across all servers."
                />
              </div>
            </Suspense>
          </ChunkBoundary>
        ) : (
          <Card>
            <EmptyState
              compact
              title="Global history needs installation-wide monitoring access"
              description="Your monitoring access is limited to specific nodes; see their detail pages for history."
            />
          </Card>
        )}
      </section>
    </>
  );
}
