import { z } from "zod";
import { EpochMs, Id } from "../common.js";

/* Realtime payloads of the extensions API, kept apart from `extensions.ts` so that `realtime.ts` (loaded on
 * every page of the web app) does not pull in the whole extensions API. Re-exported by `extensions.ts`. */

export const ExtensionScanStatus = z.object({
  status: z.enum(["never", "running", "completed", "failed"]),
  /** Completion time of the last successful scan. */
  scannedAt: EpochMs.nullable(),
  /** Running or last scan job. */
  jobId: Id.nullable(),
  error: z.string().max(1024).nullable(),
});
export type ExtensionScanStatus = z.infer<typeof ExtensionScanStatus>;

/**
 * `extensions.updated` on `server:<id>`: the extension list (or the scan status) changed. `changed` lists
 * the affected extension ids (re-read them with `GET …/extensions/:extensionId`; 404 = removed); null means
 * "many / unknown" — refetch the whole list. History changes are covered by the same event.
 */
export const ExtensionsUpdatedEvent = z.object({
  serverId: Id,
  scan: ExtensionScanStatus,
  changed: z.array(Id).max(256).nullable(),
});
export type ExtensionsUpdatedEvent = z.infer<typeof ExtensionsUpdatedEvent>;
