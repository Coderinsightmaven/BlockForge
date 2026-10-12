import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Schedule, Server } from "@blockforge/contracts";
import { schedulesApi } from "@/lib/api/phase4-api";
import { describeError } from "@/lib/api/errors";
import { CRON_FIELDS, CRON_PRESETS, isValidTimeZone, presetFor, timeZones } from "@/lib/cron";
import { useApiMutation } from "@/lib/mutations";
import { applyScheduleEvent } from "@/lib/phase4-cache";
import { qk } from "@/lib/query-keys";
import { useDebounced } from "@/lib/use-debounced";
import { PatternHelp } from "@/components/common/pattern-help";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import {
  MAX_OFFSET_SECONDS,
  MAX_TASKS,
  TASK_LABEL,
  draftFromSchedule,
  firstAllowedTask,
  draftToRequest,
  moveTask,
  newTask,
  reorderTask,
  scheduleBlockedReason,
  taskBlockedReason,
} from "./schedule-model";
import type { ScheduleDraft, TaskAction, TaskDraft } from "./schedule-model";

import { RunTime } from "./schedule-ui";

/* The schedule editor dialog (its own chunk, loaded when it is first opened). */

const POWER_OPTIONS = [
  { value: "start" as const, label: "Start" },
  { value: "stop" as const, label: "Stop" },
  { value: "restart" as const, label: "Restart" },
  { value: "kill" as const, label: "Kill" },
];

function CronPreview({ cron, timezone }: { cron: ScheduleDraft["cron"]; timezone: string }) {
  const current = useMemo(() => ({ cron, timezone, count: 5 }), [cron, timezone]);
  const body = useDebounced(current, 400);
  const complete =
    Object.values(current.cron).every((f) => f.trim() !== "") && isValidTimeZone(current.timezone);
  // While typing, the debounced request still describes the previous input: never show its runs
  // (they would be in another zone or for another expression).
  const settled = JSON.stringify(body) === JSON.stringify(current);
  const q = useQuery({
    queryKey: qk.schedules.preview(body),
    queryFn: ({ signal }) => schedulesApi.preview(body, signal),
    enabled: complete && settled,
    staleTime: 30_000,
  });
  if (!complete)
    return <p className="text-xs text-muted-foreground">Fill in every field to see the next runs.</p>;
  if (!settled || q.isPending) return <p className="text-xs text-muted-foreground">Checking…</p>;
  if (q.isError)
    return (
      <p role="alert" className="text-xs text-danger">
        Preview unavailable: {describeError(q.error).title}
      </p>
    );
  const data = q.data;
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

export default function ScheduleEditor({
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
  const firstAllowed = firstAllowedTask(server);
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftFromSchedule(schedule, server.timezone, firstAllowed),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setDraft(draftFromSchedule(schedule, server.timezone, firstAllowed));
    setErrors({});
  }, [open, schedule, server.timezone, firstAllowed]);
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
  // Saving makes you the schedule's last editor: a task you can't run would fail every time.
  const blocked = scheduleBlockedReason(server, draft.tasks);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
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
            <Tooltip content={blocked}>
              <span>
                <Button type="submit" loading={save.isPending} disabled={blocked !== null}>
                  {schedule ? "Save schedule" : "Create schedule"}
                </Button>
              </span>
            </Tooltip>
          </DialogFooter>
          {blocked ? (
            <p role="status" className="text-xs text-muted-foreground">
              Saving is disabled: {blocked} Remove or change that task first.
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
