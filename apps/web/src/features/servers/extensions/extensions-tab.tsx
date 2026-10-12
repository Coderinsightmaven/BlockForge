import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleX,
  Download,
  ExternalLink,
  History,
  PackageSearch,
  Puzzle,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  EXTENSIONS_MANAGE_PERMISSION,
  EXTENSION_UPDATE_PROBLEMS,
  ModrinthCategoryTag,
  REALTIME_EVENT_PAYLOADS,
} from "@blockforge/contracts";
import type {
  ExtensionList,
  ExtensionUpdateStatus,
  InstalledExtension,
  Me,
  Server,
} from "@blockforge/contracts";
import { extensionsApi } from "@/lib/api/phase4b-api";
import type { ModrinthSearchParams } from "@/lib/api/phase4b-api";
import { isApiError } from "@/lib/api/errors";
import { formatBytes, formatNumber } from "@/lib/format";
import { useIdempotencyKeys } from "@/lib/idempotency";
import { useApiMutation } from "@/lib/mutations";
import { jobQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { useRealtimeClient, useRealtimeTopic } from "@/lib/realtime/provider";
import { serverActionable } from "@/lib/server-permissions";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { JobProgress } from "../server-common";
import { ExtensionIcon, SafeLink } from "./extension-ui";
import {
  HISTORY_ACTION_LABEL,
  ROLLBACK_UNAVAILABLE,
  SKIPPED_REASON,
  extensionNames,
  historyChange,
  primaryMetadata,
  problemsByLevel,
} from "./extension-model";

// Dialogs load on first use (the tab itself is already a lazy chunk).
const ProjectDialog = lazy(() => import("./project-dialog"));
const UploadDialog = lazy(() => import("./upload-dialog"));

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
      <JobProgress jobId={jobId} title={title} />
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
              <Button size="sm" onClick={onUpload}>
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
      <ConfirmDialog
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
// Browse (Modrinth)

const CATEGORIES = [
  "adventure",
  "economy",
  "game-mechanics",
  "library",
  "management",
  "minigame",
  "optimization",
  "social",
  "storage",
  "technology",
  "transportation",
  "utility",
  "worldgen",
].filter((c) => ModrinthCategoryTag.safeParse(c).success);

const SORTS = [
  { value: "relevance" as const, label: "Relevance" },
  { value: "downloads" as const, label: "Downloads" },
  { value: "follows" as const, label: "Follows" },
  { value: "newest" as const, label: "Newest" },
  { value: "updated" as const, label: "Recently updated" },
];
const PAGE = 20;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function BrowseSection({ server, onOpen }: { server: Server; onOpen: (project: string) => void }) {
  const [text, setText] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [sort, setSort] = useState<NonNullable<ModrinthSearchParams["sort"]>>("relevance");
  const [offset, setOffset] = useState(0);
  const query = useDebounced(text.trim(), 350);
  useEffect(() => setOffset(0), [query, categories, sort]);
  const params: ModrinthSearchParams = { query, categories, sort, offset, limit: PAGE };
  const q = useQuery({
    queryKey: qk.server(server.id).modrinthSearch(params),
    queryFn: ({ signal }) => extensionsApi.search(server.id, params, signal),
    staleTime: 60_000,
  });
  const toggleCategory = (c: string) =>
    setCategories((list) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c].slice(0, 8)));
  const rateLimited = isApiError(q.error) && q.error.code === "RATE_LIMITED";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search Modrinth"
          aria-label="Search Modrinth"
          maxLength={256}
          className="max-w-sm"
        />
        <Select value={sort} onValueChange={setSort} options={SORTS} aria-label="Sort by" className="w-44" />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
        {CATEGORIES.map((c) => (
          <Button
            key={c}
            size="sm"
            variant={categories.includes(c) ? "default" : "outline"}
            aria-pressed={categories.includes(c)}
            className="h-6 px-2 text-xs"
            onClick={() => toggleCategory(c)}
          >
            {c}
          </Button>
        ))}
      </div>
      {q.isPending ? (
        <TableSkeleton columns={3} rows={4} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title={
            rateLimited
              ? "Modrinth is rate-limiting requests — try again in a moment"
              : "Could not search Modrinth"
          }
          compact
        />
      ) : q.data.hits.length === 0 ? (
        <EmptyState icon={PackageSearch} title="Nothing found for this server" compact />
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-md border">
            {q.data.hits.map((h) => (
              <li key={h.projectId} className="flex items-start gap-3 p-3">
                <ExtensionIcon url={h.iconUrl} className="size-10" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium break-words">{h.title}</span>
                    <span className="text-xs text-muted-foreground">by {h.author}</span>
                    {h.installed ? <Badge tone="success">Installed</Badge> : null}
                    {h.loaderMatch === "warning" ? (
                      <Badge
                        tone="warning"
                        title="Only a loader that runs here with a warning matches (e.g. a Quilt mod on Fabric) — it may not work."
                      >
                        Loader warning
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-sm break-words text-muted-foreground">{h.description}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span className="tabular">{formatNumber(h.downloads, 0)} downloads</span>
                    {h.loaders.map((l) => (
                      <Badge key={l} variant="outline" className="font-normal">
                        {l}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`View ${h.title}`}
                  onClick={() => onOpen(h.slug ?? h.projectId)}
                >
                  View
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {q.data.filteredOut > 0
                ? `${q.data.filteredOut} result(s) on this page hidden: they don't run on this server or are client-only.`
                : ""}
            </span>
            <span className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                Previous
              </Button>
              <span className="tabular">
                {offset + 1}–{offset + q.data.hits.length + q.data.filteredOut} of{" "}
                {formatNumber(q.data.totalHits, 0)}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE >= q.data.totalHits}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Updates

function UpdatesSection({
  server,
  list,
  canManage,
  onJob,
}: {
  server: Server;
  list: ExtensionList;
  canManage: boolean;
  onJob: (jobId: string, title: string) => void;
}) {
  const [allowPrerelease, setAllowPrerelease] = useState(false);
  const [checked, setChecked] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const q = useQuery({
    queryKey: qk.server(server.id).extensionUpdates(allowPrerelease),
    queryFn: ({ signal }) => extensionsApi.updates(server.id, allowPrerelease, signal),
    enabled: checked,
    staleTime: 5 * 60_000,
  });
  const keys = useIdempotencyKeys<string>();
  const ids = [...selected].sort();
  const action = JSON.stringify([ids, allowPrerelease]);
  const apply = useApiMutation({
    mutationFn: (body: { extensionIds: string[]; allowPrerelease: boolean }) =>
      extensionsApi.applyUpdates(
        server.id,
        body,
        keys.sent(JSON.stringify([body.extensionIds, body.allowPrerelease])),
      ),
    success: "Updating",
    errorTitle: "Could not apply the updates",
    onError: (error, body) =>
      keys.settle(JSON.stringify([body.extensionIds, body.allowPrerelease]), { ok: false, error }),
    onSuccess: (r, body) => {
      keys.settle(JSON.stringify([body.extensionIds, body.allowPrerelease]), { ok: true });
      setSelected(new Set());
      onJob(r.jobId, `Updating ${body.extensionIds.length} extension(s)`);
    },
  });
  const locked = keys.isLocked(action);
  const byId = new Map(list.items.map((e) => [e.id, e]));
  const available = (q.data?.items ?? []).filter((u) => u.updateAvailable);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          loading={q.isFetching}
          onClick={() => (checked ? void q.refetch() : setChecked(true))}
        >
          <RefreshCw aria-hidden />
          Check for updates
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={allowPrerelease} onCheckedChange={setAllowPrerelease} disabled={locked} />
          Include beta/alpha versions
        </label>
        {q.data ? (
          <span className="text-xs text-muted-foreground">
            Checked <Timestamp ts={q.data.checkedAt} />
          </span>
        ) : null}
      </div>
      {allowPrerelease ? (
        <Callout tone="warning">
          Pre-release versions can be unstable or break worlds — back up first.
        </Callout>
      ) : null}
      {!checked ? (
        <p className="text-sm text-muted-foreground">
          Checks the Modrinth-identified extensions for newer compatible versions.
        </p>
      ) : q.isPending ? (
        <TableSkeleton columns={3} rows={3} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Could not check for updates"
          compact
        />
      ) : available.length === 0 ? (
        <EmptyState
          icon={Download}
          title="Everything is up to date"
          description="Only Modrinth-identified files can be checked."
          compact
        />
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-md border">
            {available.map((u) => {
              const ext = byId.get(u.extensionId);
              const name = ext ? extensionNames(ext).join(", ") : u.path;
              const id = `upd-${u.extensionId}`;
              return (
                <li key={u.extensionId} className="flex items-center gap-3 p-3 text-sm">
                  {canManage ? (
                    <Checkbox
                      id={id}
                      checked={selected.has(u.extensionId)}
                      disabled={!u.file || locked}
                      onCheckedChange={(c) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (c === true) n.add(u.extensionId);
                          else n.delete(u.extensionId);
                          return n;
                        })
                      }
                      aria-label={`Update ${name}`}
                    />
                  ) : null}
                  <label htmlFor={id} className="min-w-0 flex-1">
                    <span className="font-medium break-words">{name}</span>{" "}
                    <span className="text-muted-foreground tabular">
                      {u.current?.versionNumber ?? "?"} → {u.latest?.versionNumber ?? "?"}
                    </span>
                    {u.latest && u.latest.versionType !== "release" ? (
                      <Badge tone="warning" className="ml-1.5">
                        {u.latest.versionType}
                      </Badge>
                    ) : null}
                    {u.problem ? (
                      <span className="block text-xs text-danger">
                        Can't be applied: {EXTENSION_UPDATE_PROBLEMS[u.problem]}.
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
          {canManage ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={selected.size === 0}
                loading={apply.isPending}
                onClick={() => apply.mutate({ extensionIds: ids, allowPrerelease })}
              >
                Apply {selected.size || ""} update{selected.size === 1 ? "" : "s"}
              </Button>
              {locked ? (
                <span role="status" className="text-xs">
                  The previous request's outcome is unknown; applying again retries the same request.
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// History

function HistorySection({
  server,
  canManage,
  onJob,
}: {
  server: Server;
  canManage: boolean;
  onJob: (jobId: string, title: string) => void;
}) {
  const [confirm, setConfirm] = useState<{ id: string; name: string; change: string } | null>(null);
  const q = useInfiniteQuery({
    queryKey: qk.server(server.id).extensionHistory,
    queryFn: ({ signal, pageParam }) =>
      extensionsApi.history(server.id, { limit: 25, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const keys = useIdempotencyKeys<string>();
  const rollback = useApiMutation({
    mutationFn: (entryId: string) => extensionsApi.rollback(server.id, entryId, keys.sent(entryId)),
    success: "Rollback started",
    errorTitle: "Could not roll back",
    onError: (error, id) => keys.settle(id, { ok: false, error }),
    onSuccess: (r, id) => {
      keys.settle(id, { ok: true });
      setConfirm(null);
      onJob(r.jobId, "Rolling back");
    },
  });
  const entries = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isPending) return <TableSkeleton columns={5} rows={4} />;
  if (q.isError)
    return (
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        title="Could not load the history"
        compact
      />
    );
  if (entries.length === 0) return <EmptyState icon={History} title="No changes yet" compact />;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Rollback</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs whitespace-nowrap">
                  <Timestamp ts={e.at} />
                </TableCell>
                <TableCell className="max-w-96 text-sm">
                  <span className="font-medium">{HISTORY_ACTION_LABEL[e.action]}</span>{" "}
                  <span className="break-words">{e.extensionName}</span>
                  <span className="block text-xs text-muted-foreground tabular">{historyChange(e)}</span>
                </TableCell>
                <TableCell className="text-xs">
                  {e.actor.name ??
                    (e.actor.type === "system"
                      ? "System"
                      : e.actor.type === "schedule"
                        ? "A schedule"
                        : "Unknown")}
                  {e.actor.type === "api_token" ? (
                    <span className="text-muted-foreground"> (API key)</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs">
                  {e.status === "succeeded" ? (
                    <Badge tone="success">Succeeded</Badge>
                  ) : (
                    <>
                      <Badge tone="danger">Failed</Badge>
                      {e.error ? (
                        <span className="mt-0.5 block break-words text-danger">{e.error}</span>
                      ) : null}
                    </>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Tooltip
                      content={
                        e.rollback.available
                          ? null
                          : e.rollback.reason
                            ? ROLLBACK_UNAVAILABLE[e.rollback.reason]
                            : null
                      }
                    >
                      <span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!e.rollback.available}
                          aria-label={`Roll back: ${HISTORY_ACTION_LABEL[e.action]} ${e.extensionName}`}
                          onClick={() =>
                            setConfirm({ id: e.id, name: e.extensionName, change: historyChange(e) })
                          }
                        >
                          Roll back
                        </Button>
                      </span>
                    </Tooltip>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {q.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          loading={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load older changes
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Roll back this change?"
        description={`“${confirm?.name ?? ""}” goes back (${confirm?.change ?? ""}, reversed). Takes effect at the next server start.${
          keys.isLocked(confirm?.id ?? "")
            ? " The previous request's outcome is unknown; confirming retries the same request."
            : ""
        }`}
        confirmLabel="Roll back"
        pending={rollback.isPending}
        onConfirm={() => confirm && rollback.mutate(confirm.id)}
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
  // whole list when `changed` is null.
  useRealtimeTopic(`server:${server.id}`, (event) => {
    if (event.type !== "extensions.updated") return;
    const parsed = REALTIME_EVENT_PAYLOADS["extensions.updated"].safeParse(event.data);
    const key = qk.server(server.id).extensions;
    if (!parsed.success || parsed.data.serverId !== server.id) {
      void queryClient.invalidateQueries({ queryKey: key });
      return;
    }
    const ev = parsed.data;
    queryClient.setQueryData<ExtensionList>(key, (prev) => (prev ? { ...prev, scan: ev.scan } : prev));
    void queryClient.invalidateQueries({ queryKey: qk.server(server.id).extensionHistory });
    if (ev.changed === null) {
      void queryClient.invalidateQueries({ queryKey: key });
      return;
    }
    for (const id of ev.changed) {
      extensionsApi.get(server.id, id).then(
        (ext) =>
          queryClient.setQueryData<ExtensionList>(key, (prev) => {
            if (!prev) return prev;
            const i = prev.items.findIndex((x) => x.id === ext.id);
            const items =
              i === -1 ? [...prev.items, ext] : prev.items.map((x) => (x.id === ext.id ? ext : x));
            return { ...prev, items: items.sort((a, b) => a.filename.localeCompare(b.filename)) };
          }),
        (err: unknown) => {
          if (isApiError(err) && err.status === 404)
            queryClient.setQueryData<ExtensionList>(key, (prev) =>
              prev ? { ...prev, items: prev.items.filter((x) => x.id !== id) } : prev,
            );
          else void queryClient.invalidateQueries({ queryKey: key });
        },
      );
    }
  });
  useEffect(
    () =>
      client?.onReconnect(() => {
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
            <TabsTrigger value="browse">Browse Modrinth</TabsTrigger>
            <TabsTrigger value="updates">Updates</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
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
            <BrowseSection server={server} onOpen={setProject} />
          </TabsContent>
          <TabsContent value="updates">
            <UpdatesSection server={server} list={data} canManage={canManage} onJob={onJob} />
          </TabsContent>
          <TabsContent value="history">
            <HistorySection server={server} canManage={canManage} onJob={onJob} />
          </TabsContent>
        </Tabs>
      </CardContent>
      <Suspense fallback={null}>
        {project ? (
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
        ) : null}
        {uploading ? (
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
        ) : null}
      </Suspense>
    </Card>
  );
}
