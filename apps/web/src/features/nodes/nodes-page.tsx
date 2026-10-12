import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Search, ServerCog } from "lucide-react";
import { useMemo } from "react";
import type { Me, Node } from "@blockforge/contracts";
import { formatBytes, formatMillicores, percentOf } from "@/lib/format";
import { canAny, hasGlobal } from "@/lib/permissions";
import { nodesQuery } from "@/lib/queries";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, NoPermission, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Meter } from "@/components/ui/meter";
import { NodeConnectionBadge, NodeStatusBadge } from "@/components/ui/status";
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useSort,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InfoTip } from "@/components/ui/tooltip";
import { useEnrollmentDialog } from "./enrollment-dialog";
import { EnrollmentTokens } from "./enrollment-tokens";
import { dataFilesystem, fsUsedPct, memoryUsedPct } from "./node-utils";
import { NodeWarningBadge } from "./node-warnings";

export type NodesTab = "nodes" | "tokens";

const accessors = {
  name: (n: Node) => n.name,
  status: (n: Node) => n.status,
  connection: (n: Node) => n.connection,
  location: (n: Node) => n.location,
  cpu: (n: Node) => n.latest?.cpu.usagePct ?? null,
  memory: (n: Node) => memoryUsedPct(n.latest),
  disk: (n: Node) => fsUsedPct(dataFilesystem(n)),
  allocated: (n: Node) => percentOf(n.capacity.memoryReservedBytes, n.capacity.memoryAllocatableBytes),
  servers: (n: Node) => n.serverCount,
  agent: (n: Node) => n.agentVersion,
  heartbeat: (n: Node) => n.lastHeartbeatAt,
};

export function matchesNodeQuery(n: Node, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [n.name, n.slug, n.facts?.hostname, n.location, n.publicAddress, n.privateAddress, ...n.tags]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

function NodesTable({ nodes, q }: { nodes: Node[]; q: string }) {
  const filtered = useMemo(() => nodes.filter((n) => matchesNodeQuery(n, q)), [nodes, q]);
  const { sorted, sort, toggle } = useSort(filtered, accessors, { key: "name", direction: "asc" });
  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={Search}
        compact
        title="No nodes match your search"
        description={`Nothing matches “${q}”.`}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortableHead column="name" sort={sort} onSort={toggle}>
            Name
          </SortableHead>
          <SortableHead column="status" sort={sort} onSort={toggle}>
            Status
          </SortableHead>
          <SortableHead column="connection" sort={sort} onSort={toggle}>
            Connection
          </SortableHead>
          <SortableHead column="location" sort={sort} onSort={toggle}>
            Location
          </SortableHead>
          <TableHead>Tags</TableHead>
          <SortableHead column="cpu" sort={sort} onSort={toggle}>
            CPU
          </SortableHead>
          <SortableHead column="memory" sort={sort} onSort={toggle}>
            Memory
          </SortableHead>
          <SortableHead column="disk" sort={sort} onSort={toggle}>
            Disk
          </SortableHead>
          <SortableHead column="allocated" sort={sort} onSort={toggle}>
            <span className="inline-flex items-center gap-1">Allocated</span>
          </SortableHead>
          <SortableHead column="servers" sort={sort} onSort={toggle} align="right">
            Servers
          </SortableHead>
          <SortableHead column="agent" sort={sort} onSort={toggle}>
            Agent
          </SortableHead>
          <SortableHead column="heartbeat" sort={sort} onSort={toggle}>
            Last heartbeat
          </SortableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((n) => {
          const fs = dataFilesystem(n);
          return (
            <TableRow key={n.id}>
              <TableCell className="max-w-56">
                <Link
                  to="/nodes/$nodeId"
                  params={{ nodeId: n.id }}
                  className="font-medium text-foreground hover:underline"
                >
                  {n.name}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{n.facts?.hostname ?? n.slug}</div>
              </TableCell>
              <TableCell>
                <NodeStatusBadge status={n.status} />
              </TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <NodeConnectionBadge connection={n.connection} />
                  <NodeWarningBadge warnings={n.warnings} />
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {n.location ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>
                <div className="flex max-w-48 flex-wrap gap-1">
                  {n.tags.length ? (
                    n.tags.map((t) => (
                      <Badge key={t} variant="outline">
                        {t}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="min-w-32">
                <Meter value={n.latest?.cpu.usagePct} label={`CPU usage of ${n.name}`} />
              </TableCell>
              <TableCell className="min-w-32">
                <Meter value={memoryUsedPct(n.latest)} label={`Memory usage of ${n.name}`} />
              </TableCell>
              <TableCell
                className="min-w-32"
                title={
                  fs
                    ? `${fs.mount}: ${formatBytes(fs.usedBytes)} of ${formatBytes(fs.totalBytes)}`
                    : undefined
                }
              >
                <Meter value={fsUsedPct(fs)} label={`Disk usage of ${n.name}`} />
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap">
                <div>
                  {formatBytes(n.capacity.memoryReservedBytes)}{" "}
                  <span className="text-muted-foreground">
                    / {formatBytes(n.capacity.memoryAllocatableBytes)}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {formatMillicores(n.capacity.cpuReservedMillicores)} /{" "}
                  {formatMillicores(n.capacity.cpuAllocatableMillicores)}
                </div>
              </TableCell>
              <TableCell className="text-right">{n.serverCount}</TableCell>
              <TableCell className="font-mono text-xs whitespace-nowrap">{n.agentVersion ?? "—"}</TableCell>
              <TableCell className="text-xs">
                <Timestamp ts={n.lastHeartbeatAt} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function NodesPage({
  me,
  tab,
  q,
  onTabChange,
  onQueryChange,
}: {
  me: Me;
  tab: NodesTab;
  q: string;
  onTabChange: (t: NodesTab) => void;
  onQueryChange: (q: string) => void;
}) {
  const allowed = canAny(me, "nodes.view");
  const canEnroll = hasGlobal(me, "nodes.enroll");
  const enrollment = useEnrollmentDialog();
  const { data, isPending, error, refetch } = useQuery({ ...nodesQuery, enabled: allowed });
  if (!allowed) return <NoPermission what="view nodes" />;

  return (
    <>
      <PageHeader
        title="Nodes & Infrastructure"
        description="Machines running the BlockForge agent, their health and capacity."
        actions={
          canEnroll ? (
            <Button onClick={enrollment.open}>
              <ServerCog aria-hidden />
              Enroll node
            </Button>
          ) : null
        }
      />
      <Tabs value={canEnroll ? tab : "nodes"} onValueChange={(v) => onTabChange(v as NodesTab)}>
        <TabsList>
          <TabsTrigger value="nodes">Nodes{data ? ` (${data.length})` : ""}</TabsTrigger>
          {canEnroll ? <TabsTrigger value="tokens">Enrollment tokens</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="nodes">
          <Card>
            <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
              <div className="relative w-full max-w-xs">
                <Search
                  className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={q}
                  onChange={(e) => onQueryChange(e.target.value)}
                  placeholder="Search name, host, location, tag…"
                  aria-label="Search nodes"
                  className="pl-8"
                />
              </div>
              <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                Allocated = reserved by servers / allocatable
                <InfoTip label="About allocated capacity">
                  Memory (first line) and CPU (second line) that servers on the node have reserved, out of
                  what the node offers to BlockForge. This is a reservation, not measured usage — the CPU,
                  Memory and Disk bars show actual usage.
                </InfoTip>
              </span>
            </div>
            {isPending ? (
              <TableSkeleton columns={8} />
            ) : error && !data ? (
              <ErrorState error={error} onRetry={() => void refetch()} title="Could not load nodes" />
            ) : data && data.length === 0 ? (
              <EmptyState
                icon={ServerCog}
                title="No nodes yet"
                description="Enroll a machine to start running servers and collecting metrics."
                action={canEnroll ? <Button onClick={enrollment.open}>Enroll first node</Button> : undefined}
              />
            ) : data ? (
              <NodesTable nodes={data} q={q} />
            ) : null}
          </Card>
        </TabsContent>
        {canEnroll ? (
          <TabsContent value="tokens">
            <EnrollmentTokens nodes={data ?? []} />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}
