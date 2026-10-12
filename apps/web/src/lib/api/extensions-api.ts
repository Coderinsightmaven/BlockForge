import {
  CompleteExtensionUploadResponse,
  ExtensionHistoryPage,
  ExtensionJobResponse,
  ExtensionList,
  ExtensionUpdatesResponse,
  ExtensionUploadResponse,
  InstalledExtension,
  ModrinthInstallPlan,
  ModrinthProjectResponse,
  ModrinthSearchResult,
  RemoveExtensionResponse,
  UpdateExtensionResponse,
} from "@blockforge/contracts";
import type {
  ApplyExtensionUpdatesRequest,
  CompleteExtensionUploadRequest,
  ExtensionUploadRequest,
  ModrinthInstallRequest,
  ModrinthPlanRequest,
} from "@blockforge/contracts";
import type { z } from "zod";
import { apiClient } from "./client";

/*
 * Plugins & mods routes (docs/architecture/api.md). Imported only by the lazily loaded extensions
 * tab and its dialogs. Every response is parsed with its contract schema.
 */

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;
const base = (serverId: string) => `/servers/${enc(serverId)}/extensions`;

export interface ModrinthSearchParams {
  query?: string;
  categories?: string[];
  sort?: "relevance" | "downloads" | "follows" | "newest" | "updated";
  offset?: number;
  limit?: number;
}

export const extensionsApi = {
  list: (serverId: string, signal?: AbortSignal) =>
    apiClient.get(base(serverId), { schema: ExtensionList, signal }),
  get: (serverId: string, extensionId: string, signal?: AbortSignal) =>
    apiClient.get(`${base(serverId)}/${enc(extensionId)}`, { schema: InstalledExtension, signal }),
  /** 202, idempotent. */
  scan: (serverId: string, full: boolean, idempotencyKey: string) =>
    apiClient.post(`${base(serverId)}/scan`, {
      body: { full },
      schema: ExtensionJobResponse,
      idempotencyKey,
    }),
  setEnabled: (serverId: string, extensionId: string, enabled: boolean) =>
    apiClient.patch(`${base(serverId)}/${enc(extensionId)}`, {
      body: { enabled },
      schema: UpdateExtensionResponse,
    }),
  remove: (serverId: string, extensionId: string) =>
    apiClient.delete(`${base(serverId)}/${enc(extensionId)}`, { schema: RemoveExtensionResponse }),
  search: (serverId: string, p: ModrinthSearchParams, signal?: AbortSignal) =>
    apiClient.get(`${base(serverId)}/modrinth/search`, {
      query: {
        query: p.query || undefined,
        categories: p.categories?.length ? p.categories.join(",") : undefined,
        sort: p.sort,
        offset: p.offset,
        limit: p.limit,
      },
      schema: ModrinthSearchResult,
      signal,
    }),
  project: (serverId: string, project: string, signal?: AbortSignal) =>
    apiClient.get(`${base(serverId)}/modrinth/projects/${enc(project)}`, {
      schema: ModrinthProjectResponse,
      signal,
    }),
  /** Read-only plan against the current scan. */
  plan: (serverId: string, body: In<typeof ModrinthPlanRequest>, signal?: AbortSignal) =>
    apiClient.post(`${base(serverId)}/modrinth/plan`, { body, schema: ModrinthInstallPlan, signal }),
  /** 202, idempotent; 409 CONFLICT `plan_changed` carries the fresh plan. */
  install: (serverId: string, body: In<typeof ModrinthInstallRequest>, idempotencyKey: string) =>
    apiClient.post(`${base(serverId)}/modrinth/install`, {
      body,
      schema: ExtensionJobResponse,
      idempotencyKey,
    }),
  updates: (serverId: string, allowPrerelease: boolean, signal?: AbortSignal) =>
    apiClient.get(`${base(serverId)}/updates`, {
      query: { allowPrerelease: allowPrerelease ? "true" : "false" },
      schema: ExtensionUpdatesResponse,
      signal,
    }),
  applyUpdates: (serverId: string, body: In<typeof ApplyExtensionUpdatesRequest>, idempotencyKey: string) =>
    apiClient.post(`${base(serverId)}/updates/apply`, { body, schema: ExtensionJobResponse, idempotencyKey }),
  startUpload: (serverId: string, body: In<typeof ExtensionUploadRequest>) =>
    apiClient.post(`${base(serverId)}/uploads`, { body, schema: ExtensionUploadResponse }),
  /** Idempotent per upload id. */
  completeUpload: (serverId: string, uploadId: string, body: In<typeof CompleteExtensionUploadRequest>) =>
    apiClient.post(`${base(serverId)}/uploads/${enc(uploadId)}/complete`, {
      body,
      schema: CompleteExtensionUploadResponse,
    }),
  history: (
    serverId: string,
    q: { limit?: number; cursor?: string | null; extensionId?: string },
    signal?: AbortSignal,
  ) =>
    apiClient.get(`${base(serverId)}/history`, {
      query: { limit: q.limit, cursor: q.cursor ?? undefined, extensionId: q.extensionId },
      schema: ExtensionHistoryPage,
      signal,
    }),
  /** 202, idempotent. */
  rollback: (serverId: string, entryId: string, idempotencyKey: string) =>
    apiClient.post(`${base(serverId)}/history/${enc(entryId)}/rollback`, {
      schema: ExtensionJobResponse,
      idempotencyKey,
    }),
};
