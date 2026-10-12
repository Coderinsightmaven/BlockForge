import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const fieldBase =
  "w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-sm text-foreground shadow-xs placeholder:text-muted-foreground/80 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger aria-invalid:outline-danger";

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} className={cn(fieldBase, "h-8 py-1", className)} {...props} />;
}
