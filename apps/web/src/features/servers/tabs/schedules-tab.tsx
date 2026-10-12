import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, History, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Schedule, Server } from "@blockforge/contracts";
import { schedulesApi } from "@/lib/api/phase4-api";
import { cronString, describeCron } from "@/lib/cron";
import { useApiMutation } from "@/lib/mutations";
import { applyScheduleEvent, reconcileList, removeScheduleFromCache } from "@/lib/phase4-cache";
import { qk } from "@/lib/query-keys";
import { serverActionable } from "@/lib/server-permissions";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, statusMeta } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { scheduleBlockedReason, scheduleToRequest, taskSummary } from "./schedule-model";

import { retryableLazy } from "@/lib/lazy";
import { LazyConfirmDialog } from "@/components/common/lazy-confirm-dialog";
import { LazyDialog } from "@/components/common/lazy-dialog";
import { RUN_STATUS_META, RunTime } from "./schedule-ui";

// The editor (cron preview, task forms, selects) and the run history are dialogs: their own chunks,
// prefetched on hover/focus of the buttons that open them.
const ScheduleEditor = retryableLazy(() => import("./schedule-editor"));
const RunsDialog = retryableLazy(() => import("./schedule-runs"));

// ---------------------------------------------------------------------------------------------
// Presentation

/** "Every day at 04:00" or the raw expression. */
function CronLabel({ schedule }: { schedule: Pick<Schedule, "cron" | "timezone"> }) {
  const words = describeCron(schedule.cron);
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <span>{words ?? "Custom schedule"}</span>
      <code className="font-mono text-[11px] text-muted-foreground">{cronString(schedule.cron)}</code>
    </span>
  );
}

/** Most recent finished run, from the schedule itself (`lastRunStatus`, kept live by schedule.updated). */
function LastRun({ schedule }: { schedule: Schedule }) {
  if (schedule.lastRunAt === null) return <span className="text-xs text-muted-foreground">Never run</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {schedule.lastRunStatus ? (
        <StatusBadge meta={statusMeta(RUN_STATUS_META, schedule.lastRunStatus)} />
      ) : null}
      <Timestamp ts={schedule.lastRunAt} />
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Tab

export default function SchedulesTab({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ schedule: Schedule | null } | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  // The dialogs stay mounted once opened (closing animates, the editor resets on open).
  const [editorUsed, setEditorUsed] = useState(false);
  const [runsUsed, setRunsUsed] = useState(false);
  if (editing !== null && !editorUsed) setEditorUsed(true);
  if (historyId !== null && !runsUsed) setRunsUsed(true);
  const prefetchEditor = () => void ScheduleEditor.preload();
  const prefetchRuns = () => void RunsDialog.preload();
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const q = useQuery({
    queryKey: qk.server(server.id).schedules,
    queryFn: async ({ signal }) =>
      reconcileList(queryClient, "schedules", server.id, await schedulesApi.list(server.id, signal)),
  });
  const canManage = serverActionable(server, "schedules.manage");
  const toggle = useApiMutation({
    mutationFn: (s: Schedule) =>
      schedulesApi.update(server.id, s.id, scheduleToRequest(s, { enabled: !s.enabled })),
    success: (s) => (s.enabled ? `${s.name} enabled` : `${s.name} disabled`),
    errorTitle: "Could not change the schedule",
    onSuccess: (s) => applyScheduleEvent(queryClient, s),
  });
  const run = useApiMutation({
    mutationFn: (s: Schedule) => schedulesApi.run(server.id, s.id),
    success: (_r, s) => `${s.name} started`,
    errorTitle: "Could not run the schedule",
    onSuccess: async (_r, s) => {
      await queryClient.invalidateQueries({ queryKey: qk.server(server.id).scheduleRunsAll(s.id) });
      await queryClient.invalidateQueries({ queryKey: qk.server(server.id).schedules });
    },
  });
  const remove = useApiMutation({
    mutationFn: (s: Schedule) => schedulesApi.remove(server.id, s.id),
    success: "Schedule deleted",
    errorTitle: "Could not delete the schedule",
    onSuccess: async (_r, s) => {
      setRemoving(null);
      await removeScheduleFromCache(queryClient, server.id, s.id);
    },
  });
  const schedules = [...(q.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Schedules</CardTitle>
          <CardDescription>
            Recurring tasks — console commands, power actions and backups — on a cron schedule.
          </CardDescription>
        </div>
        {canManage ? (
          <Button
            size="sm"
            onClick={() => setEditing({ schedule: null })}
            onPointerEnter={prefetchEditor}
            onFocus={prefetchEditor}
          >
            <Plus aria-hidden />
            New schedule
          </Button>
        ) : null}
      </CardHeader>
      {q.isPending ? (
        <TableSkeleton columns={4} rows={3} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Could not load schedules"
          compact
        />
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules"
          description={canManage ? "Automate restarts, announcements and backups." : undefined}
          compact
        />
      ) : (
        <ul className="flex flex-col divide-y border-t">
          {schedules.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 px-4 py-3 lg:flex-row lg:items-start lg:gap-6">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  {!s.enabled ? <Badge tone="neutral">Disabled</Badge> : null}
                  {s.running ? (
                    <Badge tone="info">
                      <RefreshCw aria-hidden className="motion-safe:animate-spin" />
                      Running
                    </Badge>
                  ) : null}
                  {s.onlyWhenOnline ? <Badge variant="outline">Only when online</Badge> : null}
                </div>
                <div className="text-sm">
                  <CronLabel schedule={s} />
                </div>
                <ol className="list-decimal pl-5 text-xs text-muted-foreground">
                  {s.tasks.map((t, i) => (
                    <li key={i} className="break-words">
                      {taskSummary(t)}
                    </li>
                  ))}
                </ol>
              </div>
              <dl className="grid shrink-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs lg:w-80">
                <dt className="text-muted-foreground">Next run</dt>
                <dd>{s.enabled ? <RunTime ts={s.nextRunAt} timezone={s.timezone} /> : "—"}</dd>
                <dt className="text-muted-foreground">Last run</dt>
                <dd>
                  <LastRun schedule={s} />
                </dd>
                <dt className="text-muted-foreground">Zone</dt>
                <dd>{s.timezone}</dd>
              </dl>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {canManage ? (
                  <Tooltip content={scheduleBlockedReason(server, s.tasks)}>
                    <span className="mr-2 inline-flex">
                      <Switch
                        checked={s.enabled}
                        aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                        disabled={
                          (toggle.isPending && toggle.variables?.id === s.id) ||
                          scheduleBlockedReason(server, s.tasks) !== null
                        }
                        onCheckedChange={() => toggle.mutate(s)}
                      />
                    </span>
                  </Tooltip>
                ) : null}
                {canManage ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Run ${s.name} now`}
                    disabled={s.running}
                    loading={run.isPending && run.variables?.id === s.id}
                    onClick={() => run.mutate(s)}
                  >
                    <Play aria-hidden />
                    Run now
                  </Button>
                ) : null}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Run history of ${s.name}`}
                  onClick={() => setHistoryId(s.id)}
                  onPointerEnter={prefetchRuns}
                  onFocus={prefetchRuns}
                >
                  <History aria-hidden />
                </Button>
                {canManage ? (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Edit ${s.name}`}
                      onClick={() => setEditing({ schedule: s })}
                      onPointerEnter={prefetchEditor}
                      onFocus={prefetchEditor}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${s.name}`}
                      onClick={() => setRemoving(s)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editorUsed ? (
        <LazyDialog
          title={editing?.schedule ? "Edit schedule" : "New schedule"}
          open={editing !== null}
          onClose={() => setEditing(null)}
        >
          <ScheduleEditor
            server={server}
            schedule={editing?.schedule ?? null}
            open={editing !== null}
            onClose={() => setEditing(null)}
          />
        </LazyDialog>
      ) : null}
      {runsUsed ? (
        <LazyDialog title="Run history" open={historyId !== null} onClose={() => setHistoryId(null)}>
          <RunsDialog
            server={server}
            schedule={schedules.find((s) => s.id === historyId) ?? null}
            onClose={() => setHistoryId(null)}
          />
        </LazyDialog>
      ) : null}
      <LazyConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Delete schedule?"
        description={`“${removing?.name ?? ""}” and its run history are deleted. Backups it created are kept.`}
        confirmLabel="Delete schedule"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  );
}
