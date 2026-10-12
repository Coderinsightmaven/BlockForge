import { BACKUP_JOB_ERROR_CODES, SERVER_JOB_ERROR_CODES } from "@blockforge/contracts";

/*
 * Human descriptions for failed jobs. `Job.error.code` is classified by the control plane
 * (SERVER_JOB_ERROR_CODES for provision/start/restart, BACKUP_JOB_ERROR_CODES for backup
 * create/restore/delete) or a generic API code; the raw message is still shown next to it.
 */

export type ServerJobErrorCode = keyof typeof SERVER_JOB_ERROR_CODES;
export type BackupJobErrorCode = keyof typeof BACKUP_JOB_ERROR_CODES;
export type JobErrorCode = ServerJobErrorCode | BackupJobErrorCode;

const DESCRIPTIONS: Record<JobErrorCode, string> = { ...SERVER_JOB_ERROR_CODES, ...BACKUP_JOB_ERROR_CODES };

export function isServerJobErrorCode(code: string): code is ServerJobErrorCode {
  return Object.prototype.hasOwnProperty.call(SERVER_JOB_ERROR_CODES, code);
}

export function isJobErrorCode(code: string): code is JobErrorCode {
  return Object.prototype.hasOwnProperty.call(DESCRIPTIONS, code);
}

const HINTS: Partial<Record<JobErrorCode, string>> = {
  EULA_NOT_ACCEPTED: "Accept the EULA from the banner on this page, then start the server again.",
  PORT_BIND_FAILED: "The port may already be in use on the node — check the allocations in the Network tab.",
  JAVA_VERSION_MISMATCH: "Choose a Docker image with a newer Java version in the Startup tab.",
  OOM_KILLED: "Raise the memory limit (an administrator can change it under Settings → Administration).",
  READY_TIMEOUT: "Check the console output to see where start-up stopped.",
  SAVE_OFF_TIMEOUT:
    "Check the console: the server may be busy or a plugin may block saving. Try again, or back up with the server stopped.",
  SAVE_TIMEOUT: "Large worlds can take long to save. Try again, or back up with the server stopped.",
  SAVE_FAILED: "Check the node's free disk space and the console output.",
  STORAGE_ERROR: "An administrator can check the storage under Settings → Backup storage (Test connection).",
  UPLOAD_FAILED: "An administrator can check the storage under Settings → Backup storage (Test connection).",
  BACKUP_LOCKED: "Unlock the backup, then delete it again.",
};

export interface JobErrorView {
  /** Known description, or null for codes the UI doesn't classify. */
  description: string | null;
  hint: string | null;
}

export function describeJobError(code: string): JobErrorView {
  if (!isJobErrorCode(code)) return { description: null, hint: null };
  return { description: DESCRIPTIONS[code], hint: HINTS[code] ?? null };
}
