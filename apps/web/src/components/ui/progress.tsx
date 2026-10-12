import { cn } from "@/lib/utils";

/** Determinate progress bar (uploads, jobs). */
export function Progress({ value, label, className }: { value: number; label: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}
