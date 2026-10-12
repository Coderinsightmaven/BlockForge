import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface MeterThresholds {
  warning: number;
  critical: number;
}
export const DEFAULT_THRESHOLDS: MeterThresholds = { warning: 80, critical: 90 };

export type MeterLevel = "normal" | "warning" | "critical";

export function meterLevel(pct: number, t: MeterThresholds = DEFAULT_THRESHOLDS): MeterLevel {
  if (pct >= t.critical) return "critical";
  if (pct >= t.warning) return "warning";
  return "normal";
}

const fillClass: Record<MeterLevel, string> = {
  normal: "bg-used",
  warning: "bg-warning",
  critical: "bg-danger",
};

/**
 * Horizontal usage bar (0–100). Above the warning threshold the fill switches to a status colour
 * and an icon appears so the state is not carried by colour alone. `value = null` renders an
 * explicit "no data" state.
 */
export function Meter({
  value,
  label,
  thresholds = DEFAULT_THRESHOLDS,
  className,
  showValue = true,
  fill,
  size = "sm",
  valueText,
}: {
  value: number | null | undefined;
  label: string;
  thresholds?: MeterThresholds | null;
  className?: string;
  showValue?: boolean;
  /** Override the fill colour class (e.g. "bg-allocated"); disables threshold colouring. */
  fill?: string;
  size?: "sm" | "md";
  valueText?: ReactNode;
}) {
  const has = typeof value === "number" && Number.isFinite(value);
  const pct = has ? Math.max(0, Math.min(100, value)) : 0;
  const level = has && thresholds && !fill ? meterLevel(value, thresholds) : "normal";
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={has ? Math.round(pct * 10) / 10 : undefined}
        aria-valuetext={has ? formatPercent(value) : "No data"}
        className={cn(
          "relative min-w-12 flex-1 overflow-hidden rounded-full bg-muted",
          size === "sm" ? "h-1.5" : "h-2.5",
        )}
      >
        {has ? (
          <div className={cn("h-full rounded-full", fill ?? fillClass[level])} style={{ width: `${pct}%` }} />
        ) : null}
      </div>
      {showValue ? (
        <span
          className={cn(
            "flex w-14 shrink-0 items-center justify-end gap-0.5 text-xs tabular",
            !has && "text-muted-foreground",
          )}
        >
          {level !== "normal" ? (
            <TriangleAlert
              className={cn("size-3", level === "critical" ? "text-danger" : "text-warning")}
              aria-label={level === "critical" ? "Critical" : "Warning"}
            />
          ) : null}
          {valueText ?? (has ? formatPercent(value, 0) : "No data")}
        </span>
      ) : null}
    </div>
  );
}
