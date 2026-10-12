import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Static placeholder (no shimmer: monitoring screens avoid distracting motion). */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden className={cn("rounded-md bg-muted", className)} {...props} />;
}
