import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * Row virtualisation for long tables (audit log, users). Only the rows in (and near) the viewport
 * are mounted; spacer rows above and below keep the scrollbar honest while the markup stays a real
 * `<table>` (headers, `aria-rowcount` / `aria-rowindex` for assistive tech).
 */
export function useVirtualRows<T>(
  rows: readonly T[],
  opts: { estimateSize: number; getKey: (row: T) => string; overscan?: number },
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => opts.estimateSize,
    overscan: opts.overscan ?? 8,
    getItemKey: (i) => opts.getKey(rows[i]!),
    // Render a first screenful before the scroll container has been measured.
    initialRect: { width: 0, height: 720 },
  });
  const items = virtualizer.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = Math.max(0, virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0));
  return { scrollRef, virtualizer, items, padTop, padBottom };
}

export function VirtualTable({
  scrollRef,
  rowCount,
  className,
  children,
  ...props
}: Omit<ComponentProps<"table">, "ref"> & {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Total data rows (the header row is added). */
  rowCount: number;
}) {
  return (
    <div ref={scrollRef} className="relative max-h-[70vh] w-full overflow-auto">
      <table
        aria-rowcount={rowCount + 1}
        className={cn("w-full caption-bottom border-collapse text-sm", className)}
        {...props}
      >
        {children}
      </table>
    </div>
  );
}

/** Invisible row reserving the height of rows that are not mounted. */
export function SpacerRow({ height, colSpan }: { height: number; colSpan: number }): ReactNode {
  if (height <= 0) return null;
  return (
    <tr aria-hidden style={{ height }}>
      <td colSpan={colSpan} className="p-0" />
    </tr>
  );
}
