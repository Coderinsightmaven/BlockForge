import {
  CompleteExtensionUploadResponse,
  ExtensionHistoryPage,
  ExtensionJobResponse,
  ExtensionList,
  ExtensionUpdatesResponse,
  ExtensionUploadResponse,
  ExtensionUploadSettings,
  InstalledExtension,
  ModrinthInstallPlan,
  ModrinthProjectResponse,
  ModrinthSearchResult,
  PlayerActionResult,
  PlayerLookupResponse,
  PlayerSessionPage,
  PlayersOverview,
  RemoveExtensionResponse,
  UpdateExtensionResponse,
} from "@blockforge/contracts";
import type {
  ApplyExtensionUpdatesRequest,
  CompleteExtensionUploadRequest,
  ExtensionUploadRequest,
  ModrinthInstallRequest,
  ModrinthPlanRequest,
  PlayerActionRequest,
} from "@blockforge/contracts";
import { z } from "zod";
import { apiClient } from "./client";

/*
 * Phase 4b routes (docs/architecture/api.md: Plugins & mods, Players). Imported only by the lazily
 * loaded tabs, dialogs and settings card. Every response is parsed with its contract schema.
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

const ExtensionUploadSettingsView = z.object({
  key: z.literal("extensions.uploads"),
  value: ExtensionUploadSettings,
});

/** Admin policy for `/extensions/uploads` (generic settings wrapper, settings.manage). */
export const extensionUploadSettingsApi = {
  get: (signal?: AbortSignal) =>
    apiClient.get("/settings/extensions.uploads", { schema: ExtensionUploadSettingsView, signal }),
  put: (value: In<typeof ExtensionUploadSettings>) =>
    apiClient.put("/settings/extensions.uploads", { body: { value }, schema: ExtensionUploadSettingsView }),
};

export const playersApi = {
  overview: (serverId: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(serverId)}/players`, { schema: PlayersOverview, signal }),
  action: (serverId: string, body: In<typeof PlayerActionRequest>) =>
    apiClient.post(`/servers/${enc(serverId)}/players/actions`, { body, schema: PlayerActionResult }),
  lookup: (serverId: string, name: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(serverId)}/players/lookup`, {
      query: { name },
      schema: PlayerLookupResponse,
      signal,
    }),
  sessions: (
    serverId: string,
    q: { limit?: number; cursor?: string | null; name?: string },
    signal?: AbortSignal,
  ) =>
    apiClient.get(`/servers/${enc(serverId)}/players/sessions`, {
      query: { limit: q.limit, cursor: q.cursor ?? undefined, name: q.name || undefined },
      schema: PlayerSessionPage,
      signal,
    }),
};
