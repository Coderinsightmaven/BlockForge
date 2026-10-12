import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Gamepad2, LayoutGrid, Plus, Rows3, Search, Users } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { Me, Server } from "@blockforge/contracts";
import { formatBytes } from "@/lib/format";
import { serversQuery } from "@/lib/queries";
import { useServerListRealtime } from "@/lib/realtime/server-handlers";
import { canCreateServers, canSeeAllServers } from "@/lib/server-permissions";
import { cpuView, memoryView, playersView } from "@/lib/server-metrics";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Meter } from "@/components/ui/meter";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerStateBadge } from "@/components/ui/status";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SpacerRow, VirtualTable, useVirtualRows } from "@/components/ui/virtual-table";
import { ServerAddress } from "./server-common";
import { serverCardSnapshot, softwareLabel } from "./server-card-snapshot";

export type ServersView = "cards" | "table";

/** Cards render every loaded server; beyond this the table (virtualised) is used. */
export const MAX_CARDS = 200;

function ServerCardView({ server }: { server: Server }) {
  const cpu = cpuView(server.latest, server.cpuLimitMillicores);
  const mem = memoryView(server);
  const players = playersView(server);
  return (
    <Card className="flex min-w-0 flex-col gap-2.5 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to="/servers/$serverId"
            params={{ serverId: server.id }}
            className="block truncate font-medium hover:underline"
          >
            {server.name}
          </Link>
          <div className="truncate text-xs text-muted-foreground">
            {softwareLabel(server)} · {server.nodeName}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ServerStateBadge state={server.state} />
          {server.suspended ? <Badge tone="danger">Suspended</Badge> : null}
        </div>
      </div>
      <ServerAddress server={server} />
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div className="flex flex-col gap-1">
          <span className="flex justify-between text-muted-foreground">
            CPU <span className="text-foreground tabular">{cpu.text}</span>
          </span>
          {cpu.pctOfLimit !== null ? (
            <Meter value={cpu.pctOfLimit} label={`CPU of ${server.name}`} showValue={false} />
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <span className="flex justify-between gap-1 text-muted-foreground">
            Memory{" "}
            <span className="truncate text-foreground tabular">
              {formatBytes(mem.used)} / {formatBytes(mem.limit)}
            </span>
          </span>
          <Meter value={mem.pct} label={`Memory of ${server.name}`} showValue={false} />
        </div>
      </div>
      {players ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5" aria-hidden />
          <span className="tabular">
            {players.online} / {players.max} players
          </span>
        </div>
      ) : null}
    </Card>
  );
}

/** Re-renders only when something the card shows changed (see serverCardSnapshot). */
const ServerCard = memo(
  ServerCardView,
  (a, b) => a.server === b.server || serverCardSnapshot(a.server) === serverCardSnapshot(b.server),
);

function ServersTable({ servers, onVisible }: { servers: Server[]; onVisible: (ids: string[]) => void }) {
  const v = useVirtualRows(servers, { estimateSize: 53, getKey: (s) => s.id });
  const visibleKey = v.items.map((i) => servers[i.index]?.id).join(",");
  useEffect(() => onVisible(visibleKey ? visibleKey.split(",") : []), [visibleKey, onVisible]);
  return (
    <VirtualTable scrollRef={v.scrollRef} rowCount={servers.length}>
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow className="hover:bg-transparent" aria-rowindex={1}>
          <TableHead>Server</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Address</TableHead>
          <TableHead>CPU</TableHead>
          <TableHead>Memory</TableHead>
          <TableHead>Players</TableHead>
          <TableHead>Node</TableHead>
          <TableHead>Owner</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <SpacerRow height={v.padTop} colSpan={8} />
        {v.items.map((vi) => {
          const s = servers[vi.index]!;
          const cpu = cpuView(s.latest, s.cpuLimitMillicores);
          const mem = memoryView(s);
          const players = playersView(s);
          return (
            <TableRow
              key={vi.key}
              ref={v.virtualizer.measureElement}
              data-index={vi.index}
              aria-rowindex={vi.index + 2}
            >
              <TableCell className="max-w-64">
                <Link
                  to="/servers/$serverId"
                  params={{ serverId: s.id }}
                  className="font-medium hover:underline"
                >
                  {s.name}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{softwareLabel(s)}</div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <ServerStateBadge state={s.state} />
                  {s.suspended ? <Badge tone="danger">Suspended</Badge> : null}
                </div>
              </TableCell>
              <TableCell>
                <ServerAddress server={s} />
              </TableCell>
              <TableCell className="min-w-32 text-xs">
                {cpu.pctOfLimit !== null ? (
                  <Meter value={cpu.pctOfLimit} label={`CPU of ${s.name}`} />
                ) : (
                  cpu.text
                )}
              </TableCell>
              <TableCell className="min-w-32">
                <Meter value={mem.pct} label={`Memory of ${s.name}`} />
                <div className="text-[11px] text-muted-foreground">
                  {formatBytes(mem.used)} / {formatBytes(mem.limit)}
                </div>
              </TableCell>
              <TableCell className="text-xs">
                {players ? `${players.online} / ${players.max}` : "—"}
              </TableCell>
              <TableCell className="text-xs">{s.nodeName}</TableCell>
              <TableCell className="text-xs">{s.ownerName}</TableCell>
            </TableRow>
          );
        })}
        <SpacerRow height={v.padBottom} colSpan={8} />
      </TableBody>
    </VirtualTable>
  );
}

export function ServersPage({
  me,
  filter,
  q,
  view,
  onChange,
}: {
  me: Me;
  filter: "mine" | "all";
  q: string;
  view: ServersView;
  onChange: (patch: { filter?: "mine" | "all"; q?: string; view?: ServersView }) => void;
}) {
  const allowAll = canSeeAllServers(me);
  const effectiveFilter = allowAll ? filter : "mine";
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => onChange({ q: draft }), 250);
    return () => clearTimeout(t);
  }, [draft, q, onChange]);

  const query = useInfiniteQuery(serversQuery(effectiveFilter, q));
  const servers = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const asTable = view === "table" || servers.length > MAX_CARDS;
  const [tableVisible, setTableVisible] = useState<string[]>([]);
  const liveIds = useMemo(
    () => (asTable ? tableVisible : servers.map((s) => s.id)),
    [asTable, tableVisible, servers],
  );
  useServerListRealtime(liveIds, true);

  return (
    <>
      <PageHeader
        title="Game Servers"
        description={
          effectiveFilter === "mine"
            ? "Servers you own or have been given access to."
            : "Every server you can see."
        }
        actions={
          canCreateServers(me) ? (
            <Button asChild>
              <Link to="/servers/new">
                <Plus aria-hidden />
                Create server
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {allowAll ? (
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Which servers">
            {(["mine", "all"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={effectiveFilter === f}
                onClick={() => onChange({ filter: f })}
                className={cn(
                  "h-7 rounded-sm px-2.5 text-xs text-muted-foreground hover:text-foreground",
                  effectiveFilter === f && "bg-accent font-medium text-foreground",
                )}
              >
                {f === "mine" ? "My servers" : "All servers"}
              </button>
            ))}
          </div>
        ) : null}
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search servers…"
            aria-label="Search servers"
            className="pl-8"
            maxLength={80}
          />
        </div>
        <div className="ml-auto flex rounded-md border p-0.5" role="group" aria-label="Layout">
          {(
            [
              ["cards", LayoutGrid, "Cards"],
              ["table", Rows3, "Table"],
            ] as const
          ).map(([v, Icon, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={(asTable ? "table" : "cards") === v}
              title={label}
              onClick={() => onChange({ view: v })}
              className={cn(
                "inline-flex h-7 items-center rounded-sm px-1.5 text-muted-foreground hover:text-foreground",
                (asTable ? "table" : "cards") === v && "bg-accent text-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden />
              <span className="sr-only">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {query.isPending ? (
        view === "table" ? (
          <Card>
            <TableSkeleton columns={6} />
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        )
      ) : query.isError && !query.data ? (
        <Card>
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            title="Could not load servers"
          />
        </Card>
      ) : servers.length === 0 ? (
        <Card>
          <EmptyState
            icon={Gamepad2}
            title={q ? "No servers match your search" : "No servers yet"}
            description={
              q
                ? undefined
                : canCreateServers(me)
                  ? "Create a Minecraft server or any game from an imported egg."
                  : "When someone gives you access to a server, it appears here."
            }
            action={
              !q && canCreateServers(me) ? (
                <Button asChild>
                  <Link to="/servers/new">Create your first server</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : asTable ? (
        <Card>
          <ServersTable servers={servers} onVisible={setTableVisible} />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
        </div>
      )}
      {query.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more servers
          </Button>
        </div>
      ) : null}
    </>
  );
}
