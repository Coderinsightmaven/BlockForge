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
import { useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import type { FileEntry, Server } from "@blockforge/contracts";
import { filesApi } from "@/lib/api/servers-api";
import { formatBytes, formatTimestamp } from "@/lib/format";
import { toastError, useApiMutation } from "@/lib/mutations";
import { fileListQuery, fileSearchQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { serverActionable, serverCan } from "@/lib/server-permissions";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SpacerRow, VirtualTable, useVirtualRows } from "@/components/ui/virtual-table";
import { FileEditor } from "./file-editor";
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
import { downloadFile, uploadFile } from "./upload";
import type { UploadProgress } from "./upload";

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

function NameDialog({
  title,
  label,
  initial,
  hint,
  validate,
  onSubmit,
  onClose,
  pending,
}: {
  title: string;
  label: string;
  initial: string;
  hint?: string;
  validate: (v: string) => string | null;
  onSubmit: (v: string) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = validate(value);
    setError(err);
    if (!err) onSubmit(value.trim());
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <Field label={label} error={error} hint={hint}>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
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
}: {
  server: Server;
  path: string;
  editing: string | null;
  onNavigate: (path: string) => void;
  onEdit: (path: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const canWrite = serverActionable(server, "servers.files.write");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
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
    success: "Copy created",
    errorTitle: "Could not copy",
    onSuccess: () => refresh(),
  });
  const compress = useApiMutation({
    mutationFn: (b: { paths: string[]; format: "tar.gz" | "zip" }) =>
      filesApi.compress(server.id, { root: path, ...b }),
    success: "Archive created",
    errorTitle: "Could not create the archive",
    onSuccess: () => {
      refresh();
      done();
    },
  });
  const decompress = useApiMutation({
    mutationFn: (p: string) => filesApi.decompress(server.id, { path: p, destination: path }),
    success: "Archive extracted",
    errorTitle: "Could not extract",
    onSuccess: () => refresh(),
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

  const startUploads = (files: FileList | File[]) => {
    const dir = path;
    const items = [...files].map((f) => ({
      file: f,
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    }));
    setUploads((u) => [
      ...u.filter((x) => x.status === "uploading" || x.status === "pending"),
      ...items.map(({ file, id }) => ({
        id,
        name: file.name,
        size: file.size,
        loaded: 0,
        status: "pending" as const,
      })),
    ]);
    // Sequential: keeps the node's disk and the user's uplink from being saturated by many parallel streams.
    void (async () => {
      for (const { file, id } of items) {
        const patch = (p: Partial<UploadProgress>) =>
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)));
        patch({ status: "uploading" });
        try {
          await uploadFile(server.id, dir, file, (loaded) => patch({ loaded }));
          patch({ status: "done", loaded: file.size });
        } catch (err) {
          patch({ status: "error", error: err instanceof Error ? err.message : "Upload failed" });
        }
      }
      refresh([dir]);
    })();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canWrite && e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
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
      <FileEditor
        key={p}
        server={server}
        path={p}
        isNew={!editing && !!newFile}
        onClose={() => {
          setNewFile(null);
          onEdit(null);
          refresh([parentPath(p)]);
        }}
      />
    );
  }

  const allChecked = entries.length > 0 && entries.every((e) => selected.has(e.path));
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
            <DropdownMenuItem onSelect={() => setDialog({ kind: "compress", entries: [e] })}>
              <Archive aria-hidden /> Compress
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog({ kind: "chmod", entries: [e] })}>
              <KeyRound aria-hidden /> Permissions
            </DropdownMenuItem>
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
                if (e.target.files?.length) startUploads(e.target.files);
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
                    aria-label="Select all"
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
                    <button
                      type="button"
                      onClick={() => open(e)}
                      className="flex max-w-full items-center gap-2 text-left hover:underline"
                      title={e.path}
                    >
                      <EntryIcon entry={e} />
                      <span className="truncate">{searchQ ? e.path : e.name}</span>
                    </button>
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
        <NameDialog
          title="Create folder"
          label="Folder name"
          initial=""
          validate={validateName}
          pending={mkdir.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(name) => mkdir.mutate(name)}
        />
      ) : null}
      {dialog?.kind === "new-file" ? (
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
      ) : null}
      {dialog?.kind === "rename" ? (
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
      ) : null}
      {dialog?.kind === "chmod" ? (
        <NameDialog
          title="Change permissions"
          label="Mode (octal)"
          hint={`Applies to ${dialog.entries.length} item(s). 644 = owner read/write, others read; 755 adds execute.`}
          initial={dialog.entries[0]?.mode?.slice(-3) ?? "644"}
          validate={validateMode}
          pending={chmod.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(mode) => chmod.mutate({ paths: dialog.entries.map((e) => e.path), mode })}
        />
      ) : null}
      {dialog?.kind === "compress" ? (
        <CompressDialog
          count={dialog.entries.length}
          pending={compress.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(format) => compress.mutate({ paths: dialog.entries.map((e) => e.path), format })}
        />
      ) : null}
      <ConfirmDialog
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

function CompressDialog({
  count,
  pending,
  onClose,
  onSubmit,
}: {
  count: number;
  pending: boolean;
  onClose: () => void;
  onSubmit: (format: "tar.gz" | "zip") => void;
}) {
  const [format, setFormat] = useState<"tar.gz" | "zip">("tar.gz");
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Compress {count} item(s)</DialogTitle>
          <DialogDescription>The archive is created in the current folder.</DialogDescription>
        </DialogHeader>
        <Field label="Format">
          <Select
            value={format}
            onValueChange={setFormat}
            options={[
              { value: "tar.gz", label: "tar.gz (keeps permissions)" },
              { value: "zip", label: "zip (opens everywhere)" },
            ]}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(format)} loading={pending}>
            Compress
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
