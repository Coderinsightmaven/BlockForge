import { MAX_EXTENSION_UPLOAD_BYTES, isSafeJarFilename } from "@blockforge/contracts";
import type {
  ExtensionCompatibility,
  ExtensionHistoryEntry,
  InstalledExtension,
  ModrinthInstallPlan,
  ModrinthInstallRequest,
  ModrinthPlanRequest,
  PlanWarning,
} from "@blockforge/contracts";
import type { z } from "zod";
import { isApiError } from "@/lib/api/errors";

/*
 * Pure helpers for the Plugins & mods tab. Everything shown from Modrinth, jar metadata or the file
 * system is untrusted text: the components render it as React text; links and icons pass through the
 * URL checks below (the control plane validates them too — this is the second layer).
 */

/** An `https://` link without credentials, else null (never rendered as a link). */
export function safeHttpsLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** Icons only from the Modrinth CDN (https, default port, no credentials). */
export function safeCdnIcon(url: string | null | undefined): string | null {
  const safe = safeHttpsLink(url);
  if (!safe) return null;
  const u = new URL(safe);
  return u.hostname === "cdn.modrinth.com" && u.port === "" ? safe : null;
}

/** Names the jar declares (several for multi-mod jars), else the Modrinth title, else the file name. */
export function extensionNames(
  ext: Pick<InstalledExtension, "metadata" | "modrinth" | "filename">,
): string[] {
  const names = [...new Set(ext.metadata.map((m) => m.name).filter((n) => n.trim() !== ""))];
  if (names.length) return names;
  if (ext.modrinth?.title) return [ext.modrinth.title];
  return [ext.filename];
}

/** The metadata entry the server software uses (or the first one). */
export function primaryMetadata(ext: Pick<InstalledExtension, "metadata" | "compatibility">) {
  const i = ext.compatibility?.metadataIndex;
  return (i !== null && i !== undefined ? ext.metadata[i] : undefined) ?? ext.metadata[0] ?? null;
}

export function problemsByLevel(c: ExtensionCompatibility | null) {
  const problems = c?.problems ?? [];
  return {
    errors: problems.filter((p) => p.level === "error"),
    warnings: problems.filter((p) => p.level === "warning"),
  };
}

export function groupPlanWarnings(
  warnings: readonly PlanWarning[],
): Record<PlanWarning["level"], PlanWarning[]> {
  return {
    error: warnings.filter((w) => w.level === "error"),
    warning: warnings.filter((w) => w.level === "warning"),
    info: warnings.filter((w) => w.level === "info"),
  };
}

export type PlanOptions = z.input<typeof ModrinthPlanRequest>;

/** The install request for a reviewed plan: same options + the plan's files as `expect`. */
export function installRequest(
  options: PlanOptions,
  plan: ModrinthInstallPlan,
): z.input<typeof ModrinthInstallRequest> {
  return {
    ...options,
    expect: plan.files.map((f) => ({ projectId: f.projectId, versionId: f.versionId, action: f.action })),
  };
}

/** Idempotency action for an install: a different request body must use a different key. */
export function installAction(body: z.input<typeof ModrinthInstallRequest>): string {
  const expect = [...body.expect].map((e) => `${e.projectId}@${e.versionId}:${e.action}`).sort();
  return JSON.stringify([
    body.project,
    body.versionId ?? null,
    [...(body.includeOptional ?? [])].sort(),
    !!body.allowPrerelease,
    !!body.allowIncompatibleVersion,
    expect,
  ]);
}

/** The fresh plan of a 409 `plan_changed`, else null. */
export function planChangedFrom(
  err: unknown,
  parse: (v: unknown) => ModrinthInstallPlan | null,
): ModrinthInstallPlan | null {
  if (!isApiError(err) || err.status !== 409) return null;
  const d = err.details as { reason?: unknown; plan?: unknown } | null | undefined;
  return d?.reason === "plan_changed" ? parse(d.plan) : null;
}

/** `details.reason` of an API error (string), else null. */
export function errorReason(err: unknown): string | null {
  if (!isApiError(err)) return null;
  const d = err.details as { reason?: unknown } | null | undefined;
  return typeof d?.reason === "string" ? d.reason : null;
}

export const UPLOAD_REJECTION: Record<string, string> = {
  not_a_jar: "The file is not a valid .jar (no readable zip directory).",
  no_metadata:
    "The jar declares no plugin or mod metadata, and the upload policy requires it. Ask an administrator, or check that this is a server plugin/mod.",
  incompatible:
    "This server software would not load the jar (see the problems below). You can install it anyway with “Install although incompatible”.",
  size_mismatch: "The uploaded size differs from the file's size — the transfer was incomplete. Try again.",
  uploads_disabled: "Uploading plugins and mods is turned off by an administrator.",
  exists:
    "A file with this name already exists. Turn on “Replace the existing file” to replace it (the old file is kept for rollback).",
};

export const SKIPPED_REASON: Record<string, string> = {
  symlink: "symbolic link (never opened)",
  "not-a-file": "not a regular file",
  empty: "empty file",
  "unsafe-name": "unsafe file name",
  "too-many": "over the 4096-file limit",
};

/** Client checks before asking for an upload URL (the server repeats them). */
export function checkUploadFile(file: Pick<File, "name" | "size">): string | null {
  if (!file.name.toLowerCase().endsWith(".jar")) return "Choose a .jar file.";
  if (!isSafeJarFilename(file.name) || file.name.length > 128)
    return "Rename the file first: at most 128 characters, no path separators, reserved or control characters.";
  if (file.size <= 0) return "The file is empty.";
  if (file.size > MAX_EXTENSION_UPLOAD_BYTES)
    return `The file is larger than ${Math.round(MAX_EXTENSION_UPLOAD_BYTES / 1024 ** 2)} MiB.`;
  return null;
}

export const HISTORY_ACTION_LABEL: Record<ExtensionHistoryEntry["action"], string> = {
  install: "Installed",
  update: "Updated",
  remove: "Removed",
  rollback: "Rolled back",
  enable: "Enabled",
  disable: "Disabled",
  upload: "Uploaded",
};

export const ROLLBACK_UNAVAILABLE: Record<
  NonNullable<ExtensionHistoryEntry["rollback"]["reason"]>,
  string
> = {
  not_supported: "Enable/disable is undone with the switch in the list.",
  failed_entry: "This change failed, so there is nothing to undo.",
  superseded: "A newer change of this file exists; roll that back first.",
  file_unavailable: "The previous file is no longer kept (older than 30 days, or changed on disk).",
};

function snapshotLabel(s: ExtensionHistoryEntry["from"]): string {
  if (!s) return "—";
  return s.versionNumber ?? s.path.slice(s.path.indexOf("/") + 1);
}

/** "1.0.0 → 1.1.0", "— → plugins/x.jar" … */
export function historyChange(e: Pick<ExtensionHistoryEntry, "from" | "to">): string {
  return `${snapshotLabel(e.from)} → ${snapshotLabel(e.to)}`;
}
