import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleX, ExternalLink, Puzzle, RefreshCw, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EXTENSIONS_MANAGE_PERMISSION, REALTIME_EVENT_PAYLOADS } from "@blockforge/contracts";
import type {
  ExtensionList,
  ExtensionUpdateStatus,
  InstalledExtension,
  Me,
  Server,
} from "@blockforge/contracts";
import { extensionsApi } from "@/lib/api/extensions-api";
import { isApiError } from "@/lib/api/errors";
import { formatBytes } from "@/lib/format";
import { useIdempotencyKeys } from "@/lib/idempotency";
import { retryableLazy } from "@/lib/lazy";
import { useApiMutation } from "@/lib/mutations";
import { jobQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { useRealtimeClient, useRealtimeTopic } from "@/lib/realtime/provider";
import { serverActionable } from "@/lib/server-permissions";
import { LazySection } from "@/components/common/chunk-boundary";
import { LazyConfirmDialog } from "@/components/common/lazy-confirm-dialog";
import { LazyDialog } from "@/components/common/lazy-dialog";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LazyJobProgress } from "../lazy-job-progress";
import { ExtensionIcon, SafeLink } from "./extension-ui";
import { SKIPPED_REASON, extensionNames, primaryMetadata, problemsByLevel } from "./extension-model";

/*
 * First paint of the tab is the Installed section. Browse, Updates and History are their own chunks
 * (prefetched on hover/focus of their section triggers), as are the project and upload dialogs
 * (prefetched on hover/focus of the buttons that open them) and the job widget.
 */
const BrowseSection = retryableLazy(() => import("./browse-section"));
const UpdatesSection = retryableLazy(() => import("./updates-section"));
const HistorySection = retryableLazy(() => import("./history-section"));
const ProjectDialog = retryableLazy(() => import("./project-dialog"));
const UploadDialog = retryableLazy(() => import("./upload-dialog"));

type Section = "installed" | "browse" | "updates" | "history";

function SourceBadge({ ext }: { ext: InstalledExtension }) {
  if (ext.source === "modrinth" && ext.modrinth) {
    return (
      <SafeLink href={ext.modrinth.pageUrl} className="inline-flex">
        <Badge tone="info" title="Identified on Modrinth — opens its page">
          Modrinth
          <ExternalLink aria-hidden />
        </Badge>
      </SafeLink>
    );
  }
  if (ext.source === "upload") return <Badge variant="outline">Upload</Badge>;
  return (
    <Badge
      variant="outline"
      title="Found on disk (file manager, SFTP, a plugin's own updater) and not identified on Modrinth"
    >
      Unknown
    </Badge>
  );
}

function Compatibility({ ext }: { ext: InstalledExtension }) {
  if (!ext.compatibility) return <span className="text-xs text-muted-foreground">Not read yet</span>;
  const { errors, warnings } = problemsByLevel(ext.compatibility);
  if (!errors.length && !warnings.length) return <Badge tone="success">OK</Badge>;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {errors.map((p, i) => (
        <li key={`e${i}`} className="flex items-start gap-1 text-danger">
          <CircleX className="mt-0.5 size-3.5 shrink-0" aria-label="error" />
          <span className="break-words">{p.message}</span>
        </li>
      ))}
      {warnings.map((p, i) => (
        <li key={`w${i}`} className="flex items-start gap-1">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-label="warning" />
          <span className="break-words text-muted-foreground">{p.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Follows an extension job; when it ends, the list and history are re-read (the job also rescans). */
function ExtensionJob({
  serverId,
  jobId,
  title,
  onClose,
}: {
  serverId: string;
  jobId: string;
  title: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const job = useQuery({
    ...jobQuery(jobId),
    refetchInterval: (q) =>
      q.state.status === "error" ||
      (q.state.data && ["succeeded", "failed", "cancelled"].includes(q.state.data.status))
        ? false
        : 3_000,
    retry: false,
  });
  const done = job.data && ["succeeded", "failed", "cancelled"].includes(job.data.status);
  useEffect(() => {
    if (!done) return;
    void queryClient.invalidateQueries({ queryKey: qk.server(serverId).extensions });
    void queryClient.invalidateQueries({ queryKey: qk.server(serverId).extensionHistory });
  }, [done, queryClient, serverId]);
  return (
    <div className="flex flex-col gap-1">
      <LazyJobProgress jobId={jobId} title={title} />
      {done || job.isError ? (
        <Button size="sm" variant="ghost" className="self-end" onClick={onClose}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Installed

function InstalledSection({
  server,
  list,
  updates,
  canManage,
  uploadsAllowed,
  onJob,
  onRestart,
  onUpload,
}: {
  server: Server;
  list: ExtensionList;
  updates: ReadonlyMap<string, ExtensionUpdateStatus>;
  canManage: boolean;
  uploadsAllowed: boolean;
  onJob: (jobId: string, title: string) => void;
  onRestart: () => void;
  onUpload: () => void;
}) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<InstalledExtension | null>(null);
  const [removed, setRemoved] = useState<{ name: string; rollbackAvailable: boolean } | null>(null);
  const keys = useIdempotencyKeys<string>();
  const scan = useApiMutation({
    mutationFn: (full: boolean) => extensionsApi.scan(server.id, full, keys.sent(full ? "full" : "scan")),
    success: (_r, full) => (full ? "Full rescan started" : "Scan started"),
    errorTitle: "Could not start the scan",
    onError: (error, full) => keys.settle(full ? "full" : "scan", { ok: false, error }),
    onSuccess: (r, full) => {
      keys.settle(full ? "full" : "scan", { ok: true });
      onJob(r.jobId, full ? "Full rescan" : "Scanning plugins & mods");
    },
  });
  const toggle = useApiMutation({
    mutationFn: (ext: InstalledExtension) => extensionsApi.setEnabled(server.id, ext.id, !ext.enabled),
    success: (r) => (r.extension.enabled ? "Enabled" : "Disabled"),
    errorTitle: "Could not change the extension",
    onSuccess: (r) => {
      queryClient.setQueryData<ExtensionList>(qk.server(server.id).extensions, (prev) =>
        prev ? { ...prev, items: prev.items.map((x) => (x.id === r.extension.id ? r.extension : x)) } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensionHistory });
      if (r.restartRequired) onRestart();
    },
  });
  const remove = useApiMutation({
    mutationFn: (ext: InstalledExtension) => extensionsApi.remove(server.id, ext.id),
    success: "Removed",
    errorTitle: "Could not remove the extension",
    onSuccess: (r, ext) => {
      setRemoving(null);
      setRemoved({ name: extensionNames(ext).join(", "), rollbackAvailable: r.rollbackAvailable });
      queryClient.setQueryData<ExtensionList>(qk.server(server.id).extensions, (prev) =>
        prev ? { ...prev, items: prev.items.filter((x) => x.id !== ext.id) } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensionHistory });
      if (r.restartRequired) onRestart();
    },
  });
  const scanState = list.scan;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {list.kind === "mod" ? "Mods" : "Plugins"} in <code className="font-mono">{list.installDir}/</code>
        </span>
        <span aria-live="polite">
          {scanState.status === "running"
            ? "· Scanning…"
            : scanState.status === "never"
              ? "· Not scanned yet"
              : scanState.status === "failed"
                ? "· Last scan failed"
                : null}
          {scanState.scannedAt ? (
            <>
              {" "}
              · scanned <Timestamp ts={scanState.scannedAt} />
            </>
          ) : null}
        </span>
        {canManage ? (
          <span className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              loading={scan.isPending && scan.variables === false}
              disabled={scanState.status === "running"}
              onClick={() => scan.mutate(false)}
            >
              <RefreshCw aria-hidden />
              Scan now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="Re-hash and re-read every file"
              loading={scan.isPending && scan.variables === true}
              disabled={scanState.status === "running"}
              onClick={() => scan.mutate(true)}
            >
              Full rescan
            </Button>
            {uploadsAllowed ? (
              <Button
                size="sm"
                onClick={onUpload}
                onPointerEnter={() => void UploadDialog.preload()}
                onFocus={() => void UploadDialog.preload()}
              >
                <Upload aria-hidden />
                Upload .jar
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {scanState.status === "failed" && scanState.error ? (
        <Callout tone="danger" title="The last scan failed">
          {scanState.error}
        </Callout>
      ) : null}
      {removed ? (
        <Callout
          tone="info"
          action={
            <Button size="sm" variant="ghost" onClick={() => setRemoved(null)}>
              Dismiss
            </Button>
          }
        >
          “{removed.name}” was removed.
          {removed.rollbackAvailable ? " It can be restored from History." : " It can't be restored."}
        </Callout>
      ) : null}
      {list.truncated ? (
        <Callout tone="warning">More than 4096 jars: only the first 4096 (by file name) are listed.</Callout>
      ) : null}
      {list.items.length === 0 ? (
        <EmptyState
          icon={Puzzle}
          title={`No ${list.kind === "mod" ? "mods" : "plugins"} installed`}
          description={scanState.status === "never" ? "The folder has not been scanned yet." : undefined}
          compact
        />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{list.kind === "mod" ? "Mod" : "Plugin"}</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Compatibility</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.items.map((ext) => {
                const names = extensionNames(ext);
                const meta = primaryMetadata(ext);
                const formats = [...new Set(ext.metadata.map((m) => m.format))];
                const update = updates.get(ext.id);
                const label = names.join(", ");
                return (
                  <TableRow key={ext.id}>
                    <TableCell className="max-w-96">
                      <div className="flex items-start gap-2">
                        <ExtensionIcon url={ext.modrinth?.iconUrl} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium break-words">{label}</span>
                            {meta?.version ? (
                              <span className="text-xs text-muted-foreground">{meta.version}</span>
                            ) : ext.modrinth ? (
                              <span className="text-xs text-muted-foreground">
                                {ext.modrinth.versionNumber}
                              </span>
                            ) : null}
                            {update?.updateAvailable ? (
                              <Badge tone="info" title={`Latest: ${update.latest?.versionNumber ?? "?"}`}>
                                Update available
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            <code className="font-mono break-all">{ext.filename}</code>
                            {formats.map((f) => (
                              <Badge key={f} variant="outline" className="font-normal">
                                {f}
                              </Badge>
                            ))}
                            {ext.metadata.length > 1 ? (
                              <span>{ext.metadata.length} mods in this jar</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <SourceBadge ext={ext} />
                    </TableCell>
                    <TableCell className="max-w-72">
                      <Compatibility ext={ext} />
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap tabular">
                      {formatBytes(ext.sizeBytes)}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={ext.enabled}
                        aria-label={`${ext.enabled ? "Disable" : "Enable"} ${label}`}
                        disabled={!canManage || (toggle.isPending && toggle.variables?.id === ext.id)}
                        onCheckedChange={() => toggle.mutate(ext)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove ${label}`}
                          onClick={() => setRemoving(ext)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {list.skipped.length ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{list.skipped.length} file(s) not listed</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {list.skipped.map((s, i) => (
              <li key={i}>
                <code className="font-mono break-all">{s.name}</code> — {SKIPPED_REASON[s.reason] ?? s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <LazyConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this extension?"
        description={`“${removing ? extensionNames(removing).join(", ") : ""}” (${removing?.filename ?? ""}) is moved out of ${list.installDir}/. Uploaded and unknown files are kept for 30 days so the removal can be rolled back from History.`}
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tab

export default function ExtensionsTab({ server }: { server: Server; me: Me }) {
  const queryClient = useQueryClient();
  const client = useRealtimeClient();
  const [section, setSection] = useState<Section>("installed");
  const [job, setJob] = useState<{ jobId: string; title: string } | null>(null);
  const [restart, setRestart] = useState(false);
  const [project, setProject] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadsOff, setUploadsOff] = useState(false);
  const canManage = serverActionable(server, EXTENSIONS_MANAGE_PERMISSION);
  const list = useQuery({
    queryKey: qk.server(server.id).extensions,
    queryFn: ({ signal }) => extensionsApi.list(server.id, signal),
  });
  // The list carries the upload policy; a refused upload (uploads_disabled, policy changed since) hides it too.
  const uploadsAllowed = !uploadsOff && list.data?.uploads.allowed !== false;
  const updatesCache = useQuery({
    queryKey: qk.server(server.id).extensionUpdates(false),
    queryFn: ({ signal }) => extensionsApi.updates(server.id, false, signal),
    enabled: false,
  });
  const updates = useMemo(
    () => new Map((updatesCache.data?.items ?? []).map((u) => [u.extensionId, u])),
    [updatesCache.data],
  );

  // Live: `extensions.updated` patches the scan status, re-reads changed rows (404 = removed) or the
  // whole list when `changed` is null. Reads can overlap (two events for one extension) and race
  // full re-reads, so a row read is applied only if no newer read of that extension and no full
  // re-read started after it (`reads`): an older response can't resurrect a removed row.
  const reads = useRef({ epoch: 0, gen: new Map<string, number>() });
  const refetchList = () => {
    reads.current.epoch++;
    void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensions });
  };
  useRealtimeTopic(`server:${server.id}`, (event) => {
    if (event.type !== "extensions.updated") return;
    const parsed = REALTIME_EVENT_PAYLOADS["extensions.updated"].safeParse(event.data);
    const key = qk.server(server.id).extensions;
    if (!parsed.success || parsed.data.serverId !== server.id) {
      refetchList();
      return;
    }
    const ev = parsed.data;
    queryClient.setQueryData<ExtensionList>(key, (prev) => (prev ? { ...prev, scan: ev.scan } : prev));
    void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensionHistory });
    if (ev.changed === null) {
      refetchList();
      return;
    }
    const r = reads.current;
    for (const id of ev.changed) {
      const gen = (r.gen.get(id) ?? 0) + 1;
      r.gen.set(id, gen);
      const epoch = r.epoch;
      const latest = () => r.gen.get(id) === gen && r.epoch === epoch;
      extensionsApi.get(server.id, id).then(
        (ext) => {
          if (!latest()) return;
          queryClient.setQueryData<ExtensionList>(key, (prev) => {
            if (!prev) return prev;
            const i = prev.items.findIndex((x) => x.id === ext.id);
            const items =
              i === -1 ? [...prev.items, ext] : prev.items.map((x) => (x.id === ext.id ? ext : x));
            return { ...prev, items: items.sort((a, b) => a.filename.localeCompare(b.filename)) };
          });
        },
        (err: unknown) => {
          if (!latest()) return;
          if (isApiError(err) && err.status === 404)
            queryClient.setQueryData<ExtensionList>(key, (prev) =>
              prev ? { ...prev, items: prev.items.filter((x) => x.id !== id) } : prev,
            );
          else refetchList();
        },
      );
    }
  });
  useEffect(
    () =>
      client?.onReconnect(() => {
        reads.current.epoch++;
        void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensions });
        void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensionHistory });
      }),
    [client, queryClient, server.id],
  );

  const onJob = (jobId: string, title: string) => setJob({ jobId, title });
  const onRestart = () => setRestart(true);

  if (list.isPending) return <TableSkeleton columns={5} rows={4} />;
  if (list.isError)
    return (
      <ErrorState
        error={list.error}
        onRetry={() => void list.refetch()}
        title="Could not load plugins and mods"
      />
    );
  if (list.data.installDir === null)
    return (
      <EmptyState
        icon={Puzzle}
        title="This server software loads no plugins or mods"
        description="Vanilla Minecraft and non-Minecraft servers have no plugins/ or mods/ folder."
      />
    );
  const data = list.data;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{data.kind === "mod" ? "Mods" : "Plugins"}</CardTitle>
          <CardDescription>
            Installed from Modrinth, uploaded, or found in {data.installDir}/. Changes apply at the next
            start.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {restart ? (
          <Callout
            tone="warning"
            title="Restart required"
            action={
              <Button size="sm" variant="ghost" onClick={() => setRestart(false)}>
                Dismiss
              </Button>
            }
          >
            Plugins and mods load at start: restart the server for the changes to take effect.
          </Callout>
        ) : null}
        {uploadsOff ? (
          <Callout tone="info">Uploading plugins and mods is turned off by an administrator.</Callout>
        ) : null}
        {job ? (
          <ExtensionJob
            key={job.jobId}
            serverId={server.id}
            jobId={job.jobId}
            title={job.title}
            onClose={() => setJob(null)}
          />
        ) : null}
        <Tabs value={section} onValueChange={(v) => setSection(v as Section)}>
          <TabsList>
            <TabsTrigger value="installed">Installed ({data.items.length})</TabsTrigger>
            <TabsTrigger
              value="browse"
              onPointerEnter={() => void BrowseSection.preload()}
              onFocus={() => void BrowseSection.preload()}
            >
              Browse Modrinth
            </TabsTrigger>
            <TabsTrigger
              value="updates"
              onPointerEnter={() => void UpdatesSection.preload()}
              onFocus={() => void UpdatesSection.preload()}
            >
              Updates
            </TabsTrigger>
            <TabsTrigger
              value="history"
              onPointerEnter={() => void HistorySection.preload()}
              onFocus={() => void HistorySection.preload()}
            >
              History
            </TabsTrigger>
          </TabsList>
          <TabsContent value="installed">
            <InstalledSection
              server={server}
              list={data}
              updates={updates}
              canManage={canManage}
              uploadsAllowed={uploadsAllowed}
              onJob={onJob}
              onRestart={onRestart}
              onUpload={() => setUploading(true)}
            />
          </TabsContent>
          <TabsContent value="browse">
            <LazySection what="the Modrinth browser" loading={<TableSkeleton columns={3} rows={4} />}>
              <BrowseSection
                server={server}
                onOpen={setProject}
                onPrefetchOpen={() => void ProjectDialog.preload()}
              />
            </LazySection>
          </TabsContent>
          <TabsContent value="updates">
            <LazySection what="the update check" loading={<TableSkeleton columns={3} rows={3} />}>
              <UpdatesSection server={server} list={data} canManage={canManage} onJob={onJob} />
            </LazySection>
          </TabsContent>
          <TabsContent value="history">
            <LazySection what="the history" loading={<TableSkeleton columns={5} rows={4} />}>
              <HistorySection server={server} canManage={canManage} onJob={onJob} />
            </LazySection>
          </TabsContent>
        </Tabs>
      </CardContent>
      {project ? (
        <LazyDialog title="Modrinth project" onClose={() => setProject(null)}>
          <ProjectDialog
            server={server}
            project={project}
            canManage={canManage}
            onClose={() => setProject(null)}
            onJob={(jobId, title, restartRequired) => {
              onJob(jobId, title);
              if (restartRequired) onRestart();
            }}
          />
        </LazyDialog>
      ) : null}
      {uploading ? (
        <LazyDialog title="Upload a plugin or mod" onClose={() => setUploading(false)}>
          <UploadDialog
            server={server}
            onClose={() => setUploading(false)}
            onUploadsDisabled={() => {
              setUploadsOff(true);
              setUploading(false);
            }}
            onInstalled={(restartRequired) => {
              void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensions });
              void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensionHistory });
              if (restartRequired) onRestart();
            }}
          />
        </LazyDialog>
      ) : null}
    </Card>
  );
}
