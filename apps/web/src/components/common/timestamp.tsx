import { useSyncExternalStore } from "react";
import { MISSING, formatRelative, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

// One shared ticker so hundreds of relative timestamps re-render together, cheaply.
const TICK_MS = 5000;
let now = Date.now();
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const s of subscribers) s();
    }, TICK_MS);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time, refreshed every few seconds. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}

/**
 * Relative time ("12 seconds ago") with the absolute local time + time zone on hover and in the
 * machine-readable `dateTime` attribute.
 */
export function Timestamp({
  ts,
  className,
  mode = "relative",
}: {
  ts: number | null | undefined;
  className?: string;
  mode?: "relative" | "absolute";
}) {
  const current = useNow();
  if (ts === null || ts === undefined)
    return <span className={cn("text-muted-foreground", className)}>{MISSING}</span>;
  const absolute = formatTimestamp(ts);
  return (
    <time
      dateTime={new Date(ts).toISOString()}
      title={absolute}
      className={cn("tabular whitespace-nowrap", className)}
    >
      {mode === "relative" ? formatRelative(ts, current) : absolute}
    </time>
  );
}
