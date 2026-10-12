import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  GripVertical,
  History,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Schedule, ScheduleRun, Server } from "@blockforge/contracts";
import { schedulesApi } from "@/lib/api/phase4-api";
import { describeError } from "@/lib/api/errors";
import {
  CRON_FIELDS,
  CRON_PRESETS,
  cronString,
  describeCron,
  formatInZone,
  isValidTimeZone,
  presetFor,
  timeZones,
} from "@/lib/cron";
import { localTimeZone } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { applyScheduleEvent } from "@/lib/phase4-cache";
import { qk } from "@/lib/query-keys";
import { serverActionable, serverCan } from "@/lib/server-permissions";
import { PatternHelp } from "@/components/common/pattern-help";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusBadge, statusMeta } from "@/components/ui/status";
import type { StatusMeta } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { JobProgress } from "../server-common";
import {
  MAX_OFFSET_SECONDS,
  MAX_TASKS,
  TASK_LABEL,
  draftFromSchedule,
  draftToRequest,
  moveTask,
  newTask,
  reorderTask,
  scheduleToRequest,
  taskBlockedReason,
  taskSummary,
} from "./schedule-model";
import type { ScheduleDraft, TaskAction, TaskDraft } from "./schedule-model";

// ---------------------------------------------------------------------------------------------
// Presentation

export const RUN_STATUS_META: Record<ScheduleRun["status"], StatusMeta> = {
  running: {
    label: "Running",
    tone: "info",
    icon: RefreshCw,
    description: "The run is executing its tasks.",
  },
  succeeded: { label: "Succeeded", tone: "success", icon: CircleCheck, description: "Every task completed." },
  failed: {
    label: "Failed",
    tone: "danger",
    icon: CircleX,
    description: "A task failed and the run stopped (unless it was set to continue).",
  },
  skipped: {
    label: "Skipped",
    tone: "neutral",
    icon: CircleSlash,
    description: "The run did not start, e.g. the server was offline and the schedule only runs when online.",
  },
};

const TASK_STATUS_META: Record<ScheduleRun["tasks"][number]["status"], StatusMeta> = {
  pending: { label: "Pending", tone: "neutral", icon: CircleDashed, description: "Not started." },
  running: RUN_STATUS_META.running,
  succeeded: { ...RUN_STATUS_META.succeeded, description: "The task completed." },
  failed: { ...RUN_STATUS_META.failed, description: "The task failed." },
  skipped: { ...RUN_STATUS_META.skipped, description: "Not run (an earlier task failed)." },
};

const POWER_OPTIONS = [
  { value: "start" as const, label: "Start" },
  { value: "stop" as const, label: "Stop" },
  { value: "restart" as const, label: "Restart" },
  { value: "kill" as const, label: "Kill" },
];

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

/** A run time in the schedule's zone, plus the viewer's local time when that differs. */
export function RunTime({ ts, timezone }: { ts: number | null; timezone: string }) {
  if (ts === null) return <span className="text-muted-foreground">—</span>;
  const local = localTimeZone();
  return (
    <span className="flex flex-col">
      <span className="tabular">{formatInZone(ts, timezone)}</span>
      {local !== timezone ? (
        <span className="text-[11px] text-muted-foreground tabular">your time {formatInZone(ts, local)}</span>
      ) : null}
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
// Editor

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function CronPreview({ cron, timezone }: { cron: ScheduleDraft["cron"]; timezone: string }) {
  const body = useDebounced(
    useMemo(() => ({ cron, timezone, count: 5 }), [cron, timezone]),
    400,
  );
  const complete = Object.values(body.cron).every((f) => f.trim() !== "") && isValidTimeZone(body.timezone);
  const q = useQuery({
    queryKey: qk.schedules.preview(body),
    queryFn: ({ signal }) => schedulesApi.preview(body, signal),
    enabled: complete,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  if (!complete)
    return <p className="text-xs text-muted-foreground">Fill in every field to see the next runs.</p>;
  if (q.isError)
    return (
      <p role="alert" className="text-xs text-danger">
        Preview unavailable: {describeError(q.error).title}
      </p>
    );
  const data = q.data;
  if (!data) return <p className="text-xs text-muted-foreground">Checking…</p>;
  if (!data.valid)
    return (
      <p role="alert" className="text-xs text-danger">
        {data.error ?? "This cron expression is not valid."}
      </p>
    );
  return (
    <div className="flex flex-col gap-1 text-xs" aria-live="polite">
      {data.description ? <p className="font-medium">{data.description}</p> : null}
      <p className="text-muted-foreground">Next runs:</p>
      <ol className="flex flex-col gap-0.5">
        {data.next.map((ts) => (
          <li key={ts}>
            <RunTime ts={ts} timezone={body.timezone} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function TaskEditor({
  server,
  task,
  index,
  count,
  errors,
  onChange,
  onMove,
  onRemove,
  dragProps,
}: {
  server: Server;
  task: TaskDraft;
  index: number;
  count: number;
  errors: Record<string, string>;
  onChange: (t: TaskDraft) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  dragProps: Record<string, unknown>;
}) {
  const set = <K extends keyof TaskDraft>(k: K, v: TaskDraft[K]) => onChange({ ...task, [k]: v });
  const blocked = taskBlockedReason(server, task.action);
  const err = (f: string) => errors[`tasks.${index}.${f}`];
  const n = index + 1;
  return (
    <li className="flex flex-col gap-3 rounded-md border p-3" {...dragProps}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="cursor-grab text-muted-foreground" title="Drag to reorder" aria-hidden>
          <GripVertical className="size-4" />
        </span>
        <span className="text-xs font-semibold">Task {n}</span>
        <Select<TaskAction>
          value={task.action}
          onValueChange={(v) => set("action", v)}
          aria-label={`Task ${n} type`}
          className="w-48"
          options={(["command", "power", "backup"] as const).map((a) => ({
            value: a,
            label: TASK_LABEL[a],
            disabled: a !== task.action && taskBlockedReason(server, a) !== null,
          }))}
        />
        <div className="ml-auto flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Move task ${n} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Move task ${n} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Remove task ${n}`} onClick={onRemove}>
            <X aria-hidden />
          </Button>
        </div>
      </div>
      {blocked ? <Callout tone="warning">{blocked}</Callout> : null}
      {task.action === "command" ? (
        <Field
          label="Command"
          error={err("command")}
          hint="Sent to the console, e.g. say Restarting in 5 minutes"
        >
          <Input
            value={task.command}
            onChange={(e) => set("command", e.target.value)}
            className="font-mono"
            maxLength={1024}
            spellCheck={false}
          />
        </Field>
      ) : null}
      {task.action === "power" ? (
        <Field label="Power action">
          <Select value={task.power} onValueChange={(v) => set("power", v)} options={POWER_OPTIONS} />
        </Field>
      ) : null}
      {task.action === "backup" ? (
        <div className="flex flex-col gap-2">
          <Field label="Ignore" error={err("ignore")} hint="One pattern per line (optional).">
            <Textarea
              value={task.ignore}
              onChange={(e) => set("ignore", e.target.value)}
              rows={2}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
          <PatternHelp />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={task.rotate} onCheckedChange={(v) => set("rotate", v)} />
            Rotate out the oldest unlocked backup at the limit
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        <Field
          label={index === 0 ? "Wait before (seconds)" : "Wait after the previous task (seconds)"}
          error={err("offsetSeconds")}
          className="w-56"
        >
          <Input
            type="number"
            min={0}
            max={MAX_OFFSET_SECONDS}
            value={task.offsetSeconds}
            onChange={(e) => set("offsetSeconds", e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={task.continueOnFailure} onCheckedChange={(v) => set("continueOnFailure", v)} />
          Continue with the next task if this one fails
        </label>
      </div>
    </li>
  );
}

function ScheduleEditor({
  server,
  schedule,
  open,
  onClose,
}: {
  server: Server;
  schedule: Schedule | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFromSchedule(schedule, server.timezone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setDraft(draftFromSchedule(schedule, server.timezone));
    setErrors({});
  }, [open, schedule, server.timezone]);
  const zones = useMemo(() => timeZones(), []);
  const save = useApiMutation({
    mutationFn: (body: Parameters<typeof schedulesApi.create>[1]) =>
      schedule ? schedulesApi.update(server.id, schedule.id, body) : schedulesApi.create(server.id, body),
    success: schedule ? "Schedule saved" : "Schedule created",
    errorTitle: schedule ? "Could not save the schedule" : "Could not create the schedule",
    onSuccess: (s) => {
      applyScheduleEvent(queryClient, s);
      void queryClient.invalidateQueries({ queryKey: qk.server(server.id).schedules });
      onClose();
    },
  });
  const set = <K extends keyof ScheduleDraft>(k: K, v: ScheduleDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const setTasks = (tasks: TaskDraft[]) => set("tasks", tasks);
  const firstAllowed = (["command", "power", "backup"] as const).find(
    (a) => taskBlockedReason(server, a) === null,
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { request, errors: next } = draftToRequest(draft);
    setErrors(next);
    if (request) save.mutate(request);
  };
  const preset = presetFor(draft.cron);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-3xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{schedule ? `Edit “${schedule.name}”` : "New schedule"}</DialogTitle>
            <DialogDescription>
              Tasks run in order; each waits its delay after the previous one. Tasks use the permissions of
              whoever saves the schedule.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" error={errors.name} required>
            <Input
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              maxLength={80}
              autoFocus
            />
          </Field>
          <fieldset className="flex flex-col gap-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">When</legend>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Presets">
              {CRON_PRESETS.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={preset === p.id ? "default" : "outline"}
                  aria-pressed={preset === p.id}
                  onClick={() => set("cron", { ...p.cron })}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {CRON_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint} error={errors[`cron.${f.key}`]}>
                  <Input
                    value={draft.cron[f.key]}
                    onChange={(e) => set("cron", { ...draft.cron, [f.key]: e.target.value })}
                    className="font-mono"
                    maxLength={64}
                    spellCheck={false}
                  />
                </Field>
              ))}
            </div>
            <Field
              label="Time zone"
              error={errors.timezone}
              hint={`The server's zone is ${server.timezone}.`}
              className="max-w-sm"
            >
              <Input
                value={draft.timezone}
                onChange={(e) => set("timezone", e.target.value)}
                list="schedule-time-zones"
                spellCheck={false}
              />
            </Field>
            <datalist id="schedule-time-zones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <CronPreview cron={draft.cron} timezone={draft.timezone.trim()} />
          </fieldset>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={draft.onlyWhenOnline} onCheckedChange={(v) => set("onlyWhenOnline", v)} />
              Only when the server is running (skip the run otherwise)
            </label>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">
              Tasks{" "}
              <span className="font-normal text-muted-foreground">
                ({draft.tasks.length} / {MAX_TASKS})
              </span>
            </legend>
            {errors.tasks ? (
              <p role="alert" className="text-xs text-danger">
                {errors.tasks}
              </p>
            ) : null}
            <ol className="flex flex-col gap-2">
              {draft.tasks.map((t, i) => (
                <TaskEditor
                  key={t.key}
                  server={server}
                  task={t}
                  index={i}
                  count={draft.tasks.length}
                  errors={errors}
                  onChange={(next) => setTasks(draft.tasks.map((x, j) => (j === i ? next : x)))}
                  onMove={(delta) => setTasks(moveTask(draft.tasks, i, delta))}
                  onRemove={() => setTasks(draft.tasks.filter((_, j) => j !== i))}
                  dragProps={{
                    draggable: true,
                    onDragStart: () => setDragFrom(i),
                    onDragOver: (e: DragEvent) => e.preventDefault(),
                    onDrop: (e: DragEvent) => {
                      e.preventDefault();
                      if (dragFrom !== null) setTasks(reorderTask(draft.tasks, dragFrom, i));
                      setDragFrom(null);
                    },
                    onDragEnd: () => setDragFrom(null),
                  }}
                />
              ))}
            </ol>
            <Tooltip
              content={
                draft.tasks.length >= MAX_TASKS
                  ? `A schedule has at most ${MAX_TASKS} tasks.`
                  : !firstAllowed
                    ? "You can't create any task type on this server."
                    : null
              }
            >
              <span className="self-start">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={draft.tasks.length >= MAX_TASKS || !firstAllowed}
                  onClick={() => firstAllowed && setTasks([...draft.tasks, newTask(firstAllowed)])}
                >
                  <Plus aria-hidden />
                  Add task
                </Button>
              </span>
            </Tooltip>
          </fieldset>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {schedule ? "Save schedule" : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Run history

function RunsDialog({
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
            <JobProgress key={job} jobId={job} title="Task job" />
            <Button size="sm" variant="ghost" className="self-end" onClick={() => setJob(null)}>
              Hide job
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Tab

export default function SchedulesTab({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ schedule: Schedule | null } | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const q = useQuery({
    queryKey: qk.server(server.id).schedules,
    queryFn: ({ signal }) => schedulesApi.list(server.id, signal),
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
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: qk.server(server.id).schedules });
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
          <Button size="sm" onClick={() => setEditing({ schedule: null })}>
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
                  <Switch
                    checked={s.enabled}
                    aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                    disabled={toggle.isPending && toggle.variables?.id === s.id}
                    onCheckedChange={() => toggle.mutate(s)}
                    className="mr-2"
                  />
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
      <ScheduleEditor
        server={server}
        schedule={editing?.schedule ?? null}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
      <RunsDialog
        server={server}
        schedule={schedules.find((s) => s.id === historyId) ?? null}
        onClose={() => setHistoryId(null)}
      />
      <ConfirmDialog
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
