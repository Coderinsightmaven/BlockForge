import { useQuery } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import { ArrowLeft, Lock } from "lucide-react";
import { Suspense, lazy, useCallback, useRef, useState } from "react";
import type { Me, Server } from "@blockforge/contracts";
import { isApiError } from "@/lib/api/errors";
import { serverQuery } from "@/lib/queries";
import { useServerRealtime } from "@/lib/realtime/server-handlers";
import { resolveServerTab, serverCan, visibleServerTabs } from "@/lib/server-permissions";
import type { ServerTab } from "@/lib/server-permissions";
import type { TimeRange } from "@/lib/time-range";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerStateBadge } from "@/components/ui/status";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConsolePanel } from "./console/console-panel";
import { shouldBlockEditorLeave } from "./editor-guard";
import { EulaBanner } from "./eula-banner";
import type { PowerAction } from "./server-common";
import {
  JobProgress,
  PowerControls,
  PowerJobNotice,
  ServerAddress,
  ServerLiveStats,
  StateHint,
  SuspendedBanner,
} from "./server-common";

const FilesTab = lazy(() => import("./files/files-tab"));
const StatsTab = lazy(() => import("./tabs/stats-tab"));
const BackupsTab = lazy(() => import("./tabs/backups-tab"));
const SchedulesTab = lazy(() => import("./tabs/schedules-tab"));
const StartupTab = lazy(() => import("./tabs/startup-tab"));
const NetworkTab = lazy(() => import("./tabs/network-tab"));
const UsersTab = lazy(() => import("./tabs/users-tab"));
const ActivityTab = lazy(() => import("./tabs/activity-tab"));
const SettingsTab = lazy(() => import("./tabs/settings-tab"));

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
        <EulaBanner server={server} promptSeen={eulaPrompt} onAccepted={() => setEulaPrompt(false)} />
        {powerJob ? (
          <PowerJobNotice
            key={powerJob.jobId}
            jobId={powerJob.jobId}
            action={powerJob.action}
            onFailed={(code) => {
              if (code === "EULA_NOT_ACCEPTED") setEulaPrompt(true);
            }}
            onDismiss={() => setPowerJob(null)}
          />
        ) : null}
        {job ? <JobProgress key={job.jobId} jobId={job.jobId} title={job.title} /> : null}
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
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="pt-4">
            {tab === "console" ? (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <ConsolePanel
                  server={server}
                  className="h-[60vh] min-h-80 lg:h-[34rem]"
                  onEulaPrompt={() => setEulaPrompt(true)}
                />
                <ServerLiveStats server={server} />
              </div>
            ) : (
              <Suspense fallback={<TabFallback />}>
                {tab === "stats" ? (
                  <StatsTab server={server} range={range} onRangeChange={onRangeChange} />
                ) : null}
                {tab === "files" ? (
                  <FilesTab
                    server={server}
                    path={search.path ?? ""}
                    editing={search.edit ?? null}
                    onNavigate={(path) => onSearch({ path: path || undefined, edit: undefined })}
                    onEdit={(edit) => onSearch({ edit: edit ?? undefined })}
                    onEditorDirty={onEditorDirty}
                  />
                ) : null}
                {tab === "backups" ? <BackupsTab server={server} me={me} /> : null}
                {tab === "schedules" ? <SchedulesTab server={server} /> : null}
                {tab === "startup" ? <StartupTab server={server} /> : null}
                {tab === "network" ? <NetworkTab server={server} /> : null}
                {tab === "users" ? <UsersTab server={server} /> : null}
                {tab === "activity" ? <ActivityTab server={server} /> : null}
                {tab === "settings" ? <SettingsTab me={me} server={server} /> : null}
              </Suspense>
            )}
          </div>
        </Tabs>
      )}
    </>
  );
}
