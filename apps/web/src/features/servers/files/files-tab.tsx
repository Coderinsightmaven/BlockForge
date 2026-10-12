import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  Download,
  EllipsisVertical,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  Home,
  KeyRound,
  Link2,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { toast } from "sonner";
import type { FileEntry, Server } from "@blockforge/contracts";
import { filesApi } from "@/lib/api/files-api";
import { formatBytes, formatTimestamp } from "@/lib/format";
import { describeError, isApiError } from "@/lib/api/errors";
import { toastError, useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { serverActionable, serverCan } from "@/lib/server-permissions";
import { preloadWhenIdle, retryableLazy } from "@/lib/lazy";
import { cn } from "@/lib/utils";
import { LazySection } from "@/components/common/chunk-boundary";
import { LazyConfirmDialog } from "@/components/common/lazy-confirm-dialog";
import { LazyDialog } from "@/components/common/lazy-dialog";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SpacerRow, VirtualTable, useVirtualRows } from "@/components/ui/virtual-table";
import {
  EDITOR_MAX_BYTES,
  baseName,
  breadcrumbs,
  isArchive,
  isLikelyText,
  joinPath,
  parentPath,
  validateName,
  validateRelativePath,
} from "./paths";
import { reportArchiveResult } from "./archive-result";
import { fileListQuery, fileSearchQuery } from "./file-queries";
import { collectDrop, planUploads } from "./drop";
import type { UploadPlan } from "./drop";
import { downloadFile, uploadFile } from "./upload";
import type { UploadProgress } from "./upload";

// The editor and the dialogs are their own chunks, preloaded once the listing has painted.
const FileEditor = retryableLazy(() => import("./file-editor").then((m) => ({ default: m.FileEditor })));
const NameDialog = retryableLazy(() => import("./file-dialogs").then((m) => ({ default: m.NameDialog })));
const CompressDialog = retryableLazy(() =>
  import("./file-dialogs").then((m) => ({ default: m.CompressDialog })),
);

function EditorLoading() {
  return (
    <div className="flex flex-col gap-3" aria-busy aria-label="Loading the editor">
      <div className="h-9 w-full max-w-md animate-pulse rounded-md bg-muted" />
      <div className="h-96 w-full animate-pulse rounded-md bg-muted" />
    </div>
  );
}

type DialogState =
  | { kind: "new-file" | "new-folder" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "chmod"; entries: FileEntry[] }
  | { kind: "compress"; entries: FileEntry[] }
  | { kind: "delete"; entries: FileEntry[] }
  | null;

export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const ad = a.type === "dir" ? 0 : 1;
    const bd = b.type === "dir" ? 0 : 1;
    return ad - bd || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.type === "dir") return <Folder className="size-4 shrink-0 text-info" aria-hidden />;
  if (entry.type === "symlink")
    return <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
  if (isArchive(entry.name)) return <Archive className="size-4 shrink-0 text-warning" aria-hidden />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

/** Files open in the editor or download; folders navigate. Links and special files do neither. */
export function isOpenable(e: Pick<FileEntry, "type">): boolean {
  return e.type === "file" || e.type === "dir";
}

export function entryTypeLabel(e: Pick<FileEntry, "type">): string {
  return e.type === "symlink" ? "symlink — not followed" : e.type === "other" ? "special file" : e.type;
}

export function validateMode(mode: string): string | null {
  return /^[0-7]{3}$/.test(mode.trim()) ? null : "Use three octal digits, e.g. 644 or 755.";
}

export default function FilesTab({
  server,
  path,
  editing,
  onNavigate,
  onEdit,
  onEditorDirty,
}: {
  server: Server;
  path: string;
  editing: string | null;
  onNavigate: (path: string) => void;
  onEdit: (path: string | null) => void;
  /** The open editor's unsaved-changes flag, so the page can guard tab changes/navigation. */
  onEditorDirty?: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const canWrite = serverActionable(server, "servers.files.write");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pendingChmod, setPendingChmod] = useState<{ paths: string[]; mode: string; folders: number } | null>(
    null,
  );
  const [newFile, setNewFile] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  useEffect(
    () =>
      preloadWhenIdle(() => {
        void NameDialog.preload();
        void FileEditor.preload();
      }),
    [],
  );
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useQuery({ ...fileListQuery(server.id, path), enabled: !editing && !newFile });
  const search = useQuery({ ...fileSearchQuery(server.id, path, searchQ), enabled: !!searchQ });
  const entries = useMemo(
    () => sortEntries(searchQ ? (search.data?.matches ?? []) : (list.data?.entries ?? [])),
    [searchQ, search.data, list.data],
  );
  const selectedEntries = entries.filter((e) => selected.has(e.path));
  const v = useVirtualRows(entries, { estimateSize: 41, getKey: (e) => e.path });

  const refresh = (dirs: string[] = [path]) => {
    for (const d of new Set(dirs))
      void queryClient.invalidateQueries({ queryKey: qk.server(server.id).files(d) });
    if (searchQ) void queryClient.invalidateQueries({ queryKey: qk.server(server.id).search(path, searchQ) });
  };
  const done = () => {
    setDialog(null);
    setSelected(new Set());
  };

  const mkdir = useApiMutation({
    mutationFn: (name: string) => filesApi.mkdir(server.id, joinPath(path, name)),
    success: "Folder created",
    errorTitle: "Could not create the folder",
    onSuccess: () => {
      refresh();
      done();
    },
  });
  const rename = useApiMutation({
    mutationFn: (r: { from: string; to: string }) => filesApi.rename(server.id, { renames: [r] }),
    success: "Renamed",
    errorTitle: "Could not rename",
    onSuccess: (_d, r) => {
      refresh([path, parentPath(r.to)]);
      done();
    },
  });
  const remove = useApiMutation({
    mutationFn: (paths: string[]) => filesApi.remove(server.id, paths),
    success: (_d, paths) => `Deleted ${paths.length} item${paths.length === 1 ? "" : "s"}`,
    errorTitle: "Could not delete",
    onSuccess: () => {
      refresh();
      done();
    },
  });
  const copy = useApiMutation({
    mutationFn: (p: string) => filesApi.copy(server.id, p),
    success: (r) => `Copied to ${baseName(r.path)}`,
    errorTitle: "Could not copy",
    onSuccess: () => refresh(),
  });
  const compress = useApiMutation({
    mutationFn: (b: { paths: string[]; format: "tar.gz" | "zip" }) =>
      filesApi.compress(server.id, { root: path, ...b }),
    errorTitle: "Could not create the archive",
    onSuccess: (r) => {
      done();
      reportArchiveResult(r, "Archive created", () => refresh());
    },
  });
  const decompress = useApiMutation({
    mutationFn: (p: string) => filesApi.decompress(server.id, { path: p, destination: path }),
    errorTitle: "Could not extract",
    onSuccess: (r) => reportArchiveResult(r, "Archive extracted", () => refresh()),
  });
  const chmod = useApiMutation({
    mutationFn: (b: { paths: string[]; mode: string }) =>
      filesApi.chmod(server.id, { files: b.paths.map((p) => ({ path: p, mode: b.mode })) }),
    success: "Permissions changed",
    errorTitle: "Could not change permissions",
    onSuccess: () => {
      refresh();
      done();
    },
  });

  /** Create the planned folders (parents first), then upload files sequentially into them. */
  const startUploads = (plan: UploadPlan) => {
    const dir = path;
    for (const message of plan.errors.slice(0, 5)) toast.error("Skipped", { description: message });
    if (plan.errors.length > 5) toast.error(`${plan.errors.length - 5} more items were skipped.`);
    if (plan.files.length === 0) {
      if (plan.errors.length === 0)
        toast.error("Nothing to upload", { description: "The selection contained no files." });
      return;
    }
    const items = plan.files.map((f) => ({
      ...f,
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    }));
    setUploads((u) => [
      ...u.filter((x) => x.status === "uploading" || x.status === "pending"),
      ...items.map(({ file, relativeDir, id }) => ({
        id,
        name: joinPath(relativeDir, file.name),
        size: file.size,
        loaded: 0,
        status: "pending" as const,
      })),
    ]);
    // Sequential: keeps the node's disk and the user's uplink from being saturated by many parallel streams.
    void (async () => {
      const failedDirs = new Map<string, string>();
      for (const d of plan.dirs) {
        try {
          await filesApi.mkdir(server.id, joinPath(dir, d));
        } catch (err) {
          // An existing folder is fine; anything else fails the files inside it.
          if (!(isApiError(err) && err.code === "CONFLICT")) failedDirs.set(d, describeError(err).title);
        }
      }
      for (const { file, relativeDir, id } of items) {
        const patch = (p: Partial<UploadProgress>) =>
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)));
        const blocked = [...failedDirs].find(([d]) => relativeDir === d || relativeDir.startsWith(`${d}/`));
        if (blocked) {
          patch({ status: "error", error: `Folder ${blocked[0]} could not be created: ${blocked[1]}` });
          continue;
        }
        patch({ status: "uploading" });
        try {
          await uploadFile(server.id, joinPath(dir, relativeDir), file, (loaded) => patch({ loaded }));
          patch({ status: "done", loaded: file.size });
        } catch (err) {
          patch({ status: "error", error: err instanceof Error ? err.message : "Upload failed" });
        }
      }
      refresh([dir, ...plan.dirs.map((d) => joinPath(dir, d))]);
    })();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!canWrite) return;
    // Entries must be captured synchronously, before the event handler returns.
    void collectDrop(e.dataTransfer).then(({ items, errors }) => {
      const plan = planUploads(items);
      startUploads({ ...plan, errors: [...errors, ...plan.errors] });
    });
  };

  const open = (entry: FileEntry) => {
    if (entry.type === "dir") {
      setSearchQ("");
      setSearchDraft("");
      setSelected(new Set());
      onNavigate(entry.path);
    } else if (entry.type === "file") {
      if (entry.size <= EDITOR_MAX_BYTES && isLikelyText(entry.name)) onEdit(entry.path);
      else
        void downloadFile(server.id, entry.path, entry.name).catch((e: unknown) =>
          toastError(e, "Download failed"),
        );
    }
  };

  if (editing || newFile) {
    const p = editing ?? newFile!;
    return (
      <LazySection what="the editor" loading={<EditorLoading />}>
        <FileEditor
          key={p}
          server={server}
          path={p}
          isNew={!editing && !!newFile}
          onDirtyChange={onEditorDirty}
          onClose={() => {
            setNewFile(null);
            onEdit(null);
            refresh([parentPath(p)]);
          }}
        />
      </LazySection>
    );
  }

  const allChecked = entries.length > 0 && entries.every((e) => selected.has(e.path));
  const truncatedListing = searchQ ? !!search.data?.truncated : !!list.data?.truncated;
  const toggle = (p: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(p);
      else n.delete(p);
      return n;
    });
  const pending =
    mkdir.isPending || rename.isPending || remove.isPending || compress.isPending || chmod.isPending;

  const rowMenu = (e: FileEntry) => (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${e.name}`}>
          <EllipsisVertical aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {e.type === "file" ? (
          <DropdownMenuItem
            onSelect={() =>
              void downloadFile(server.id, e.path, e.name).catch((err: unknown) =>
                toastError(err, "Download failed"),
              )
            }
          >
            <Download aria-hidden /> Download
          </DropdownMenuItem>
        ) : null}
        {canWrite ? (
          <>
            <DropdownMenuItem onSelect={() => setDialog({ kind: "rename", entry: e })}>
              <Pencil aria-hidden /> Rename / move
            </DropdownMenuItem>
            {e.type === "file" ? (
              <DropdownMenuItem onSelect={() => copy.mutate(e.path)}>
                <Copy aria-hidden /> Duplicate
              </DropdownMenuItem>
            ) : null}
            {e.type === "file" && isArchive(e.name) ? (
              <DropdownMenuItem onSelect={() => decompress.mutate(e.path)}>
                <ArchiveRestore aria-hidden /> Extract here
              </DropdownMenuItem>
            ) : null}
            {e.type !== "symlink" ? (
              <>
                <DropdownMenuItem onSelect={() => setDialog({ kind: "compress", entries: [e] })}>
                  <Archive aria-hidden /> Compress
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog({ kind: "chmod", entries: [e] })}>
                  <KeyRound aria-hidden /> Permissions
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => setDialog({ kind: "delete", entries: [e] })}>
              <Trash2 aria-hidden /> Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const crumbs = breadcrumbs(path);
  const loading = searchQ ? search.isPending : list.isPending;
  const error = searchQ ? search.error : list.error;

  return (
    <Card
      onDragOver={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn("relative", dragging && "ring-2 ring-primary")}
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
        <nav aria-label="Folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-sm">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent"
            onClick={() => open({ type: "dir", path: "", name: "", size: 0, modifiedAt: 0 })}
          >
            <Home className="size-4" aria-hidden />
            <span className="sr-only">Server root</span>
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="inline-flex items-center gap-0.5">
              <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
              {i === crumbs.length - 1 ? (
                <span aria-current="page" className="px-1 font-medium">
                  {c.name}
                </span>
              ) : (
                <button
                  type="button"
                  className="rounded px-1 py-0.5 hover:bg-accent"
                  onClick={() => open({ type: "dir", path: c.path, name: c.name, size: 0, modifiedAt: 0 })}
                >
                  {c.name}
                </button>
              )}
            </span>
          ))}
        </nav>
        <form
          className="relative w-full sm:w-56"
          onSubmit={(e) => {
            e.preventDefault();
            setSelected(new Set());
            setSearchQ(searchDraft.trim().slice(0, 64));
          }}
        >
          <Search
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search in this folder…"
            aria-label="Search files"
            maxLength={64}
            className="pl-8"
          />
        </form>
        {canWrite ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "new-folder" })}>
              <FolderPlus aria-hidden />
              <span className="hidden sm:inline">Folder</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "new-file" })}>
              <FilePlus aria-hidden />
              <span className="hidden sm:inline">File</span>
            </Button>
            <Button size="sm" onClick={() => fileInput.current?.click()}>
              <Upload aria-hidden />
              Upload
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length)
                  startUploads(planUploads([...e.target.files].map((file) => ({ path: file.name, file }))));
                e.target.value = "";
              }}
            />
          </div>
        ) : null}
      </div>

      {selectedEntries.length > 0 && canWrite ? (
        <div
          className="flex flex-wrap items-center gap-2 border-b bg-accent/40 px-2.5 py-1.5 text-sm"
          role="toolbar"
          aria-label="Selection"
        >
          <span className="font-medium">{selectedEntries.length} selected</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialog({ kind: "compress", entries: selectedEntries })}
          >
            <Archive aria-hidden /> Compress
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialog({ kind: "chmod", entries: selectedEntries })}
          >
            <KeyRound aria-hidden /> Permissions
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDialog({ kind: "delete", entries: selectedEntries })}
          >
            <Trash2 aria-hidden /> Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {searchQ ? (
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
          Results for “{searchQ}” in /{path}
          {search.data?.truncated ? " (first matches only)" : ""}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setSearchQ("");
              setSearchDraft("");
            }}
          >
            <X aria-hidden /> Clear search
          </Button>
        </div>
      ) : list.data?.truncated ? (
        <Callout tone="info" className="m-2">
          This folder has more entries than can be listed at once; only the first part is shown. Use search to
          find a file.
        </Callout>
      ) : null}

      {uploads.length ? (
        <ul className="flex flex-col gap-1.5 border-b px-3 py-2" aria-label="Uploads" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.id} className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-2 text-xs">
              <span className="truncate" title={u.name}>
                {u.name}
              </span>
              <Progress value={u.size ? (u.loaded / u.size) * 100 : 100} label={`Upload of ${u.name}`} />
              <span className={cn("tabular", u.status === "error" && "text-danger")}>
                {u.status === "error"
                  ? u.error
                  : u.status === "done"
                    ? "Done"
                    : u.status === "pending"
                      ? "Waiting"
                      : `${formatBytes(u.loaded)} / ${formatBytes(u.size)}`}
              </span>
            </li>
          ))}
          {uploads.every((u) => u.status !== "uploading" && u.status !== "pending") ? (
            <li>
              <Button size="sm" variant="ghost" onClick={() => setUploads([])}>
                Dismiss
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {loading ? (
        <TableSkeleton columns={4} rows={8} />
      ) : error && entries.length === 0 ? (
        <ErrorState
          error={error}
          onRetry={() => void (searchQ ? search.refetch() : list.refetch())}
          title="Could not list files"
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Folder}
          title={searchQ ? "No matches" : "This folder is empty"}
          description={canWrite && !searchQ ? "Drop files here or use Upload." : undefined}
          compact
        />
      ) : (
        <VirtualTable scrollRef={v.scrollRef} rowCount={entries.length}>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent" aria-rowindex={1}>
              <TableHead className="w-8">
                {canWrite ? (
                  <Checkbox
                    aria-label={
                      truncatedListing
                        ? `Select all ${entries.length} loaded rows (the listing is truncated)`
                        : `Select all ${entries.length} rows`
                    }
                    title={
                      truncatedListing
                        ? "Selects only the rows loaded so far — the listing is truncated"
                        : undefined
                    }
                    checked={allChecked}
                    onCheckedChange={(c) =>
                      setSelected(c === true ? new Set(entries.map((e) => e.path)) : new Set())
                    }
                  />
                ) : null}
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="hidden md:table-cell">Modified</TableHead>
              <TableHead className="hidden lg:table-cell">Mode</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <tbody>
            <SpacerRow height={v.padTop} colSpan={6} />
            {v.items.map((vi) => {
              const e = entries[vi.index]!;
              const checked = selected.has(e.path);
              return (
                <TableRow
                  key={vi.key}
                  ref={v.virtualizer.measureElement}
                  data-index={vi.index}
                  aria-rowindex={vi.index + 2}
                  data-state={checked ? "selected" : undefined}
                >
                  <TableCell className="px-3">
                    {canWrite ? (
                      <Checkbox
                        aria-label={`Select ${e.name}`}
                        checked={checked}
                        onCheckedChange={(c) => toggle(e.path, c === true)}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-0 w-full">
                    {isOpenable(e) ? (
                      <button
                        type="button"
                        onClick={() => open(e)}
                        className="flex max-w-full items-center gap-2 text-left hover:underline"
                        title={e.path}
                      >
                        <EntryIcon entry={e} />
                        <span className="truncate">{searchQ ? e.path : e.name}</span>
                      </button>
                    ) : (
                      // Symlinks are never followed by the agent (sandbox); other types can't be opened.
                      <span
                        className="flex max-w-full items-center gap-2"
                        title={`${e.path} (${entryTypeLabel(e)})`}
                      >
                        <EntryIcon entry={e} />
                        <span className="truncate text-muted-foreground">{searchQ ? e.path : e.name}</span>
                        <Badge variant="outline" className="shrink-0">
                          {entryTypeLabel(e)}
                        </Badge>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs whitespace-nowrap">
                    {e.type === "dir" ? "—" : formatBytes(e.size)}
                  </TableCell>
                  <TableCell
                    className="hidden text-xs whitespace-nowrap md:table-cell"
                    title={formatTimestamp(e.modifiedAt)}
                  >
                    {formatTimestamp(e.modifiedAt, { seconds: false, zone: false })}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs lg:table-cell">{e.mode ?? "—"}</TableCell>
                  <TableCell>{e.type !== "other" ? rowMenu(e) : null}</TableCell>
                </TableRow>
              );
            })}
            <SpacerRow height={v.padBottom} colSpan={6} />
          </tbody>
        </VirtualTable>
      )}
      {!serverCan(server, "servers.files.write") ? (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          Read-only access: you can browse and download.
        </p>
      ) : null}

      {dialog?.kind === "new-folder" ? (
        <LazyDialog title="Create folder" onClose={() => setDialog(null)}>
          <NameDialog
            title="Create folder"
            label="Folder name"
            initial=""
            validate={validateName}
            pending={mkdir.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(name) => mkdir.mutate(name)}
          />
        </LazyDialog>
      ) : null}
      {dialog?.kind === "new-file" ? (
        <LazyDialog title="Create file" onClose={() => setDialog(null)}>
          <NameDialog
            title="Create file"
            label="File name"
            initial=""
            validate={(n) =>
              validateName(n) ??
              (entries.some((e) => e.name === n.trim()) ? "A file with that name exists." : null)
            }
            pending={false}
            onClose={() => setDialog(null)}
            onSubmit={(name) => {
              setDialog(null);
              setNewFile(joinPath(path, name));
            }}
          />
        </LazyDialog>
      ) : null}
      {dialog?.kind === "rename" ? (
        <LazyDialog title="Rename" onClose={() => setDialog(null)}>
          <NameDialog
            title="Rename"
            label="New name or path"
            hint="A plain name renames in place; a relative path like plugins/old/foo.jar moves it."
            initial={dialog.entry.name}
            validate={(n) => (n.includes("/") ? validateRelativePath(n) : validateName(n))}
            pending={rename.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(to) =>
              rename.mutate({
                from: dialog.entry.path,
                to: to.includes("/") ? to.replace(/^\.\//, "") : joinPath(parentPath(dialog.entry.path), to),
              })
            }
          />
        </LazyDialog>
      ) : null}
      {dialog?.kind === "chmod" ? (
        <LazyDialog title="Change permissions" onClose={() => setDialog(null)}>
          <NameDialog
            title="Change permissions"
            label="Mode (octal)"
            hint={`Applies to ${dialog.entries.length} item(s). 644 = owner read/write, others read; 755 adds execute.`}
            initial={dialog.entries[0]?.mode?.slice(-3) ?? "644"}
            validate={validateMode}
            pending={chmod.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(mode) => {
              setPendingChmod({
                paths: dialog.entries.map((e) => e.path),
                mode,
                folders: dialog.entries.filter((e) => e.type === "dir").length,
              });
              setDialog(null);
            }}
          />
        </LazyDialog>
      ) : null}
      <LazyConfirmDialog
        open={pendingChmod !== null}
        onOpenChange={(o) => !o && !chmod.isPending && setPendingChmod(null)}
        title={`Set mode ${pendingChmod?.mode ?? ""} on ${pendingChmod?.paths.length ?? 0} item(s)?`}
        description={
          pendingChmod?.folders
            ? `${pendingChmod.folders} folder(s) are included: the mode applies to the folders themselves, not to what is inside. A folder without the execute bit (e.g. 644) cannot be entered by the server.`
            : "The server process must still be able to read (and, for its own files, write) them."
        }
        confirmLabel="Change permissions"
        pending={chmod.isPending}
        onConfirm={() =>
          pendingChmod &&
          chmod.mutate(
            { paths: pendingChmod.paths, mode: pendingChmod.mode },
            { onSettled: () => setPendingChmod(null) },
          )
        }
      />
      {dialog?.kind === "compress" ? (
        <LazyDialog title="Compress" onClose={() => setDialog(null)}>
          <CompressDialog
            count={dialog.entries.length}
            pending={compress.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(format) => compress.mutate({ paths: dialog.entries.map((e) => e.path), format })}
          />
        </LazyDialog>
      ) : null}
      <LazyConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => !o && !pending && setDialog(null)}
        title={`Delete ${dialog?.kind === "delete" ? dialog.entries.length : 0} item(s)?`}
        description={
          dialog?.kind === "delete" ? (
            <div className="flex flex-col gap-1">
              <p>This permanently deletes:</p>
              <ul className="max-h-40 overflow-auto font-mono text-xs">
                {dialog.entries.slice(0, 50).map((e) => (
                  <li key={e.path} className="break-all">
                    {e.path}
                    {e.type === "dir" ? "/ (and everything inside)" : ""}
                  </li>
                ))}
                {dialog.entries.length > 50 ? <li>…and {dialog.entries.length - 50} more</li> : null}
              </ul>
            </div>
          ) : null
        }
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => dialog?.kind === "delete" && remove.mutate(dialog.entries.map((e) => e.path))}
      />
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-primary/10 text-sm font-medium">
          Drop to upload to /{path}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {baseName(path) || "Server root"}
      </span>
    </Card>
  );
}
