import { useQuery } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import { ArrowLeft, Lock } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Me, Server } from "@blockforge/contracts";
import { isApiError } from "@/lib/api/errors";
import { retryableLazy } from "@/lib/lazy";
import { serverQuery } from "@/lib/queries";
import { useServerRealtime } from "@/lib/realtime/server-handlers";
import { resolveServerTab, serverCan, visibleServerTabs } from "@/lib/server-permissions";
import type { ServerTab } from "@/lib/server-permissions";
import type { TimeRange } from "@/lib/time-range";
import { ChunkBoundary, ChunkError, LazySection } from "@/components/common/chunk-boundary";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerStateBadge } from "@/components/ui/status";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { shouldBlockEditorLeave } from "./editor-guard";
import { LazyJobProgress } from "./lazy-job-progress";
import type { PowerAction } from "./server-common";
import { PowerControls, ServerAddress, StateHint, SuspendedBanner } from "./server-common";

/*
 * The route's own first load is the page frame (header, power controls, banners, tab list). Every
 * tab, the Console included, is its own chunk: the requested tab's chunk starts downloading as soon
 * as the page mounts (in parallel with the server request), any other tab's when its trigger is
 * hovered or focused, at the latest when it is opened (the tab skeleton shows meanwhile). A tab
 * whose chunk fails to download shows an error with Retry.
 */
const TABS = {
  console: retryableLazy(() => import("./console/console-tab")),
  stats: retryableLazy(() => import("./tabs/stats-tab")),
  files: retryableLazy(() => import("./files/files-tab")),
  extensions: retryableLazy(() => import("./extensions/extensions-tab")),
  players: retryableLazy(() => import("./players/players-tab")),
  backups: retryableLazy(() => import("./tabs/backups-tab")),
  schedules: retryableLazy(() => import("./tabs/schedules-tab")),
  startup: retryableLazy(() => import("./tabs/startup-tab")),
  network: retryableLazy(() => import("./tabs/network-tab")),
  users: retryableLazy(() => import("./tabs/users-tab")),
  activity: retryableLazy(() => import("./tabs/activity-tab")),
  settings: retryableLazy(() => import("./tabs/settings-tab")),
} satisfies Record<ServerTab, { preload: () => Promise<void> }>;

/** Start downloading a tab's chunk (page mount, hover/focus of its trigger). Never rejects. */
export function prefetchServerTab(tab: ServerTab): void {
  void (TABS as Partial<Record<string, { preload: () => Promise<void> }>>)[tab]?.preload();
}

// Shown only when relevant (EULA not accepted, a job running or failed): loaded on demand. Until the
// chunk arrives they render nothing, exactly as they do while their own data is still loading.
const EulaBanner = retryableLazy(() => import("./eula-banner").then((m) => ({ default: m.EulaBanner })));
const PowerJobNotice = retryableLazy(() =>
  import("./server-jobs").then((m) => ({ default: m.PowerJobNotice })),
);

export interface ServerPageSearch {
  tab?: ServerTab;
  path?: string;
  edit?: string;
  range?: string;
}

function TabFallback() {
  return (
    <div className="flex flex-col gap-3 pt-4" aria-busy aria-label="Loading">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** Job shown above the tabs: provisioning / reinstall (power jobs are quick and show as state). */
function activeInstallJob(server: Server): { jobId: string; title: string } | null {
  if (!server.activeJobId) return null;
  if (server.activeOperation === "provision" || server.state === "provisioning")
    return { jobId: server.activeJobId, title: "Installing server" };
  if (server.activeOperation === "reinstall")
    return { jobId: server.activeJobId, title: "Reinstalling server" };
  if (server.activeOperation === "delete" || server.state === "deleting")
    return { jobId: server.activeJobId, title: "Deleting server" };
  if (server.activeOperation === "restore" || server.state === "restoring")
    return { jobId: server.activeJobId, title: "Restoring backup" };
  return null;
}

export function ServerPage({
  me,
  serverId,
  search,
  range,
  onSearch,
  onRangeChange,
}: {
  me: Me;
  serverId: string;
  search: ServerPageSearch;
  range: TimeRange;
  onSearch: (patch: Partial<ServerPageSearch>) => void;
  onRangeChange: (r: TimeRange) => void;
}) {
  const query = useQuery(serverQuery(serverId));
  const [eulaPrompt, setEulaPrompt] = useState(false);
  const [powerJob, setPowerJob] = useState<{ jobId: string; action: PowerAction } | null>(null);
  const server = query.data;
  useServerRealtime(serverId, !!server);
  // Unsaved file-editor changes guard every way of leaving the editor: tab switches, links,
  // back/forward. (The editor's own Back button asks first and clears the flag; reloads/closing
  // the tab are covered by the editor's beforeunload handler.)
  const editorDirty = useRef(false);
  const onEditorDirty = useCallback((d: boolean) => {
    editorDirty.current = d;
  }, []);
  const shouldBlockFn = useCallback(
    ({
      current,
      next,
    }: {
      current: { pathname: string; search: unknown };
      next: { pathname: string; search: unknown };
    }) => shouldBlockEditorLeave(editorDirty, current, next),
    [],
  );
  useBlocker({ shouldBlockFn, enableBeforeUnload: false });
  // Download the requested tab while the server itself is still being fetched.
  const requestedTab = search.tab ?? "console";
  useEffect(() => prefetchServerTab(requestedTab), [requestedTab]);

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy aria-label="Loading server">
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-9 w-full max-w-xl" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (!server) {
    if (isApiError(query.error) && (query.error.code === "NOT_FOUND" || query.error.code === "FORBIDDEN")) {
      return (
        <EmptyState
          icon={Lock}
          title="Server not found"
          description="It may have been deleted, or you don't have access to it."
          action={
            <Button asChild variant="outline">
              <Link to="/servers">Back to servers</Link>
            </Button>
          }
        />
      );
    }
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        title="Could not load the server"
      />
    );
  }

  const tabs = visibleServerTabs(server);
  const tab = resolveServerTab(server, search.tab);
  const job = activeInstallJob(server);

  return (
    <>
      <Link
        to="/servers"
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Servers
      </Link>
      <PageHeader
        title={
          <>
            <span className="min-w-0 truncate">{server.name}</span>
            <ServerStateBadge state={server.state} />
            {server.suspended ? <Badge tone="danger">Suspended</Badge> : null}
            <StateHint server={server} />
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ServerAddress server={server} />
            <span>
              {server.software ? `${server.software} ${server.minecraftVersion ?? ""}` : server.templateName}
            </span>
            <span>Node {server.nodeName}</span>
            {server.ownerId !== me.user.id ? <span>Owner {server.ownerName}</span> : null}
          </span>
        }
        actions={
          serverCan(server, "servers.control") ? (
            <PowerControls server={server} onJob={(jobId, action) => setPowerJob({ jobId, action })} />
          ) : null
        }
      />
      <div className="flex flex-col gap-3">
        <SuspendedBanner server={server} />
        {server.game === "minecraft-java" ? (
          <ChunkBoundary fallback={(retry) => <ChunkError what="the EULA check" retry={retry} compact />}>
            <Suspense fallback={null}>
              <EulaBanner server={server} promptSeen={eulaPrompt} onAccepted={() => setEulaPrompt(false)} />
            </Suspense>
          </ChunkBoundary>
        ) : null}
        {powerJob ? (
          <ChunkBoundary
            key={powerJob.jobId}
            fallback={(retry) => <ChunkError what="the power job's status" retry={retry} compact />}
          >
            <Suspense fallback={null}>
              <PowerJobNotice
                jobId={powerJob.jobId}
                action={powerJob.action}
                onFailed={(code) => {
                  if (code === "EULA_NOT_ACCEPTED") setEulaPrompt(true);
                }}
                onDismiss={() => setPowerJob(null)}
              />
            </Suspense>
          </ChunkBoundary>
        ) : null}
        {job ? <LazyJobProgress jobId={job.jobId} title={job.title} /> : null}
      </div>

      {tab === null ? (
        <EmptyState
          icon={Lock}
          title="Nothing to show"
          description="Your access to this server doesn't include any of its pages."
        />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => onSearch({ tab: v as ServerTab, path: undefined, edit: undefined })}
          className="mt-3"
        >
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                onPointerEnter={() => prefetchServerTab(t.id)}
                onFocus={() => prefetchServerTab(t.id)}
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="pt-4">
            <LazySection key={tab} what="this tab" loading={<TabFallback />}>
              {tab === "console" ? (
                <TABS.console server={server} onEulaPrompt={() => setEulaPrompt(true)} />
              ) : null}
              {tab === "stats" ? (
                <TABS.stats server={server} range={range} onRangeChange={onRangeChange} />
              ) : null}
              {tab === "files" ? (
                <TABS.files
                  server={server}
                  path={search.path ?? ""}
                  editing={search.edit ?? null}
                  onNavigate={(path) => onSearch({ path: path || undefined, edit: undefined })}
                  onEdit={(edit) => onSearch({ edit: edit ?? undefined })}
                  onEditorDirty={onEditorDirty}
                />
              ) : null}
              {tab === "extensions" ? <TABS.extensions server={server} me={me} /> : null}
              {tab === "players" ? <TABS.players server={server} /> : null}
              {tab === "backups" ? <TABS.backups server={server} me={me} /> : null}
              {tab === "schedules" ? <TABS.schedules server={server} /> : null}
              {tab === "startup" ? <TABS.startup server={server} /> : null}
              {tab === "network" ? <TABS.network server={server} /> : null}
              {tab === "users" ? <TABS.users server={server} /> : null}
              {tab === "activity" ? <TABS.activity server={server} /> : null}
              {tab === "settings" ? <TABS.settings me={me} server={server} /> : null}
            </LazySection>
          </div>
        </Tabs>
      )}
    </>
  );
}
