import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Lock, Save } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Server } from "@blockforge/contracts";
import { filesApi } from "@/lib/api/servers-api";
import { formatBytes } from "@/lib/format";
import { toastError } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { serverActionable } from "@/lib/server-permissions";
import { ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { baseName, languageFor, parentPath } from "./paths";
import { saveFile } from "./save-file";
import type { SaveOutcome } from "./save-file";
import { downloadFile } from "./upload";

const CodeEditor = lazy(() => import("./code-editor"));

interface Loaded {
  content: string;
  /** sha of the version on disk the editor is based on; null for a new file. */
  sha256: string | null;
  readOnlyReason: string | null;
  size: number;
}

export function FileEditor({
  server,
  path,
  isNew,
  onClose,
}: {
  server: Server;
  path: string;
  /** A file that does not exist yet (created on first save). */
  isNew: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const canWrite = serverActionable(server, "servers.files.write");

  const load = useCallback(async () => {
    setLoadError(null);
    if (isNew) {
      setLoaded({ content: "", sha256: null, readOnlyReason: null, size: 0 });
      setText("");
      return;
    }
    try {
      const r = await filesApi.contents(server.id, path);
      const reason =
        r.encoding === "base64"
          ? "This looks like a binary file. Download it to inspect it."
          : r.truncated
            ? `This file is larger than the 5 MiB editor limit (${formatBytes(r.size)}); only the start is shown. Download it to edit.`
            : r.redacted
              ? "Secret values in this file are masked for you, so it is read-only. Ask an administrator with secrets access to edit it."
              : null;
      const content = r.encoding === "base64" ? "" : r.content;
      setLoaded({ content, sha256: r.sha256, readOnlyReason: reason, size: r.size });
      setText(content);
    } catch (err) {
      setLoadError(err);
    }
  }, [isNew, path, server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = loaded !== null && text !== loaded.content;
  const readOnly = !canWrite || !!loaded?.readOnlyReason;

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const applyOutcome = (o: SaveOutcome) => {
    switch (o.kind) {
      case "saved":
        setLoaded((l) => (l ? { ...l, content: text, sha256: o.sha256, size: o.size } : l));
        setConflict(null);
        toast.success(`Saved ${baseName(path)}`);
        void queryClient.invalidateQueries({ queryKey: qk.server(server.id).files(parentPath(path)) });
        return;
      case "conflict":
        setConflict(o.message);
        return;
      case "redacted":
      case "denied":
        toast.error("Not saved", { description: o.message });
        return;
      case "error":
        toastError(o.error, "Not saved");
    }
  };

  const save = async (force = false) => {
    if (!loaded || readOnly || saving) return;
    setSaving(true);
    try {
      applyOutcome(
        await saveFile((b) => filesApi.write(server.id, b), {
          path,
          content: text,
          baseSha256: loaded.sha256,
          force,
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  };

  return (
    <div className="flex h-[calc(100dvh-14rem)] min-h-96 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5">
        <Button size="sm" variant="ghost" onClick={close}>
          <ArrowLeft aria-hidden />
          Files
        </Button>
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
        </code>
        {isNew && !loaded?.sha256 ? <Badge tone="info">New file</Badge> : null}
        {dirty ? <Badge tone="warning">Unsaved</Badge> : null}
        {readOnly ? (
          <Badge tone="neutral">
            <Lock aria-hidden /> Read-only
          </Badge>
        ) : null}
        {!isNew ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              downloadFile(server.id, path, baseName(path)).catch((e: unknown) =>
                toastError(e, "Download failed"),
              )
            }
          >
            <Download aria-hidden />
            Download
          </Button>
        ) : null}
        {!readOnly ? (
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!dirty && !!loaded?.sha256}
            loading={saving}
          >
            <Save aria-hidden />
            Save
          </Button>
        ) : null}
      </div>
      {loaded?.readOnlyReason ? (
        <Callout tone="info" className="m-2">
          {loaded.readOnlyReason}
        </Callout>
      ) : null}
      <div className="min-h-0 flex-1">
        {loadError ? (
          <ErrorState error={loadError} onRetry={() => void load()} title="Could not open the file" />
        ) : !loaded ? (
          <Skeleton className="m-3 h-[calc(100%-1.5rem)]" />
        ) : (
          <Suspense fallback={<Skeleton className="m-3 h-[calc(100%-1.5rem)]" />}>
            <CodeEditor
              value={text}
              onChange={setText}
              language={languageFor(path)}
              readOnly={readOnly}
              onSave={() => void save()}
              ariaLabel={`Editing ${path}`}
            />
          </Suspense>
        )}
      </div>
      <Dialog open={conflict !== null} onOpenChange={(o) => !o && setConflict(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>The file changed on disk</DialogTitle>
            <DialogDescription>
              {baseName(path)} was modified after you opened it (by another user, SFTP, or the server itself).
              Nothing was saved.
            </DialogDescription>
          </DialogHeader>
          {conflict ? <p className="text-xs text-muted-foreground">{conflict}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflict(null)}>
              Keep editing
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setConflict(null);
                void load();
              }}
            >
              Discard mine & reload
            </Button>
            <Button variant="destructive" onClick={() => void save(true)} loading={saving}>
              Overwrite with mine
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {loaded && !loadError ? (
        <div className="border-t px-3 py-1 text-[11px] text-muted-foreground">
          {formatBytes(loaded.size)} on disk · {languageFor(path)} · Ctrl/⌘+S to save
        </div>
      ) : null}
    </div>
  );
}
