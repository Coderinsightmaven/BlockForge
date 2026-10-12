import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { useMemo, useState } from "react";
import type { AuditEvent, Server } from "@blockforge/contracts";
import { formatTimestamp } from "@/lib/format";
import { serverActivityQuery } from "@/lib/queries";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AUDIT_OUTCOME_META, StatusBadge, statusMeta } from "@/components/ui/status";
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SpacerRow, VirtualTable, useVirtualRows } from "@/components/ui/virtual-table";

function actor(e: AuditEvent): string {
  if (e.actorType === "system") return "System";
  if (e.actorType === "node") return `Node ${e.actorName ?? ""}`.trim();
  return e.actorName ?? e.actorId ?? e.actorType;
}

export default function ActivityTab({ server }: { server: Server }) {
  const q = useInfiniteQuery(serverActivityQuery(server.id, {}));
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const v = useVirtualRows(items, { estimateSize: 45, getKey: (e) => e.id });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Activity</CardTitle>
          <CardDescription>
            Power, console, file (including SFTP), startup and user changes on this server. Newest first.
          </CardDescription>
        </div>
      </CardHeader>
      {q.isPending ? (
        <TableSkeleton columns={4} rows={6} />
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load activity" />
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} title="No activity yet" compact />
      ) : (
        <>
          <VirtualTable scrollRef={v.scrollRef} rowCount={items.length}>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent" aria-rowindex={1}>
                <TableHead className="w-8">
                  <span className="sr-only">Details</span>
                </TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <tbody>
              <SpacerRow height={v.padTop} colSpan={5} />
            </tbody>
            {v.items.map((vi) => {
              const e = items[vi.index]!;
              const expanded = open.has(e.id);
              return (
                <tbody
                  key={vi.key}
                  ref={v.virtualizer.measureElement}
                  data-index={vi.index}
                  className="border-b"
                >
                  <TableRow className="border-0" aria-rowindex={vi.index + 2}>
                    <TableCell className="px-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-expanded={expanded}
                        aria-label={expanded ? "Hide details" : "Show details"}
                        onClick={() =>
                          setOpen((s) => {
                            const n = new Set(s);
                            if (n.has(e.id)) n.delete(e.id);
                            else n.add(e.id);
                            return n;
                          })
                        }
                      >
                        {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                      </Button>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatTimestamp(e.at)}</TableCell>
                    <TableCell className="text-xs">{actor(e)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell>
                      <StatusBadge meta={statusMeta(AUDIT_OUTCOME_META, e.outcome)} />
                    </TableCell>
                  </TableRow>
                  {expanded ? (
                    <TableRow className="border-0 bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={4}>
                        {/* Rendered as text: details may contain user-controlled strings (file names, commands). */}
                        <pre className="max-h-72 overflow-auto rounded-md border bg-card p-2 font-mono text-xs break-all whitespace-pre-wrap">
                          {JSON.stringify({ ip: e.ip, requestId: e.requestId, ...e.details }, null, 2)}
                        </pre>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </tbody>
              );
            })}
            <tbody>
              <SpacerRow height={v.padBottom} colSpan={5} />
            </tbody>
          </VirtualTable>
          {q.hasNextPage ? (
            <div className="flex justify-center border-t p-2">
              <Button
                size="sm"
                variant="outline"
                loading={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                Load older activity
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
