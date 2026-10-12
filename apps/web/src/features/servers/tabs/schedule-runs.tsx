import { useInfiniteQuery } from "@tanstack/react-query";
import { CircleDashed, History } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Schedule, ScheduleRun, Server } from "@blockforge/contracts";
import { schedulesApi } from "@/lib/api/phase4-api";
import { formatInZone } from "@/lib/cron";
import { qk } from "@/lib/query-keys";
import { serverCan } from "@/lib/server-permissions";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge, statusMeta } from "@/components/ui/status";
import type { StatusMeta } from "@/components/ui/status";
import { TASK_LABEL } from "./schedule-model";

import { LazyJobProgress } from "../lazy-job-progress";
import { RUN_STATUS_META } from "./schedule-ui";

/* A schedule's run history dialog (its own chunk, loaded when it is first opened). */

const TASK_STATUS_META: Record<ScheduleRun["tasks"][number]["status"], StatusMeta> = {
  pending: { label: "Pending", tone: "neutral", icon: CircleDashed, description: "Not started." },
  running: RUN_STATUS_META.running,
  succeeded: { ...RUN_STATUS_META.succeeded, description: "The task completed." },
  failed: { ...RUN_STATUS_META.failed, description: "The task failed." },
  skipped: { ...RUN_STATUS_META.skipped, description: "Not run (an earlier task failed)." },
};

export default function RunsDialog({
  server,
  schedule,
  onClose,
}: {
  server: Server;
  schedule: Schedule | null;
  onClose: () => void;
}) {
  const [job, setJob] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: qk.server(server.id).scheduleRuns(schedule?.id ?? ""),
    queryFn: ({ signal, pageParam }) =>
      schedulesApi.runs(server.id, schedule!.id, { limit: 20, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: schedule !== null,
    // Live while a run executes (task statuses change between schedule events).
    refetchInterval: schedule?.running ? 3_000 : false,
  });
  const runs = q.data?.pages.flatMap((p) => p.items) ?? [];
  const canSeeJobs = serverCan(server, "jobs.view");
  // A run started or finished (live schedule.updated): reload the history.
  const refetch = q.refetch;
  const marker = schedule ? `${schedule.id}:${schedule.lastRunAt}:${schedule.running}` : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const prev = seen.current;
    seen.current = marker;
    // Only a change while open (not the first render, not a different schedule).
    if (prev !== null && marker !== null && prev.split(":")[0] === marker.split(":")[0] && prev !== marker)
      void refetch();
  }, [marker, refetch]);
  return (
    <Dialog open={schedule !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Runs of “{schedule?.name ?? ""}”</DialogTitle>
          <DialogDescription>Newest first. Times in {schedule?.timezone ?? ""}.</DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <TableSkeleton columns={3} rows={3} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load runs" compact />
        ) : runs.length === 0 ? (
          <EmptyState icon={History} title="No runs yet" compact />
        ) : (
          <ol className="flex flex-col gap-2">
            {runs.map((r) => (
              <li key={r.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge meta={statusMeta(RUN_STATUS_META, r.status)} />
                  <Badge variant="outline">{r.trigger === "manual" ? "Run now" : "Scheduled"}</Badge>
                  <span className="text-xs tabular">{formatInZone(r.startedAt, schedule?.timezone)}</span>
                  {r.reason ? <span className="text-xs text-muted-foreground">{r.reason}</span> : null}
                </div>
                {r.tasks.length ? (
                  <ol className="mt-2 flex flex-col gap-1">
                    {r.tasks.map((t) => (
                      <li key={t.index} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="w-14 text-muted-foreground">Task {t.index + 1}</span>
                        <StatusBadge meta={statusMeta(TASK_STATUS_META, t.status)} />
                        <span>{TASK_LABEL[t.action]}</span>
                        {t.message ? (
                          <span className="break-words text-muted-foreground">{t.message}</span>
                        ) : null}
                        {t.jobId && canSeeJobs ? (
                          <Button
                            size="sm"
                            variant="link"
                            className="h-auto p-0 text-xs"
                            onClick={() => setJob(t.jobId)}
                          >
                            View job
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {q.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-center"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            Load older runs
          </Button>
        ) : null}
        {job ? (
          <div className="flex flex-col gap-2">
            <LazyJobProgress jobId={job} title="Task job" />
            <Button size="sm" variant="ghost" className="self-end" onClick={() => setJob(null)}>
              Hide job
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
