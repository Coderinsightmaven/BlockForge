import { useNow } from "@/components/common/timestamp";
import { useRealtimeStatus } from "@/lib/realtime/provider";
import type { RealtimeStatus } from "@/lib/realtime/client";
import { cn } from "@/lib/utils";
import { toneClass } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";

export function describeRealtime(
  status: RealtimeStatus,
  now: number,
): { label: string; tone: Tone; detail: string } {
  switch (status.state) {
    case "open":
      return { label: "Live", tone: "success", detail: "Live updates are streaming from the control plane." };
    case "connecting":
      return { label: "Connecting", tone: "info", detail: "Opening the live-update connection…" };
    case "reconnecting": {
      const secs = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : null;
      return {
        label: secs ? `Retry in ${secs}s` : "Reconnecting",
        tone: "warning",
        detail: `Live updates are interrupted (attempt ${status.attempt}). Data still refreshes periodically and is re-read in full once the connection returns.`,
      };
    }
    default:
      return {
        label: "Offline",
        tone: "neutral",
        detail: "Live updates are off. Data refreshes periodically.",
      };
  }
}

export function RealtimeIndicator({ className }: { className?: string }) {
  const status = useRealtimeStatus();
  const now = useNow();
  const d = describeRealtime(status, now);
  return (
    <Tooltip content={d.detail}>
      <button
        type="button"
        className={cn(
          "hidden h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent sm:inline-flex",
          toneClass[d.tone],
          className,
        )}
        aria-label={`Live updates: ${d.label}`}
      >
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full bg-tone",
            d.tone === "neutral" && "bg-transparent ring-1 ring-tone",
          )}
        />
        <span aria-live="polite">{d.label}</span>
      </button>
    </Tooltip>
  );
}
