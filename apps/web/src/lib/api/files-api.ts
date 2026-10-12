import {
  FileArchiveResponse,
  FileContentResponse,
  FileCopyResponse,
  FileJobResponse,
  FileListResponse,
  FileSearchResponse,
  TransferUrlResponse,
} from "@blockforge/contracts";
import type {
  FileChmodRequest,
  FileCompressRequest,
  FileDecompressRequest,
  FileRenameRequest,
} from "@blockforge/contracts";
import { z } from "zod";
import { apiClient } from "./client";

/*
 * File manager routes (`/servers/:id/files/*`). A separate module so the file contracts (and the agent
 * path rules they build on) stay out of the always-loaded bundle: only the Files tab, the editor and
 * the EULA check (dynamically) import it.
 */

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;

const FileArchiveOrJob = z.union([FileArchiveResponse, FileJobResponse]);
export type FileArchiveOrJob = z.infer<typeof FileArchiveOrJob>;
const FileWriteResponse = z.object({ sha256: z.string(), size: z.number().int().nonnegative() });

export const filesApi = {
  list: (id: string, path: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(id)}/files/list`, { query: { path }, schema: FileListResponse, signal }),
  contents: (id: string, path: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(id)}/files/contents`, {
      query: { path },
      schema: FileContentResponse,
      signal,
    }),
  /** `baseSha256`: sha from the read (conflict check), `null` = must not exist, `undefined` = overwrite. */
  write: (id: string, body: { path: string; content: string; baseSha256?: string | null }) =>
    apiClient.put(`/servers/${enc(id)}/files/contents`, { body, schema: FileWriteResponse }),
  // rename/delete/mkdir/chmod answer 204; copy and archive operations describe their result.
  rename: (id: string, body: In<typeof FileRenameRequest>) =>
    apiClient.post<void>(`/servers/${enc(id)}/files/rename`, { body }),
  remove: (id: string, paths: string[]) =>
    apiClient.post<void>(`/servers/${enc(id)}/files/delete`, { body: { paths } }),
  copy: (id: string, path: string) =>
    apiClient.post(`/servers/${enc(id)}/files/copy`, { body: { path }, schema: FileCopyResponse }),
  mkdir: (id: string, path: string) =>
    apiClient.post<void>(`/servers/${enc(id)}/files/mkdir`, { body: { path } }),
  compress: (id: string, body: In<typeof FileCompressRequest>) =>
    apiClient.post(`/servers/${enc(id)}/files/compress`, { body, schema: FileArchiveOrJob }),
  decompress: (id: string, body: In<typeof FileDecompressRequest>) =>
    apiClient.post(`/servers/${enc(id)}/files/decompress`, { body, schema: FileArchiveOrJob }),
  chmod: (id: string, body: In<typeof FileChmodRequest>) =>
    apiClient.post<void>(`/servers/${enc(id)}/files/chmod`, { body }),
  search: (id: string, path: string, q: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(id)}/files/search`, {
      query: { path, q, limit: 500 },
      schema: FileSearchResponse,
      signal,
    }),
  uploadUrl: (id: string, body: { directory: string; fileName: string; size: number }) =>
    apiClient.post(`/servers/${enc(id)}/files/upload-url`, { body, schema: TransferUrlResponse }),
  downloadUrl: (id: string, path: string) =>
    apiClient.get(`/servers/${enc(id)}/files/download-url`, { query: { path }, schema: TransferUrlResponse }),
};
