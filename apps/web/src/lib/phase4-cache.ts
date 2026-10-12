import type { QueryClient } from "@tanstack/react-query";
import type { Backup, Schedule } from "@blockforge/contracts";
import { qk } from "./query-keys";

/*
 * Live `backup.updated|deleted` / `schedule.updated|deleted` events (on `server:<id>`) patch the
 * cached lists of the Backups and Schedules tabs. Lists that are not cached are left alone: they
 * load fresh when opened.
 *
 * Deletions leave a tombstone so a deleted row cannot come back from a refetch that was already in
 * flight or from a late `*.updated` event. A tombstone is dropped once a fetch no longer returns the
 * id, or when the delete job is known to have failed (`restoreAfterFailedDelete`). TOMBSTONE_TTL_MS
 * is only the last-resort valve for a failure the client could not observe.
 */

export type ListKind = "backups" | "schedules";
export const TOMBSTONE_TTL_MS = 2 * 60_000;

const tombstones = new WeakMap<QueryClient, Map<string, number>>();
const tKey = (kind: ListKind, serverId: string, id: string) => `${kind}:${serverId}:${id}`;

function stones(queryClient: QueryClient): Map<string, number> {
  let m = tombstones.get(queryClient);
  if (!m) {
    m = new Map();
    tombstones.set(queryClient, m);
  }
  return m;
}

export function isTombstoned(
  queryClient: QueryClient,
  kind: ListKind,
  serverId: string,
  id: string,
): boolean {
  return stones(queryClient).has(tKey(kind, serverId, id));
}

/**
 * Apply tombstones to a freshly fetched list: drop tombstoned rows, and forget tombstones whose id
 * the server no longer returns (or that outlived the TTL).
 */
export function reconcileList<T extends { id: string }>(
  queryClient: QueryClient,
  kind: ListKind,
  serverId: string,
  list: readonly T[],
  now = Date.now(),
): T[] {
  const m = stones(queryClient);
  const prefix = `${kind}:${serverId}:`;
  const present = new Set(list.map((x) => x.id));
  const hidden = new Set<string>();
  for (const [key, since] of m) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!present.has(id) || now - since > TOMBSTONE_TTL_MS) m.delete(key);
    else hidden.add(id);
  }
  return list.filter((x) => !hidden.has(x.id));
}

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
  if (isTombstoned(queryClient, "backups", backup.serverId, backup.id)) return;
  queryClient.setQueryData<Backup[]>(qk.server(backup.serverId).backups, (prev) =>
    prev ? sortBackups(upsertById(prev, backup)) : prev,
  );
}

export function applyScheduleEvent(queryClient: QueryClient, schedule: Schedule): void {
  if (isTombstoned(queryClient, "schedules", schedule.serverId, schedule.id)) return;
  queryClient.setQueryData<Schedule[]>(qk.server(schedule.serverId).schedules, (prev) =>
    prev ? upsertById(prev, schedule) : prev,
  );
}

const listKey = (kind: ListKind, serverId: string) =>
  kind === "backups" ? qk.server(serverId).backups : qk.server(serverId).schedules;

/**
 * A backup/schedule was deleted (event or our own DELETE): tombstone it, cancel any list fetch in
 * flight (it may predate the delete), then remove the row.
 */
export async function markDeleted(
  queryClient: QueryClient,
  kind: ListKind,
  serverId: string,
  id: string,
  now = Date.now(),
): Promise<void> {
  stones(queryClient).set(tKey(kind, serverId, id), now);
  await queryClient.cancelQueries({ queryKey: listKey(kind, serverId) });
  queryClient.setQueryData<Array<{ id: string }>>(listKey(kind, serverId), (prev) =>
    prev ? prev.filter((x) => x.id !== id) : prev,
  );
}

/** Lift a tombstone (e.g. the delete job failed: the row still exists). */
export function clearTombstone(queryClient: QueryClient, kind: ListKind, serverId: string, id: string): void {
  stones(queryClient).delete(tKey(kind, serverId, id));
}

/** A delete did not happen after all: show the row again and re-read the list. */
export async function restoreAfterFailedDelete(
  queryClient: QueryClient,
  kind: ListKind,
  serverId: string,
  id: string,
): Promise<void> {
  clearTombstone(queryClient, kind, serverId, id);
  await queryClient.invalidateQueries({ queryKey: listKey(kind, serverId) });
}

export function removeBackupFromCache(
  queryClient: QueryClient,
  serverId: string,
  backupId: string,
): Promise<void> {
  return markDeleted(queryClient, "backups", serverId, backupId);
}

export function removeScheduleFromCache(
  queryClient: QueryClient,
  serverId: string,
  scheduleId: string,
): Promise<void> {
  return markDeleted(queryClient, "schedules", serverId, scheduleId);
}
