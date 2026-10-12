import { Check, Clock } from "lucide-react";
import { useId, useState } from "react";
import { formatTimestamp, localTimeZone } from "@/lib/format";
import { PRESET_LABELS, PRESET_ORDER, validateCustomRange } from "@/lib/time-range";
import type { TimeRange } from "@/lib/time-range";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** `<input type="datetime-local">` value in the browser's local time. */
export function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInputValue(value: string): number {
  return value ? new Date(value).getTime() : Number.NaN;
}

function triggerLabel(range: TimeRange): string {
  if (range.kind === "relative") return PRESET_LABELS[range.preset];
  return `${formatTimestamp(range.from, { seconds: false, zone: false })} – ${formatTimestamp(range.to, { seconds: false })}`;
}

export function TimeRangePicker({
  value,
  onChange,
  className,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const initialFrom = value.kind === "absolute" ? value.from : now - 60 * 60_000;
  const initialTo = value.kind === "absolute" ? value.to : now;
  const [from, setFrom] = useState(toLocalInputValue(initialFrom));
  const [to, setTo] = useState(toLocalInputValue(initialTo));
  const [error, setError] = useState<string | null>(null);
  const fromId = useId();
  const toId = useId();

  const applyCustom = () => {
    const f = fromLocalInputValue(from);
    const t = fromLocalInputValue(to);
    const err = validateCustomRange(f, t);
    setError(err);
    if (err) return;
    onChange({ kind: "absolute", from: f, to: t });
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          const n = Date.now();
          setFrom(toLocalInputValue(value.kind === "absolute" ? value.from : n - 60 * 60_000));
          setTo(toLocalInputValue(value.kind === "absolute" ? value.to : n));
          setError(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("justify-start", className)}
          aria-label={`Time range: ${triggerLabel(value)}`}
        >
          <Clock aria-hidden />
          <span className="truncate">{triggerLabel(value)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <div role="listbox" aria-label="Preset time ranges" className="flex flex-col">
          {PRESET_ORDER.map((preset) => {
            const selected = value.kind === "relative" && value.preset === preset;
            return (
              <button
                key={preset}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange({ kind: "relative", preset });
                  setOpen(false);
                }}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <Check
                  className={cn("size-4", selected ? "opacity-100" : "opacity-0")}
                  strokeWidth={3}
                  aria-hidden
                />
                {PRESET_LABELS[preset]}
              </button>
            );
          })}
        </div>
        <div className="mt-1 border-t px-2 pt-2 pb-1.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium">Custom range</span>
            <span className="text-[11px] text-muted-foreground">{localTimeZone()}</span>
          </div>
          <div className="grid gap-2">
            <div className="grid gap-1">
              <Label htmlFor={fromId}>From</Label>
              <Input
                id={fromId}
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={toId}>To</Label>
              <Input id={toId} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            {error ? (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            ) : null}
            <Button size="sm" onClick={applyCustom}>
              Apply custom range
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
