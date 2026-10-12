import { isApiError } from "@/lib/api/errors";

/*
 * Optimistic concurrency for the editor: every save sends the sha256 of the version the user
 * opened (`baseSha256`). If someone (or the server itself) changed the file meanwhile, the API
 * answers PRECONDITION_FAILED / CONFLICT and nothing is written; the user then chooses to
 * reload theirs-on-disk, overwrite, or keep editing.
 */

export type SaveOutcome =
  | { kind: "saved"; sha256: string; size: number }
  | { kind: "conflict"; message: string }
  | { kind: "redacted"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "error"; error: unknown };

export type WriteFn = (body: { path: string; content: string; baseSha256?: string | null }) => Promise<{
  sha256: string;
  size: number;
}>;

export interface SaveRequest {
  path: string;
  content: string;
  /** sha of the version being edited; null = new file (must not exist). */
  baseSha256: string | null;
  /** Skip the conflict check (user chose "Overwrite"). */
  force?: boolean;
}

export function classifySaveError(err: unknown): SaveOutcome {
  if (isApiError(err)) {
    if (err.code === "PRECONDITION_FAILED" || err.code === "CONFLICT")
      return { kind: "conflict", message: err.message };
    if (err.code === "FORBIDDEN") {
      return /redact/i.test(err.message)
        ? { kind: "redacted", message: err.message }
        : { kind: "denied", message: err.message };
    }
  }
  return { kind: "error", error: err };
}

export async function saveFile(write: WriteFn, req: SaveRequest): Promise<SaveOutcome> {
  try {
    const body: { path: string; content: string; baseSha256?: string | null } = {
      path: req.path,
      content: req.content,
    };
    // `undefined` (omitted) = overwrite unconditionally; null = create only.
    if (!req.force) body.baseSha256 = req.baseSha256;
    const r = await write(body);
    return { kind: "saved", sha256: r.sha256, size: r.size };
  } catch (err) {
    return classifySaveError(err);
  }
}
