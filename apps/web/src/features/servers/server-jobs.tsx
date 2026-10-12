import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, CircleX, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { REALTIME_EVENT_PAYLOADS } from "@blockforge/contracts";
import type { JobLogLine } from "@blockforge/contracts";
import { jobsApi } from "@/lib/api/servers-api";
import { describeError } from "@/lib/api/errors";
import { formatDuration } from "@/lib/format";
import { describeJobError } from "@/lib/job-errors";
import { jobQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { useRealtimeClient, useRealtimeTopic } from "@/lib/realtime/provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JOB_STATUS_META, StatusBadge, statusMeta } from "@/components/ui/status";
import { JobLog } from "./job-log";
import type { PowerAction } from "./server-common";

/*
 * Job widgets of the server page (install/reinstall/restore progress, failed power jobs, job error
 * notices). Only shown while a job runs or after one failed, so they load on demand.
 */

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
      const parsed = REALTIME_EVENT_PAYLOADS["job.updated"].safeParse(event.data);
      if (parsed.success) queryClient.setQueryData(qk.jobs.detail(jobId), parsed.data);
      else void queryClient.invalidateQueries({ queryKey: qk.jobs.detail(jobId) });
    } else if (event.type === "job.log") {
      const parsed = REALTIME_EVENT_PAYLOADS["job.log"].safeParse(event.data);
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
    const parsed = REALTIME_EVENT_PAYLOADS["job.updated"].safeParse(event.data);
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
