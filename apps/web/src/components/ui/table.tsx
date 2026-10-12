import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn("border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-8 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 py-2 align-middle tabular", className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("mt-2 text-xs text-muted-foreground", className)} {...props} />;
}

// ---------------------------------------------------------------------------------------------
// Sorting

export type SortDirection = "asc" | "desc";
export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}
type SortValue = string | number | boolean | null | undefined;

/** Client-side sort with stable ordering; null/undefined always sort last. */
export function sortItems<T, K extends string>(
  items: readonly T[],
  sort: SortState<K> | null,
  accessors: Record<K, (item: T) => SortValue>,
): T[] {
  if (!sort) return [...items];
  const get = accessors[sort.key];
  const dir = sort.direction === "asc" ? 1 : -1;
  return items
    .map((item, index) => ({ item, index, v: get(item) }))
    .sort((a, b) => {
      const av = a.v;
      const bv = b.v;
      const aMissing = av === null || av === undefined;
      const bMissing = bv === null || bv === undefined;
      if (aMissing || bMissing) return aMissing === bMissing ? a.index - b.index : aMissing ? 1 : -1;
      let cmp: number;
      if (typeof av === "string" && typeof bv === "string")
        cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
      else cmp = Number(av) - Number(bv);
      return cmp === 0 ? a.index - b.index : cmp * dir;
    })
    .map((x) => x.item);
}

export function useSort<T, K extends string>(
  items: readonly T[],
  accessors: Record<K, (item: T) => SortValue>,
  initial: SortState<NoInfer<K>> | null = null,
) {
  const [sort, setSort] = useState<SortState<K> | null>(initial);
  const sorted = useMemo(() => sortItems(items, sort, accessors), [items, sort, accessors]);
  const toggle = (key: K) =>
    setSort((s) =>
      s?.key === key ? { key, direction: s.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" },
    );
  return { sorted, sort, toggle, setSort };
}

/** Column header button exposing sort state via `aria-sort`. */
export function SortableHead<K extends string>({
  column,
  sort,
  onSort,
  children,
  className,
  align = "left",
}: {
  column: K;
  sort: SortState<K> | null;
  onSort: (key: K) => void;
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const active = sort?.key === column;
  const Icon = !active ? ChevronsUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn(align === "right" && "text-right", className)}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:text-foreground",
          active && "text-foreground",
          align === "right" && "flex-row-reverse",
        )}
      >
        {children}
        <Icon className={cn("size-3.5", !active && "opacity-50")} aria-hidden />
      </button>
    </TableHead>
  );
}
