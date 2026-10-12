import { CircleCheck, CircleSlash, CircleX, RefreshCw } from "lucide-react";
import type { ScheduleRun } from "@blockforge/contracts";
import { formatInZone } from "@/lib/cron";
import { localTimeZone } from "@/lib/format";
import type { StatusMeta } from "@/components/ui/status";

/* Pieces shared by the schedules list, editor and run history. */

export const RUN_STATUS_META: Record<ScheduleRun["status"], StatusMeta> = {
  running: {
    label: "Running",
    tone: "info",
    icon: RefreshCw,
    description: "The run is executing its tasks.",
  },
  succeeded: { label: "Succeeded", tone: "success", icon: CircleCheck, description: "Every task completed." },
  failed: {
    label: "Failed",
    tone: "danger",
    icon: CircleX,
    description: "A task failed and the run stopped (unless it was set to continue).",
  },
  skipped: {
    label: "Skipped",
    tone: "neutral",
    icon: CircleSlash,
    description: "The run did not start, e.g. the server was offline and the schedule only runs when online.",
  },
};

/** A run time in the schedule's zone, plus the viewer's local time when that differs. */
export function RunTime({ ts, timezone }: { ts: number | null; timezone: string }) {
  if (ts === null) return <span className="text-muted-foreground">—</span>;
  const local = localTimeZone();
  return (
    <span className="flex flex-col">
      <span className="tabular">{formatInZone(ts, timezone)}</span>
      {local !== timezone ? (
        <span className="text-[11px] text-muted-foreground tabular">your time {formatInZone(ts, local)}</span>
      ) : null}
    </span>
  );
}
