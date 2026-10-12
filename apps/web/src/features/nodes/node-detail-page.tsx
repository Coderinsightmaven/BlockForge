import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, MapPin, Tag } from "lucide-react";
import { useState } from "react";
import type { Me, Node } from "@blockforge/contracts";
import { isApiError } from "@/lib/api/errors";
import { can, canAny } from "@/lib/permissions";
import { nodeQuery } from "@/lib/queries";
import { useNodeDetailRealtime } from "@/lib/realtime/handlers";
import type { TimeRange } from "@/lib/time-range";
import { MetricChart } from "@/components/charts/metric-chart";
import { TimeRangePicker } from "@/components/charts/time-range-picker";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, NoPermission } from "@/components/common/states";
import { Timestamp, useNow } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { NodeConnectionBadge, NodeStatusBadge } from "@/components/ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApproveNodeDialog, NodeActions } from "./node-actions";
import { CapacityFacts, FilesystemFacts, InterfacesFacts, RuntimeFacts, SystemFacts } from "./node-facts";
import { CpuTile, DiskIoTile, FilesystemsTile, MemoryTile, NetworkTile } from "./node-live";
import { NodeAllocations } from "./node-allocations";
import { NODE_CHARTS } from "./node-charts";
import { NodeSettings } from "./node-settings";
import { isStale } from "./node-utils";
import { NodeWarnings } from "./node-warnings";

export type NodeTab = "overview" | "metrics" | "allocations" | "settings";

export function PendingBanner({ node, canManage }: { node: Node; canManage: boolean }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Callout
        tone="warning"
        title="Waiting for approval"
        className="mb-4"
        action={
          canManage ? (
            <Button size="sm" onClick={() => setConfirming(true)}>
              Approve…
            </Button>
          ) : undefined
        }
      >
        {node.name} enrolled with a token that requires approval. It is connected but receives no workloads
        until an administrator approves it. Verify the hostname and addresses below match a machine you
        enrolled.
      </Callout>
      {canManage ? <ApproveNodeDialog node={node} open={confirming} onOpenChange={setConfirming} /> : null}
    </>
  );
}

export function NodeDetailPage({
  me,
  nodeId,
  tab,
  range,
  onTabChange,
  onRangeChange,
}: {
  me: Me;
  nodeId: string;
  tab: NodeTab;
  range: TimeRange;
  onTabChange: (t: NodeTab) => void;
  onRangeChange: (r: TimeRange) => void;
}) {
  const scope = { type: "node" as const, id: nodeId };
  const allowed = can(me, "nodes.view", scope);
  const canManage = can(me, "nodes.manage", scope);
  const canMetrics = can(me, "monitoring.view", scope) || canAny(me, "monitoring.view");
  useNodeDetailRealtime(nodeId, allowed);
  const now = useNow();
  const { data: node, isPending, error, refetch } = useQuery({ ...nodeQuery(nodeId), enabled: allowed });

  if (!allowed) return <NoPermission what="view this node" />;
  if (isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy aria-label="Loading node">
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-60" />
          <Skeleton className="h-60" />
        </div>
      </div>
    );
  }
  if (!node) {
    if (isApiError(error) && error.code === "NOT_FOUND") {
      return (
        <EmptyState
          title="Node not found"
          description="It may have been deleted, or you may not have access to it."
          action={
            <Button asChild variant="outline">
              <Link to="/nodes">Back to nodes</Link>
            </Button>
          }
        />
      );
    }
    return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load node" />;
  }

  const sample = node.latest;
  const stale = sample ? isStale(sample.ts, now) : true;

  return (
    <>
      <Link
        to="/nodes"
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Nodes
      </Link>
      <PageHeader
        title={
          <>
            <span className="truncate">{node.name}</span>
            <NodeStatusBadge status={node.status} />
            <NodeConnectionBadge connection={node.connection} />
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-xs">{node.facts?.hostname ?? node.slug}</span>
            {node.location ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden />
                {node.location}
              </span>
            ) : null}
            {node.tags.length ? (
              <span className="inline-flex flex-wrap items-center gap-1">
                <Tag className="size-3.5" aria-hidden />
                {node.tags.map((t) => (
                  <Badge key={t} variant="outline">
                    {t}
                  </Badge>
                ))}
              </span>
            ) : null}
            <span>
              Last heartbeat <Timestamp ts={node.lastHeartbeatAt} />
            </span>
          </span>
        }
        actions={canManage ? <NodeActions node={node} /> : null}
      />
      <NodeWarnings warnings={node.warnings} />
      {node.status === "pending" ? <PendingBanner node={node} canManage={canManage} /> : null}
      {node.status === "revoked" ? (
        <Callout tone="danger" title="Revoked" className="mb-4">
          This node's credentials were revoked. It cannot connect; delete it once it no longer hosts servers.
        </Callout>
      ) : null}

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as NodeTab)}>
        <TabsList>
          <TabsTrigger value="overview">Live</TabsTrigger>
          <TabsTrigger value="metrics" disabled={!canMetrics}>
            History
          </TabsTrigger>
          <TabsTrigger value="allocations">Allocations</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            {sample ? (
              <>
                Last sample <Timestamp ts={sample.ts} /> ({<Timestamp ts={sample.ts} mode="absolute" />})
                {stale ? (
                  <Badge tone="warning">Stale — the agent is not reporting</Badge>
                ) : (
                  <Badge tone="success">Live</Badge>
                )}
              </>
            ) : (
              <Badge tone="neutral">No recent metrics — the agent has not reported a sample recently</Badge>
            )}
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <CpuTile sample={sample} logicalCores={node.facts?.cpuLogicalCores ?? null} />
            <MemoryTile sample={sample} />
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <FilesystemsTile sample={sample} dataRoot={node.facts?.dataRoot} />
            <DiskIoTile sample={sample} />
          </div>
          <NetworkTile sample={sample} />
          <div className="grid gap-3 xl:grid-cols-2">
            <SystemFacts node={node} />
            <div className="flex flex-col gap-3">
              <CapacityFacts node={node} />
              <RuntimeFacts node={node} />
            </div>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <InterfacesFacts node={node} />
            <FilesystemFacts node={node} />
          </div>
        </TabsContent>

        <TabsContent value="metrics">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Historical samples from the metrics store. Gaps mean the agent was not reporting.
            </p>
            <TimeRangePicker value={range} onChange={onRangeChange} />
          </div>
          {tab === "metrics" ? (
            <div className="grid gap-3 xl:grid-cols-2">
              {NODE_CHARTS.map((c) => (
                <MetricChart
                  key={c.series}
                  title={c.title}
                  info={c.info}
                  target={{ series: c.series, nodeId: node.id }}
                  range={range}
                />
              ))}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="allocations">
          {tab === "allocations" ? (
            <NodeAllocations node={node} canManage={can(me, "allocations.manage", scope)} />
          ) : null}
        </TabsContent>

        <TabsContent value="settings">
          <NodeSettings node={node} canManage={canManage} />
        </TabsContent>
      </Tabs>
      {!sample && node.connection === "online" ? (
        <Card className="mt-3 p-3 text-xs text-muted-foreground">
          The agent is connected but has not sent metrics yet. The first sample normally arrives within 10
          seconds.
        </Card>
      ) : null}
    </>
  );
}
