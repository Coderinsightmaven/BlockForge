import { SERVER_JOB_ERROR_CODES } from "@blockforge/contracts";

/*
 * Human descriptions for failed server jobs. `Job.error.code` is classified by the control plane
 * (SERVER_JOB_ERROR_CODES) or a generic API code; the raw message is still shown next to it.
 */

export type ServerJobErrorCode = keyof typeof SERVER_JOB_ERROR_CODES;

export function isServerJobErrorCode(code: string): code is ServerJobErrorCode {
  return Object.prototype.hasOwnProperty.call(SERVER_JOB_ERROR_CODES, code);
}

const HINTS: Partial<Record<ServerJobErrorCode, string>> = {
  EULA_NOT_ACCEPTED: "Accept the EULA from the banner on this page, then start the server again.",
  PORT_BIND_FAILED: "The port may already be in use on the node — check the allocations in the Network tab.",
  JAVA_VERSION_MISMATCH: "Choose a Docker image with a newer Java version in the Startup tab.",
  OOM_KILLED: "Raise the memory limit (an administrator can change it under Settings → Administration).",
  READY_TIMEOUT: "Check the console output to see where start-up stopped.",
};

export interface JobErrorView {
  /** Known description, or null for codes the UI doesn't classify. */
  description: string | null;
  hint: string | null;
}

export function describeJobError(code: string): JobErrorView {
  if (!isServerJobErrorCode(code)) return { description: null, hint: null };
  return { description: SERVER_JOB_ERROR_CODES[code], hint: HINTS[code] ?? null };
}
