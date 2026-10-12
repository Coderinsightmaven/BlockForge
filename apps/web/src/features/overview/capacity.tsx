import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Meter } from "@/components/ui/meter";

/**
 * One row of an allocated-vs-used comparison. Allocation (a reservation) and usage (actual
 * consumption) use different colours *and* different labels, on the same 0–100 % scale.
 */
export function CapacityRow({
  kind,
  label,
  value,
  pct,
}: {
  kind: "allocated" | "used";
  label: string;
  value: string;
  pct: number | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn("size-2 rounded-[2px]", kind === "allocated" ? "bg-allocated" : "bg-used")}
          />
          <span className="font-medium">{label}</span>
          {kind === "allocated" ? <span className="text-muted-foreground">(reserved)</span> : null}
        </span>
        <span className="tabular">
          <span className="font-semibold">{value}</span>
          <span className="text-muted-foreground"> · {pct === null ? "—" : formatPercent(pct)}</span>
        </span>
      </div>
      <Meter
        value={pct}
        label={label}
        size="md"
        showValue={false}
        fill={kind === "allocated" ? "bg-allocated" : undefined}
        thresholds={kind === "allocated" ? null : undefined}
      />
    </div>
  );
}

export function CapacityLegend() {
  return (
    <p className="text-[11px] leading-snug text-muted-foreground">
      <span className="font-medium text-foreground">Allocated</span> = limits reserved by servers.{" "}
      <span className="font-medium text-foreground">In use</span> = measured consumption. They are different
      on purpose.
    </p>
  );
}
