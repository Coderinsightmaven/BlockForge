import { useQueryClient } from "@tanstack/react-query";
import { Play, Power, RotateCw, Skull, Square } from "lucide-react";
import { Suspense, lazy, useState } from "react";
import { SERVER_JOB_ERROR_CODES, canStartOperation } from "@blockforge/contracts";
import type { Server, ServerOperation } from "@blockforge/contracts";
import { serversApi } from "@/lib/api/servers-api";
import { formatBytes, formatBytesPerSecond, formatLatency } from "@/lib/format";
import { useIdempotencyKeys } from "@/lib/idempotency";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { serverActionable } from "@/lib/server-permissions";
import { cpuView, diskView, memoryView, playersView } from "@/lib/server-metrics";
import { cn } from "@/lib/utils";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Meter } from "@/components/ui/meter";
import { InfoTip, Tooltip } from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------------------------
// Power

// The kill confirmation is only needed after a click: its dialog code loads then.
const ConfirmDialog = lazy(() =>
  import("@/components/ui/alert-dialog").then((m) => ({ default: m.ConfirmDialog })),
);

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
      {confirmKill ? (
        <Suspense fallback={null}>
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
        </Suspense>
      ) : null}
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
