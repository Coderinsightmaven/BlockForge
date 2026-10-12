import {
  ApiKey,
  Backup,
  BackupStorageSettings,
  CreatedApiKey,
  CronPreviewResponse,
  Id,
  Schedule,
  ScheduleRun,
  TransferUrlResponse,
  page,
} from "@blockforge/contracts";
import type {
  CreateApiKeyRequest,
  CreateBackupRequest,
  CronPreviewRequest,
  RestoreBackupRequest,
  UpsertScheduleRequest,
} from "@blockforge/contracts";
import { z } from "zod";
import { apiClient } from "./client";

/*
 * Phase 4 routes (docs/architecture/api.md: Backups, Schedules, API keys). Imported only by the
 * lazily loaded tabs/pages, so none of this reaches the shell bundle. Responses are validated
 * against the contract schemas.
 */

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;
const JobRef = z.object({ jobId: Id });

export const CreateBackupResponse = z.object({ backup: Backup, jobId: Id });
export const StorageTestResponse = z.object({ ok: z.boolean(), error: z.string().nullable() });
export type StorageTestResponse = z.infer<typeof StorageTestResponse>;

export const backupsApi = {
  list: (serverId: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(serverId)}/backups`, { schema: z.array(Backup), signal }),
  /** Idempotent (202); at the limit without `rotate` → 409. */
  create: (serverId: string, body: In<typeof CreateBackupRequest>, idempotencyKey: string) =>
    apiClient.post(`/servers/${enc(serverId)}/backups`, {
      body,
      schema: CreateBackupResponse,
      idempotencyKey,
    }),
  update: (serverId: string, backupId: string, body: { name?: string; locked?: boolean }) =>
    apiClient.patch(`/servers/${enc(serverId)}/backups/${enc(backupId)}`, { body, schema: Backup }),
  remove: (serverId: string, backupId: string) =>
    apiClient.delete(`/servers/${enc(serverId)}/backups/${enc(backupId)}`, { schema: JobRef }),
  downloadUrl: (serverId: string, backupId: string) =>
    apiClient.get(`/servers/${enc(serverId)}/backups/${enc(backupId)}/download`, {
      schema: TransferUrlResponse,
    }),
  restore: (serverId: string, backupId: string, body: In<typeof RestoreBackupRequest>) =>
    apiClient.post(`/servers/${enc(serverId)}/backups/${enc(backupId)}/restore`, { body, schema: JobRef }),
};

export const schedulesApi = {
  list: (serverId: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(serverId)}/schedules`, { schema: z.array(Schedule), signal }),
  create: (serverId: string, body: In<typeof UpsertScheduleRequest>) =>
    apiClient.post(`/servers/${enc(serverId)}/schedules`, { body, schema: Schedule }),
  update: (serverId: string, scheduleId: string, body: In<typeof UpsertScheduleRequest>) =>
    apiClient.put(`/servers/${enc(serverId)}/schedules/${enc(scheduleId)}`, { body, schema: Schedule }),
  remove: (serverId: string, scheduleId: string) =>
    apiClient.delete<void>(`/servers/${enc(serverId)}/schedules/${enc(scheduleId)}`),
  run: (serverId: string, scheduleId: string) =>
    apiClient.post(`/servers/${enc(serverId)}/schedules/${enc(scheduleId)}/run`, { schema: ScheduleRun }),
  runs: (
    serverId: string,
    scheduleId: string,
    opts: { limit?: number; cursor?: string | null } = {},
    signal?: AbortSignal,
  ) =>
    apiClient.get(`/servers/${enc(serverId)}/schedules/${enc(scheduleId)}/runs`, {
      query: { limit: opts.limit, cursor: opts.cursor ?? undefined },
      schema: page(ScheduleRun),
      signal,
    }),
  preview: (body: In<typeof CronPreviewRequest>, signal?: AbortSignal) =>
    apiClient.post("/schedules/preview", { body, schema: CronPreviewResponse, signal }),
};

export const apiKeysApi = {
  list: (signal?: AbortSignal) => apiClient.get("/account/api-keys", { schema: z.array(ApiKey), signal }),
  /** The response carries the secret once: call through a `sensitive` mutation only. */
  create: (body: In<typeof CreateApiKeyRequest>) =>
    apiClient.post("/account/api-keys", { body, schema: CreatedApiKey }),
  revoke: (id: string) => apiClient.delete<void>(`/account/api-keys/${enc(id)}`),
};

export const backupStorageApi = {
  /** The S3 secret is write-only and never part of this response. */
  get: (signal?: AbortSignal) =>
    apiClient.get("/settings/backups.storage", { schema: BackupStorageSettings, signal }),
  put: (body: In<typeof BackupStorageSettings>) =>
    apiClient.put("/settings/backups.storage", { body, schema: BackupStorageSettings }),
  /** Tests the saved configuration (HEAD bucket + put/delete a probe object). */
  test: () => apiClient.post("/settings/backups.storage/test", { schema: StorageTestResponse }),
};
