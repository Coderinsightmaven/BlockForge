import {
  Allocation,
  ArtifactPlan,
  AuditEvent,
  CreateAllocationsResponse,
  Job,
  JobLogLine,
  PlacementPreviewResponse,
  Server,
  ServerAllocationChangeResponse,
  ServerStartup,
  ServerSubuser,
  SoftwareBuild,
  SoftwareInfo,
  SoftwareVersion,
  SshKey,
  Template,
  TemplateImportIssue,
  TemplateImportPreview,
  TemplateSummary,
  page,
} from "@blockforge/contracts";
import type {
  AddSubuserRequest,
  CreateAllocationsRequest,
  CreateServerBase,
  CreateServerRequest,
  CreateSshKeyRequest,
  ImportTemplateRequest,
  ServerActionRequest,
  UpdateAllocationRequest,
  UpdateServerAllocationRequest,
  UpdateServerBuildRequest,
  UpdateServerSettingsRequest,
  UpdateTemplateRequest,
} from "@blockforge/contracts";
import { z } from "zod";
import { ConsoleLinesEvent } from "../realtime/protocol";
import { apiClient } from "./client";
import type { AuditFilters } from "./endpoints";

/*
 * Phase 3 routes (docs/architecture/api.md: templates, catalogue, allocations, servers, files,
 * account). Responses are validated against the contract schemas.
 */

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;

const ServerPage = page(Server);
const AuditPage = page(AuditEvent);
const AllocationPage = page(Allocation);
const JobRef = z.object({ jobId: z.uuid() });

export type PlacementCandidate = z.infer<typeof PlacementPreviewResponse>["candidates"][number];
/** compress/decompress: synchronous result, or a background job (202). */

export const CreateServerResponse = z.object({ server: Server, jobId: z.uuid() });
const BuildChangeResponse = z.object({ server: Server, restartRequired: z.boolean() });
const RestartRequired = z.object({ restartRequired: z.boolean() });
const ImportResult = z.object({ template: Template, issues: z.array(TemplateImportIssue) });

export type ServerListFilter = "all" | "mine";
export interface ServerListParams {
  filter: ServerListFilter;
  q?: string;
  nodeId?: string;
  limit?: number;
  cursor?: string | null;
}

/** Body of `POST /servers/placement-preview`: any subset of `CreateServerBase`. */
export type PlacementPreviewBody = Partial<In<typeof CreateServerBase>>;

export const serversApi = {
  list: (p: ServerListParams, signal?: AbortSignal) =>
    apiClient.get("/servers", {
      query: { filter: p.filter, q: p.q, nodeId: p.nodeId, limit: p.limit ?? 100, cursor: p.cursor },
      schema: ServerPage,
      signal,
    }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`/servers/${enc(id)}`, { schema: Server, signal }),
  placementPreview: (body: PlacementPreviewBody, signal?: AbortSignal) =>
    apiClient.post("/servers/placement-preview", { body, schema: PlacementPreviewResponse, signal }),
  create: (body: In<typeof CreateServerRequest>, idempotencyKey: string) =>
    apiClient.post("/servers", { body, schema: CreateServerResponse, idempotencyKey }),
  updateSettings: (id: string, body: In<typeof UpdateServerSettingsRequest>) =>
    apiClient.patch(`/servers/${enc(id)}`, { body, schema: Server }),
  updateBuild: (id: string, body: In<typeof UpdateServerBuildRequest>) =>
    apiClient.patch(`/servers/${enc(id)}/build`, { body, schema: BuildChangeResponse }),
  suspend: (id: string) => apiClient.post(`/servers/${enc(id)}/suspend`, { schema: Server }),
  unsuspend: (id: string) => apiClient.post(`/servers/${enc(id)}/unsuspend`, { schema: Server }),
  reinstall: (id: string, idempotencyKey: string) =>
    apiClient.post(`/servers/${enc(id)}/reinstall`, { schema: JobRef, idempotencyKey }),
  remove: (id: string, deleteData: boolean, idempotencyKey: string) =>
    apiClient.delete(`/servers/${enc(id)}`, {
      query: { deleteData: deleteData ? "true" : undefined },
      schema: JobRef,
      idempotencyKey,
    }),
  action: (id: string, body: In<typeof ServerActionRequest>, idempotencyKey: string) =>
    apiClient.post(`/servers/${enc(id)}/actions`, { body, schema: JobRef, idempotencyKey }),
  sendCommand: (id: string, command: string) =>
    apiClient.post<void>(`/servers/${enc(id)}/console`, { body: { command } }),
  consoleHistory: (id: string, lines: number, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(id)}/console/history`, {
      query: { lines },
      schema: ConsoleLinesEvent,
      signal,
    }),
  startup: (id: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(id)}/startup`, { schema: ServerStartup, signal }),
  updateVariable: (id: string, envName: string, value: string) =>
    apiClient.put(`/servers/${enc(id)}/startup/variables`, {
      body: { envName, value },
      schema: ServerStartup,
    }),
  updateImage: (id: string, image: string) =>
    apiClient.put(`/servers/${enc(id)}/startup/image`, { body: { image }, schema: ServerStartup }),
  subusers: (id: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(id)}/subusers`, { schema: z.array(ServerSubuser), signal }),
  addSubuser: (id: string, body: In<typeof AddSubuserRequest>) =>
    apiClient.post(`/servers/${enc(id)}/subusers`, { body, schema: ServerSubuser }),
  updateSubuser: (id: string, subuserId: string, permissions: string[]) =>
    apiClient.put(`/servers/${enc(id)}/subusers/${enc(subuserId)}`, {
      body: { permissions },
      schema: ServerSubuser,
    }),
  removeSubuser: (id: string, subuserId: string) =>
    apiClient.delete<void>(`/servers/${enc(id)}/subusers/${enc(subuserId)}`),
  activity: (id: string, q: AuditFilters & { limit?: number; cursor?: string }, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(id)}/activity`, { query: { ...q }, schema: AuditPage, signal }),
  allocations: (id: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(id)}/allocations`, { schema: z.array(Allocation), signal }),
  addAllocation: (id: string) =>
    apiClient.post(`/servers/${enc(id)}/allocations`, { schema: ServerAllocationChangeResponse }),
  updateAllocation: (id: string, allocationId: string, body: In<typeof UpdateServerAllocationRequest>) =>
    apiClient.patch(`/servers/${enc(id)}/allocations/${enc(allocationId)}`, {
      body,
      schema: ServerAllocationChangeResponse,
    }),
  removeAllocation: (id: string, allocationId: string) =>
    apiClient.delete(`/servers/${enc(id)}/allocations/${enc(allocationId)}`, { schema: RestartRequired }),
};

export const templatesApi = {
  list: (signal?: AbortSignal) => apiClient.get("/templates", { schema: z.array(TemplateSummary), signal }),
  get: (id: string, signal?: AbortSignal) =>
    apiClient.get(`/templates/${enc(id)}`, { schema: Template, signal }),
  importPreview: (body: In<typeof ImportTemplateRequest>) =>
    apiClient.post("/templates/import/preview", { body, schema: TemplateImportPreview }),
  import: (body: In<typeof ImportTemplateRequest>) =>
    apiClient.post("/templates/import", { body, schema: ImportResult }),
  update: (id: string, body: In<typeof UpdateTemplateRequest>) =>
    apiClient.patch(`/templates/${enc(id)}`, { body, schema: Template }),
  remove: (id: string) => apiClient.delete<void>(`/templates/${enc(id)}`),
  /** Egg JSON (PTDL_v2); returned as an opaque object for download. */
  export: (id: string) =>
    apiClient.get(`/templates/${enc(id)}/export`, { schema: z.record(z.string(), z.unknown()) }),
};

export const catalogApi = {
  software: (signal?: AbortSignal) =>
    apiClient.get("/catalog/software", { schema: z.array(SoftwareInfo), signal }),
  versions: (software: string, signal?: AbortSignal) =>
    apiClient.get(`/catalog/software/${enc(software)}/versions`, {
      schema: z.array(SoftwareVersion),
      signal,
    }),
  builds: (software: string, version: string, signal?: AbortSignal) =>
    apiClient.get(`/catalog/software/${enc(software)}/versions/${enc(version)}/builds`, {
      schema: z.array(SoftwareBuild),
      signal,
    }),
  plan: (software: string, version: string, build: string, signal?: AbortSignal) =>
    apiClient.get(`/catalog/software/${enc(software)}/versions/${enc(version)}/builds/${enc(build)}/plan`, {
      schema: ArtifactPlan,
      signal,
    }),
};

export const allocationsApi = {
  listForNode: (
    nodeId: string,
    q: { free?: boolean; limit?: number; cursor?: string | null } = {},
    signal?: AbortSignal,
  ) =>
    apiClient.get(`/nodes/${enc(nodeId)}/allocations`, {
      query: { free: q.free, limit: q.limit ?? 500, cursor: q.cursor },
      schema: AllocationPage,
      signal,
    }),
  create: (nodeId: string, body: In<typeof CreateAllocationsRequest>) =>
    apiClient.post(`/nodes/${enc(nodeId)}/allocations`, { body, schema: CreateAllocationsResponse }),
  update: (id: string, body: In<typeof UpdateAllocationRequest>) =>
    apiClient.patch(`/allocations/${enc(id)}`, { body, schema: Allocation }),
  remove: (id: string) => apiClient.delete<void>(`/allocations/${enc(id)}`),
};

export const jobsApi = {
  get: (id: string, signal?: AbortSignal) => apiClient.get(`/jobs/${enc(id)}`, { schema: Job, signal }),
  logs: (id: string, afterId: number | undefined, signal?: AbortSignal) =>
    apiClient.get(`/jobs/${enc(id)}/logs`, { query: { afterId }, schema: z.array(JobLogLine), signal }),
};

export const accountApi = {
  sshKeys: (signal?: AbortSignal) => apiClient.get("/account/ssh-keys", { schema: z.array(SshKey), signal }),
  addSshKey: (body: In<typeof CreateSshKeyRequest>) =>
    apiClient.post("/account/ssh-keys", { body, schema: SshKey }),
  removeSshKey: (id: string) => apiClient.delete<void>(`/account/ssh-keys/${enc(id)}`),
};
