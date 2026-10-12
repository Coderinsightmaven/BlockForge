import { validateName } from "./paths";

/*
 * Turning a drop (files and/or folders) or a file-picker selection into uploads. Every path
 * segment is validated with the same rules as "new file/folder" (no "/", "\", "..", NUL), the
 * folders are created first (parents before children), and anything unreadable is reported instead
 * of silently uploading empty files.
 */

export interface PendingUpload {
  file: File;
  /** Folder relative to the upload target ("" = the target itself), "/"-separated. */
  relativeDir: string;
}

export interface UploadPlan {
  /** Folders to create, parents first, relative to the target. */
  dirs: string[];
  files: PendingUpload[];
  errors: string[];
}

/** `items[].path` is the item's path inside the drop, e.g. "world/region/r.0.0.mca". */
export function planUploads(items: ReadonlyArray<{ path: string; file: File }>): UploadPlan {
  const dirs = new Set<string>();
  const files: PendingUpload[] = [];
  const errors: string[] = [];
  for (const { path, file } of items) {
    const segments = path.split("/").filter((s) => s !== "");
    if (segments.length === 0) {
      errors.push("An item without a name was skipped.");
      continue;
    }
    const bad = segments.map((s) => validateName(s)).find((e) => e !== null);
    if (bad) {
      errors.push(`${path}: ${bad}`);
      continue;
    }
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
    files.push({ file, relativeDir: segments.slice(0, -1).join("/") });
  }
  const sorted = [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return { dirs: sorted, files, errors };
}

// Minimal File System Entry API surface (Chromium, Firefox and Safari implement it).
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
}
interface FsFileEntry extends FsEntry {
  file(ok: (f: File) => void, fail: (e: unknown) => void): void;
}
interface FsDirectoryEntry extends FsEntry {
  createReader(): { readEntries(ok: (entries: FsEntry[]) => void, fail: (e: unknown) => void): void };
}

/** Bound on what one drop may expand to (accidentally dropping a home directory). */
export const MAX_DROPPED_FILES = 5000;

async function readAll(dir: FsDirectoryEntry): Promise<FsEntry[]> {
  const reader = dir.createReader();
  const out: FsEntry[] = [];
  // readEntries returns batches (≈100 in Chromium); an empty batch means done.
  for (;;) {
    const batch = await new Promise<FsEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function walk(
  entry: FsEntry,
  prefix: string,
  out: Array<{ path: string; file: File }>,
  errors: string[],
): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (out.length >= MAX_DROPPED_FILES) return;
  if (entry.isFile) {
    try {
      const file = await new Promise<File>((ok, fail) => (entry as FsFileEntry).file(ok, fail));
      out.push({ path, file });
    } catch {
      errors.push(`${path}: could not be read.`);
    }
    return;
  }
  if (entry.isDirectory) {
    let children: FsEntry[];
    try {
      children = await readAll(entry as FsDirectoryEntry);
    } catch {
      errors.push(`${path}/: the folder could not be read.`);
      return;
    }
    for (const c of children) await walk(c, path, out, errors);
  }
}

/**
 * Capture the dropped entries. Must be called synchronously inside the drop handler (the
 * DataTransfer is emptied once the event returns); the returned promise does the async walk.
 */
export function collectDrop(
  dt: DataTransfer,
): Promise<{ items: Array<{ path: string; file: File }>; errors: string[] }> {
  const roots: FsEntry[] = [];
  const plainFiles: File[] = [];
  for (const item of [...dt.items]) {
    if (item.kind !== "file") continue;
    const entry =
      (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null;
    if (entry) roots.push(entry);
    else {
      const f = item.getAsFile();
      if (f) plainFiles.push(f);
    }
  }
  if (roots.length === 0 && plainFiles.length === 0) for (const f of [...dt.files]) plainFiles.push(f);
  return (async () => {
    const items: Array<{ path: string; file: File }> = plainFiles.map((file) => ({ path: file.name, file }));
    const errors: string[] = [];
    for (const r of roots) await walk(r, "", items, errors);
    if (items.length >= MAX_DROPPED_FILES)
      errors.push(`Only the first ${MAX_DROPPED_FILES} files were taken.`);
    return { items, errors };
  })();
}
