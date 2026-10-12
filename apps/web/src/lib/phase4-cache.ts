import type { QueryClient } from "@tanstack/react-query";
import type { Backup, Schedule } from "@blockforge/contracts";
import { qk } from "./query-keys";

/*
 * Live `backup.updated|deleted` / `schedule.updated|deleted` events (on `server:<id>`) patch the
 * cached lists of the Backups and Schedules tabs. Lists that are not cached are left alone: they load fresh when opened.
 */

export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** Newest first, as the API lists them. */
export function sortBackups(list: readonly Backup[]): Backup[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

export function applyBackupEvent(queryClient: QueryClient, backup: Backup): void {
  queryClient.setQueryData<Backup[]>(qk.server(backup.serverId).backups, (prev) =>
    prev ? sortBackups(upsertById(prev, backup)) : prev,
  );
}

export function removeBackupFromCache(queryClient: QueryClient, serverId: string, backupId: string): void {
  queryClient.setQueryData<Backup[]>(qk.server(serverId).backups, (prev) =>
    prev ? prev.filter((b) => b.id !== backupId) : prev,
  );
}

export function removeScheduleFromCache(
  queryClient: QueryClient,
  serverId: string,
  scheduleId: string,
): void {
  queryClient.setQueryData<Schedule[]>(qk.server(serverId).schedules, (prev) =>
    prev ? prev.filter((s) => s.id !== scheduleId) : prev,
  );
}

export function applyScheduleEvent(queryClient: QueryClient, schedule: Schedule): void {
  queryClient.setQueryData<Schedule[]>(qk.server(schedule.serverId).schedules, (prev) =>
    prev ? upsertById(prev, schedule) : prev,
  );
}
