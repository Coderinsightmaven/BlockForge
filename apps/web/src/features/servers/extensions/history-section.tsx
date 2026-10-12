import { useInfiniteQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useState } from "react";
import type { Server } from "@blockforge/contracts";
import { extensionsApi } from "@/lib/api/extensions-api";
import { useIdempotencyKeys } from "@/lib/idempotency";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { LazyConfirmDialog } from "@/components/common/lazy-confirm-dialog";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { HISTORY_ACTION_LABEL, ROLLBACK_UNAVAILABLE, historyChange } from "./extension-model";

/* Plugins & mods → History with rollback (its own chunk, loaded when the section is opened). */

export default function HistorySection({
  server,
  canManage,
  onJob,
}: {
  server: Server;
  canManage: boolean;
  onJob: (jobId: string, title: string) => void;
}) {
  const [confirm, setConfirm] = useState<{ id: string; name: string; change: string } | null>(null);
  const q = useInfiniteQuery({
    queryKey: qk.server(server.id).extensionHistory,
    queryFn: ({ signal, pageParam }) =>
      extensionsApi.history(server.id, { limit: 25, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const keys = useIdempotencyKeys<string>();
  const rollback = useApiMutation({
    mutationFn: (entryId: string) => extensionsApi.rollback(server.id, entryId, keys.sent(entryId)),
    success: "Rollback started",
    errorTitle: "Could not roll back",
    onError: (error, id) => keys.settle(id, { ok: false, error }),
    onSuccess: (r, id) => {
      keys.settle(id, { ok: true });
      setConfirm(null);
      onJob(r.jobId, "Rolling back");
    },
  });
  const entries = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isPending) return <TableSkeleton columns={5} rows={4} />;
  if (q.isError)
    return (
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        title="Could not load the history"
        compact
      />
    );
  if (entries.length === 0) return <EmptyState icon={History} title="No changes yet" compact />;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Rollback</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs whitespace-nowrap">
                  <Timestamp ts={e.at} />
                </TableCell>
                <TableCell className="max-w-96 text-sm">
                  <span className="font-medium">{HISTORY_ACTION_LABEL[e.action]}</span>{" "}
                  <span className="break-words">{e.extensionName}</span>
                  <span className="block text-xs text-muted-foreground tabular">{historyChange(e)}</span>
                </TableCell>
                <TableCell className="text-xs">
                  {e.actor.name ??
                    (e.actor.type === "system"
                      ? "System"
                      : e.actor.type === "schedule"
                        ? "A schedule"
                        : "Unknown")}
                  {e.actor.type === "api_token" ? (
                    <span className="text-muted-foreground"> (API key)</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs">
                  {e.status === "succeeded" ? (
                    <Badge tone="success">Succeeded</Badge>
                  ) : (
                    <>
                      <Badge tone="danger">Failed</Badge>
                      {e.error ? (
                        <span className="mt-0.5 block break-words text-danger">{e.error}</span>
                      ) : null}
                    </>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Tooltip
                      content={
                        e.rollback.available
                          ? null
                          : e.rollback.reason
                            ? ROLLBACK_UNAVAILABLE[e.rollback.reason]
                            : null
                      }
                    >
                      <span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!e.rollback.available}
                          aria-label={`Roll back: ${HISTORY_ACTION_LABEL[e.action]} ${e.extensionName}`}
                          onClick={() =>
                            setConfirm({ id: e.id, name: e.extensionName, change: historyChange(e) })
                          }
                        >
                          Roll back
                        </Button>
                      </span>
                    </Tooltip>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {q.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          loading={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load older changes
        </Button>
      ) : null}
      <LazyConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Roll back this change?"
        description={`“${confirm?.name ?? ""}” goes back (${confirm?.change ?? ""}, reversed). Takes effect at the next server start.${
          keys.isLocked(confirm?.id ?? "")
            ? " The previous request's outcome is unknown; confirming retries the same request."
            : ""
        }`}
        confirmLabel="Roll back"
        pending={rollback.isPending}
        onConfirm={() => confirm && rollback.mutate(confirm.id)}
      />
    </div>
  );
}
