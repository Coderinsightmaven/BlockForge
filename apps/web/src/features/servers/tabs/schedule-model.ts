import { UpsertScheduleRequest } from "@blockforge/contracts";
import type { Permission, Schedule, ScheduleCron, ScheduleTask, Server } from "@blockforge/contracts";
import type { z } from "zod";
import { linesToList } from "@/components/common/pattern-help";
import { isValidTimeZone } from "@/lib/cron";
import { serverCan } from "@/lib/server-permissions";

/*
 * Schedule editor state ↔ `UpsertScheduleRequest`. Pure, so the rules (task permissions, ordering,
 * the 20-task cap, validation messages) are unit-tested without rendering the editor.
 */

export type TaskAction = ScheduleTask["action"];
export type PowerTaskAction = Extract<ScheduleTask, { action: "power" }>["power"];
export type UpsertSchedule = z.input<typeof UpsertScheduleRequest>;

export const MAX_TASKS = 20;
export const MAX_OFFSET_SECONDS = 900;

/** Tasks run with the permissions of the schedule's last editor, checked at run time. */
export const TASK_PERMISSION: Record<TaskAction, Permission> = {
  command: "servers.console.send",
  power: "servers.control",
  backup: "servers.backups.create",
};

export const TASK_LABEL: Record<TaskAction, string> = {
  command: "Send console command",
  power: "Power action",
  backup: "Create backup",
};

/** Why the current user cannot add/keep a working task of this type (null = fine). */
export function taskBlockedReason(
  server: Pick<Server, "myPermissions" | "backupLimit">,
  action: TaskAction,
): string | null {
  const permission = TASK_PERMISSION[action];
  if (!serverCan(server, permission)) {
    return `You don't hold ${permission} on this server. Tasks run with the permissions of whoever saved the schedule last, so this task would fail.`;
  }
  if (action === "backup" && server.backupLimit === 0) return "Backups are disabled for this server.";
  return null;
}

const TASK_ACTIONS: readonly TaskAction[] = ["command", "power", "backup"];

/** The first task type this user can actually run here (new schedules/tasks start with it). */
export function firstAllowedTask(server: Pick<Server, "myPermissions" | "backupLimit">): TaskAction | null {
  return TASK_ACTIONS.find((a) => taskBlockedReason(server, a) === null) ?? null;
}

/**
 * Why saving (or enabling) this schedule is refused for the current user: saving makes them the
 * last editor, and a task they can't run would fail on every run. Null when every task is fine.
 */
export function scheduleBlockedReason(
  server: Pick<Server, "myPermissions" | "backupLimit">,
  tasks: ReadonlyArray<{ action: TaskAction }>,
): string | null {
  for (const [i, t] of tasks.entries()) {
    const reason = taskBlockedReason(server, t.action);
    if (reason) return `Task ${i + 1}: ${reason}`;
  }
  return null;
}

export interface TaskDraft {
  key: string;
  action: TaskAction;
  command: string;
  power: PowerTaskAction;
  /** Backup ignore patterns, one per line. */
  ignore: string;
  rotate: boolean;
  offsetSeconds: string;
  continueOnFailure: boolean;
}

export interface ScheduleDraft {
  name: string;
  cron: ScheduleCron;
  timezone: string;
  enabled: boolean;
  onlyWhenOnline: boolean;
  tasks: TaskDraft[];
}

let keySeq = 0;
const newKey = () => `t${++keySeq}`;

export function newTask(action: TaskAction): TaskDraft {
  return {
    key: newKey(),
    action,
    command: "",
    power: "restart",
    ignore: "",
    rotate: true,
    offsetSeconds: "0",
    continueOnFailure: false,
  };
}

function taskToDraft(t: ScheduleTask): TaskDraft {
  const base = newTask(t.action);
  const common = { offsetSeconds: String(t.offsetSeconds), continueOnFailure: t.continueOnFailure };
  if (t.action === "command") return { ...base, ...common, command: t.command };
  if (t.action === "power") return { ...base, ...common, power: t.power };
  return { ...base, ...common, ignore: t.ignore.join("\n"), rotate: t.rotate };
}

export function draftFromSchedule(
  schedule: Schedule | null,
  serverTimezone: string,
  firstTask: TaskAction | null = "command",
): ScheduleDraft {
  if (!schedule) {
    return {
      name: "",
      cron: { minute: "0", hour: "4", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
      timezone: serverTimezone,
      enabled: true,
      onlyWhenOnline: false,
      tasks: firstTask ? [newTask(firstTask)] : [],
    };
  }
  return {
    name: schedule.name,
    cron: { ...schedule.cron },
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    onlyWhenOnline: schedule.onlyWhenOnline,
    tasks: schedule.tasks.map(taskToDraft),
  };
}

/** Move the task at `from` one step up (-1) or down (+1); out-of-range moves are no-ops. */
export function moveTask<T>(tasks: readonly T[], from: number, delta: -1 | 1): T[] {
  const to = from + delta;
  if (from < 0 || from >= tasks.length || to < 0 || to >= tasks.length) return [...tasks];
  const next = [...tasks];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Move by drag and drop: the item at `from` ends up at index `to`. */
export function reorderTask<T>(tasks: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= tasks.length || to < 0 || to >= tasks.length) return [...tasks];
  const next = [...tasks];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function taskInput(d: TaskDraft): unknown {
  const offset = d.offsetSeconds.trim() === "" ? 0 : Number(d.offsetSeconds);
  const common = { offsetSeconds: offset, continueOnFailure: d.continueOnFailure };
  if (d.action === "command") return { action: "command", command: d.command, ...common };
  if (d.action === "power") return { action: "power", power: d.power, ...common };
  return { action: "backup", ignore: linesToList(d.ignore), rotate: d.rotate, ...common };
}

const FIELD_MESSAGES: Record<string, string> = {
  name: "Give the schedule a name (at most 80 characters).",
  command: "Enter a single-line command (at most 1024 characters).",
  offsetSeconds: `Whole seconds between 0 and ${MAX_OFFSET_SECONDS}.`,
  ignore: "At most 100 patterns of 512 characters.",
};

/**
 * Validate the editor state against the contract. Errors are keyed `name`, `timezone`,
 * `cron.<field>`, `tasks` and `tasks.<index>.<field>`.
 */
export function draftToRequest(draft: ScheduleDraft): {
  request: UpsertSchedule | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const input = {
    name: draft.name,
    cron: draft.cron,
    timezone: draft.timezone.trim(),
    enabled: draft.enabled,
    onlyWhenOnline: draft.onlyWhenOnline,
    tasks: draft.tasks.map(taskInput),
  };
  if (!isValidTimeZone(input.timezone))
    errors.timezone = "Unknown time zone (use an IANA name such as Europe/Berlin).";
  if (draft.tasks.length === 0) errors.tasks = "Add at least one task.";
  if (draft.tasks.length > MAX_TASKS) errors.tasks = `At most ${MAX_TASKS} tasks.`;
  const parsed = UpsertScheduleRequest.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      let key = path.join(".");
      if (path[0] === "tasks" && path.length >= 3) key = `tasks.${path[1]}.${path[2]}`;
      else if (path[0] === "tasks") key = "tasks";
      const field = path[path.length - 1] ?? "";
      errors[key] ??= path[0] === "cron" ? "Invalid cron field." : (FIELD_MESSAGES[field] ?? issue.message);
    }
  }
  return { request: Object.keys(errors).length === 0 && parsed.success ? parsed.data : null, errors };
}

/** The request that saves `schedule` unchanged except for `patch` (e.g. the enabled toggle). */
export function scheduleToRequest(schedule: Schedule, patch: Partial<UpsertSchedule> = {}): UpsertSchedule {
  return {
    name: schedule.name,
    cron: schedule.cron,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    onlyWhenOnline: schedule.onlyWhenOnline,
    tasks: schedule.tasks,
    ...patch,
  };
}

/** One line per task for the list view. */
export function taskSummary(t: ScheduleTask): string {
  const wait = t.offsetSeconds > 0 ? ` after ${t.offsetSeconds}s` : "";
  if (t.action === "command") return `Run “${t.command}”${wait}`;
  if (t.action === "power") return `${t.power[0]!.toUpperCase()}${t.power.slice(1)} the server${wait}`;
  return `Create a backup${t.rotate ? " (rotating)" : ""}${wait}`;
}
