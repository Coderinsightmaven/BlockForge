import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader2,
  Play,
  Power,
  RotateCw,
  Skull,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SERVER_JOB_ERROR_CODES, canStartOperation } from "@blockforge/contracts";
import type { JobLogLine, Server, ServerOperation } from "@blockforge/contracts";
import { jobsApi, serversApi } from "@/lib/api/servers-api";
import { describeError } from "@/lib/api/errors";
import { formatBytes, formatBytesPerSecond, formatDuration, formatLatency } from "@/lib/format";
import { useIdempotencyKeys } from "@/lib/idempotency";
import { useApiMutation } from "@/lib/mutations";
import { jobQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { useRealtimeClient, useRealtimeTopic } from "@/lib/realtime/provider";
import { serverActionable } from "@/lib/server-permissions";
import { cpuView, diskView, memoryView, playersView } from "@/lib/server-metrics";
import { describeJobError } from "@/lib/job-errors";
import { cn } from "@/lib/utils";
import { Timestamp } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Meter } from "@/components/ui/meter";
import { JOB_STATUS_META, StatusBadge, statusMeta } from "@/components/ui/status";
import { InfoTip, Tooltip } from "@/components/ui/tooltip";
import { JobLog } from "./job-log";
import { SHELL_EVENT_PAYLOADS } from "@/lib/realtime/payloads";

// ---------------------------------------------------------------------------------------------
// Power

export type PowerAction = "start" | "stop" | "restart" | "kill";

const POWER: Array<{
  action: PowerAction;
  label: string;
  icon: typeof Play;
  variant: "default" | "outline" | "destructive";
}> = [
  { action: "start", label: "Start", icon: Play, variant: "default" },
  { action: "restart", label: "Restart", icon: RotateCw, variant: "outline" },
  { action: "stop", label: "Stop", icon: Square, variant: "outline" },
  { action: "kill", label: "Kill", icon: Skull, variant: "destructive" },
];

/** Whether a power action is offered right now (state machine + permission + suspension). */
export function powerActionState(
  server: Server,
  action: PowerAction,
): { enabled: boolean; reason: string | null } {
  if (!serverActionable(server, "servers.control")) {
    return {
      enabled: false,
      reason: server.suspended ? "This server is suspended." : "You don't have power permission.",
    };
  }
  if (!canStartOperation(action as ServerOperation, server.state, server.activeOperation)) {
    return {
      enabled: false,
      reason: server.activeOperation
        ? `Wait for the current ${server.activeOperation} to finish.`
        : `Not possible while the server is ${server.state.replace("_", " ")}.`,
    };
  }
  return { enabled: true, reason: null };
}

export function PowerControls({
  server,
  compact,
  onJob,
}: {
  server: Server;
  compact?: boolean;
  /** Called with the job a power action started (to surface a failure later). */
  onJob?: (jobId: string, action: PowerAction) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmKill, setConfirmKill] = useState(false);
  // One key per action until its outcome is known: a lost response followed by a second click
  // replays the first request instead of queueing a second job.
  const keys = useIdempotencyKeys<PowerAction>();
  const run = useApiMutation({
    mutationFn: (action: PowerAction) => serversApi.action(server.id, { action }, keys.sent(action)),
    success: (_d, action) => `${action[0]!.toUpperCase()}${action.slice(1)} requested`,
    errorTitle: "Power action failed",
    onError: (error, action) => keys.settle(action, { ok: false, error }),
    onSuccess: async (r, action) => {
      keys.settle(action, { ok: true });
      onJob?.(r.jobId, action);
      await queryClient.invalidateQueries({ queryKey: qk.servers.detail(server.id) });
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Power controls">
      {POWER.map(({ action, label, icon: Icon, variant }) => {
        const st = powerActionState(server, action);
        return (
          <Tooltip key={action} content={st.reason}>
            <span>
              <Button
                size={compact ? "sm" : "default"}
                variant={variant}
                disabled={!st.enabled || run.isPending}
                loading={run.isPending && run.variables === action}
                onClick={() => (action === "kill" ? setConfirmKill(true) : run.mutate(action))}
              >
                <Icon aria-hidden />
                {label}
              </Button>
            </span>
          </Tooltip>
        );
      })}
      <ConfirmDialog
        open={confirmKill}
        onOpenChange={setConfirmKill}
        title={`Kill ${server.name}?`}
        description="The process is terminated immediately without saving. Unsaved world data and in-flight writes can be lost or corrupted. Use Stop for a clean shutdown."
        confirmLabel="Kill process"
        destructive
        pending={run.isPending}
        onConfirm={() => run.mutate("kill", { onSuccess: () => setConfirmKill(false) })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Address

export function ServerAddress({
  server,
  className,
}: {
  server: Pick<Server, "address">;
  className?: string;
}) {
  if (!server.address)
    return <span className={cn("text-xs text-muted-foreground", className)}>No address yet</span>;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{server.address}</code>
      <CopyButton value={server.address} label={`Copy address ${server.address}`} className="size-6" />
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Live stats

function StatRow({
  label,
  info,
  value,
  meter,
}: {
  label: string;
  info?: string;
  value: string;
  meter?: number | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          {label}
          {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
        </span>
        <span className="font-medium tabular">{value}</span>
      </div>
      {meter !== undefined ? <Meter value={meter} label={label} showValue={false} /> : null}
    </div>
  );
}

export function ServerLiveStats({ server, className }: { server: Server; className?: string }) {
  const s = server.latest;
  const cpu = cpuView(s, server.cpuLimitMillicores);
  const mem = memoryView(server);
  const disk = diskView(server);
  const players = playersView(server);
  const heap = s?.jvm;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Resources</CardTitle>
        {s ? <Timestamp ts={s.ts} className="text-xs text-muted-foreground" /> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!s || !s.running ? (
          <p className="text-xs text-muted-foreground">
            {s ? "Not running — no live usage." : "No metrics reported yet."}
          </p>
        ) : null}
        <StatRow
          label="CPU"
          info="Container CPU. With a limit: share of that limit. Without one: cores in use (1 core = 100 % of one core)."
          value={cpu.text}
          meter={cpu.pctOfLimit === null ? undefined : cpu.pctOfLimit}
        />
        <StatRow
          label="Memory"
          info="Container memory in use vs. its limit (includes the JVM's off-heap memory and page cache charged to the container)."
          value={`${formatBytes(mem.used)} / ${formatBytes(mem.limit)}`}
          meter={mem.pct}
        />
        {heap ? (
          <StatRow
            label="Java heap"
            info="Heap in use vs. the maximum heap (-Xmx). Heap is part of container memory, not in addition to it."
            value={`${formatBytes(heap.heapUsedBytes)} / ${formatBytes(heap.heapMaxBytes)}`}
            meter={(heap.heapUsedBytes / Math.max(1, heap.heapMaxBytes)) * 100}
          />
        ) : null}
        <StatRow
          label="Disk"
          info="Size of the server's data directory (refreshed every few minutes)."
          value={
            disk.quota
              ? `${formatBytes(disk.used)} / ${formatBytes(disk.quota)}`
              : `${formatBytes(disk.used)} (no quota)`
          }
          meter={disk.quota ? disk.pct : undefined}
        />
        <StatRow
          label="Network"
          info="Container network rate (receive / transmit)."
          value={`↓ ${formatBytesPerSecond(s?.netRxBytesPerSec)} · ↑ ${formatBytesPerSecond(s?.netTxBytesPerSec)}`}
        />
        {players ? <StatRow label="Players" value={`${players.online} / ${players.max}`} /> : null}
        {server.game !== "other" ? (
          <StatRow label="Ping (status query)" value={formatLatency(s?.minecraft?.latencyMs)} />
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Job progress (provision / reinstall / power)

const STEP_ICON = {
  pending: CircleDashed,
  running: Loader2,
  succeeded: CircleCheck,
  failed: CircleX,
  skipped: CircleDashed,
} as const;

/** Merge log lines by id (REST backfill + live `job.log` events). */
export function mergeJobLogs(prev: readonly JobLogLine[], incoming: readonly JobLogLine[]): JobLogLine[] {
  const byId = new Map(prev.map((l) => [l.id, l]));
  for (const l of incoming) byId.set(l.id, l);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-2000);
}

export function JobProgress({ jobId, title }: { jobId: string; title: string }) {
  const client = useRealtimeClient();
  const queryClient = useQueryClient();
  const job = useQuery(jobQuery(jobId));
  const [logs, setLogs] = useState<JobLogLine[]>([]);
  const lastId = useRef<number | undefined>(undefined);
  lastId.current = logs.length ? logs[logs.length - 1]!.id : undefined;

  useEffect(() => {
    const ctrl = new AbortController();
    const backfill = () =>
      jobsApi
        .logs(jobId, lastId.current, ctrl.signal)
        .then((lines) => setLogs((p) => mergeJobLogs(p, lines)))
        .catch(() => {});
    void backfill();
    const off = client?.onReconnect(() => void backfill());
    return () => {
      ctrl.abort();
      off?.();
    };
  }, [jobId, client]);

  useRealtimeTopic(`job:${jobId}`, (event) => {
    if (event.type === "job.updated") {
      const parsed = SHELL_EVENT_PAYLOADS["job.updated"].safeParse(event.data);
      if (parsed.success) queryClient.setQueryData(qk.jobs.detail(jobId), parsed.data);
      else void queryClient.invalidateQueries({ queryKey: qk.jobs.detail(jobId) });
    } else if (event.type === "job.log") {
      const parsed = SHELL_EVENT_PAYLOADS["job.log"].safeParse(event.data);
      if (parsed.success && parsed.data.jobId === jobId) {
        const { jobId: _j, ...line } = parsed.data;
        setLogs((p) => mergeJobLogs(p, [line]));
      }
    }
  });

  const data = job.data;
  const steps = data?.steps ?? [];
  const done = steps.filter((s) => s.status === "succeeded" || s.status === "skipped").length;
  const elapsed = useMemo(
    () => (data?.startedAt ? (data.finishedAt ?? Date.now()) - data.startedAt : null),
    [data?.startedAt, data?.finishedAt],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>{title}</CardTitle>
          {data ? <StatusBadge meta={statusMeta(JOB_STATUS_META, data.status)} /> : null}
        </div>
        <span className="text-xs text-muted-foreground tabular">
          {steps.length ? `${done}/${steps.length} steps` : ""}
          {elapsed !== null ? ` · ${formatDuration(elapsed)}` : ""}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {job.isError ? <p className="text-sm text-danger">{describeError(job.error).title}</p> : null}
        {data?.error ? <JobErrorNotice error={data.error} /> : null}
        {steps.length ? (
          <ol className="grid gap-1 sm:grid-cols-2">
            {steps.map((s) => {
              const Icon = STEP_ICON[s.status];
              return (
                <li key={s.key} className="flex items-start gap-2 text-sm">
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      s.status === "running" && "text-info motion-safe:animate-spin",
                      s.status === "succeeded" && "text-success",
                      s.status === "failed" && "text-danger",
                      (s.status === "pending" || s.status === "skipped") && "text-muted-foreground",
                    )}
                    aria-label={s.status}
                  />
                  <span className="min-w-0">
                    <span className={cn(s.status === "skipped" && "text-muted-foreground line-through")}>
                      {s.label}
                    </span>
                    {s.message ? (
                      <span className="block text-xs break-words text-muted-foreground">{s.message}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : job.isPending ? (
          <p className="text-xs text-muted-foreground">Loading job…</p>
        ) : null}
        <JobLog logs={logs} />
      </CardContent>
    </Card>
  );
}

/** A failed job's error: the classified description (SERVER_JOB_ERROR_CODES), the raw message, a hint. */
export function JobErrorNotice({
  error,
  title,
  onDismiss,
}: {
  error: { code: string; message: string };
  title?: string;
  onDismiss?: () => void;
}) {
  const view = describeJobError(error.code);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm"
    >
      <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {title ? `${title}: ` : ""}
          {view.description ?? error.code}
        </p>
        <p className="break-words text-muted-foreground">
          {view.description ? <span className="mr-1 font-mono text-xs">{error.code}</span> : null}
          {error.message}
        </p>
        {view.hint ? <p className="mt-1 text-xs">{view.hint}</p> : null}
      </div>
      {onDismiss ? (
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

const TERMINAL_JOB = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Follows a power job started from PowerControls and surfaces its failure (classified start-up
 * errors such as EULA_NOT_ACCEPTED or OOM_KILLED). Success needs no notice: the state badge shows it.
 */
export function PowerJobNotice({
  jobId,
  action,
  onFailed,
  onDismiss,
}: {
  jobId: string;
  action: PowerAction;
  onFailed?: (code: string) => void;
  onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const job = useQuery({
    ...jobQuery(jobId),
    // Realtime updates normally settle it; the poll covers a missed event.
    refetchInterval: (q) => (q.state.data && TERMINAL_JOB.has(q.state.data.status) ? false : 3_000),
  });
  useRealtimeTopic(`job:${jobId}`, (event) => {
    if (event.type !== "job.updated") return;
    const parsed = SHELL_EVENT_PAYLOADS["job.updated"].safeParse(event.data);
    if (parsed.success) queryClient.setQueryData(qk.jobs.detail(jobId), parsed.data);
  });
  const data = job.data;
  const failedCode = data?.status === "failed" ? (data.error?.code ?? "UNKNOWN") : null;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  useEffect(() => {
    if (failedCode) onFailedRef.current?.(failedCode);
  }, [failedCode]);
  if (!data || data.status !== "failed") return null;
  const label = `${action[0]!.toUpperCase()}${action.slice(1)}`;
  return (
    <JobErrorNotice
      title={`${label} failed`}
      error={data.error ?? { code: "UNKNOWN", message: "The job failed without an error message." }}
      onDismiss={onDismiss}
    />
  );
}

export function SuspendedBanner({ server }: { server: Server }) {
  if (!server.suspended) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm"
    >
      <Power className="size-4 text-danger" aria-hidden />
      This server is suspended. It cannot be started and only administrators can change it.
    </div>
  );
}

/**
 * Why the server last stopped, next to its state badge: crash time + exit code, and an explicit
 * out-of-memory marker (`lastOomKilled`) — also while it sits stopped after an OOM kill.
 */
export function StateHint({ server }: { server: Server }) {
  const oomTitle = SERVER_JOB_ERROR_CODES.OOM_KILLED;
  if (server.state === "crashed" && server.lastCrashAt) {
    return (
      <Badge tone="danger" title={server.lastOomKilled ? oomTitle : "Last crash"}>
        Crashed <Timestamp ts={server.lastCrashAt} />
        {server.lastExitCode !== null ? ` · exit ${server.lastExitCode}` : ""}
        {server.lastOomKilled ? " · out of memory" : ""}
      </Badge>
    );
  }
  if (server.lastOomKilled && (server.state === "stopped" || server.state === "crashed")) {
    return (
      <Badge tone="warning" title={oomTitle}>
        Last exit: out of memory
      </Badge>
    );
  }
  return null;
}
