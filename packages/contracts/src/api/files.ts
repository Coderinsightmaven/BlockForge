import { z } from "zod";
import { Bytes, EpochMs } from "../common.js";
import { FileEntry } from "../agent/workload.js";
import { MutableRelativePath, RelativePath } from "../agent/paths.js";

/**
 * File manager (`/servers/:id/files/*`). Paths are relative to the server's data root; the agent is the
 * sandbox authority. Reads need `servers.files.read`, everything else `servers.files.write`. Paths on
 * the template's `fileDenylist` are refused for non-administrators. Secret-bearing files (e.g. Velocity
 * forwarding secrets) are redacted unless the user holds `secrets.read`.
 */
export const FileListQuery = z.object({ path: RelativePath.default("") });
export const FileListResponse = z.object({ path: z.string(), entries: z.array(FileEntry), truncated: z.boolean() });

export const FileContentQuery = z.object({ path: MutableRelativePath });
export const FileContentResponse = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  sha256: z.string(),
  size: Bytes,
  /** Editor limit is 5 MiB; larger files must be downloaded. */
  truncated: z.boolean(),
  /** True when secret values were masked; saving a redacted file is refused. */
  redacted: z.boolean(),
});
export const FileWriteRequest = z.object({
  path: MutableRelativePath,
  content: z.string().max(5 * 1024 * 1024),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  /** sha256 returned when the file was read; null = must not exist; omitted = overwrite unconditionally. */
  baseSha256: z.string().nullable().optional(),
});
export const FileRenameRequest = z.object({
  renames: z.array(z.object({ from: MutableRelativePath, to: MutableRelativePath })).min(1).max(100),
});
export const FileDeleteRequest = z.object({ paths: z.array(MutableRelativePath).min(1).max(1000) });
export const FileCopyRequest = z.object({ path: MutableRelativePath });
export const FileMkdirRequest = z.object({ path: MutableRelativePath });
export const FileCompressRequest = z.object({
  root: RelativePath.default(""),
  paths: z.array(MutableRelativePath).min(1).max(1000),
  format: z.enum(["tar.gz", "zip"]).default("tar.gz"),
});
export const FileDecompressRequest = z.object({ path: MutableRelativePath, destination: RelativePath.default("") });
export const FileChmodRequest = z.object({
  files: z
    .array(z.object({ path: MutableRelativePath, mode: z.string().regex(/^[0-7]{3}$/, "octal like 644") }))
    .min(1)
    .max(100),
});
/**
 * Responses: rename/delete/mkdir/chmod → 204; copy → `FileCopyResponse`; compress/decompress →
 * `FileArchiveResponse` (synchronous) or 202 `{ jobId }` when the control plane runs them as jobs.
 * Errors: `PATH_DENIED` (fileDenylist), `REDACTED_CONTENT` (saving a redacted file),
 * `CONFLICT` (baseSha256 mismatch on write).
 */
export const FileCopyResponse = z.object({ path: z.string() });
export const FileArchiveResponse = z.object({ path: z.string(), size: Bytes, entries: z.number().int() });
export const FileJobResponse = z.object({ jobId: z.uuid() });

export const FileSearchQuery = z.object({
  path: RelativePath.default(""),
  q: z.string().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const FileSearchResponse = z.object({ matches: z.array(FileEntry), truncated: z.boolean() });

/**
 * Uploads and downloads stream through the control plane without buffering: the browser asks for a
 * short-lived single-use URL (`/api/v1/transfers/:token`, valid 5 min), then PUTs or GETs the body.
 * The unguessable single-use token bound to the session is the authorisation; the CSRF header is
 * accepted but not required on `PUT /transfers/:token`.
 */
export const UploadUrlRequest = z.object({
  directory: RelativePath.default(""),
  fileName: z.string().min(1).max(255).regex(/^[^/\\\0]+$/),
  size: Bytes.max(16 * 1024 ** 3),
});
export const DownloadUrlQuery = z.object({ path: MutableRelativePath });
export const TransferUrlResponse = z.object({ url: z.string(), expiresAt: EpochMs });
