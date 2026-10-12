import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toneClass } from "./badge";
import type { Tone } from "./badge";

const icons = {
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
  info: Info,
  neutral: Info,
} as const;

/** Inline alert / banner. Use `role="alert"` only for errors that just appeared. */
export function Callout({
  tone = "info",
  title,
  children,
  action,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & { tone?: Tone; title?: ReactNode; action?: ReactNode }) {
  const Icon = icons[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-tone/35 bg-tone/8 px-3 py-2.5 text-sm",
        toneClass[tone],
        className,
      )}
      {...props}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-tone" aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? <div className={cn("text-muted-foreground", title && "mt-0.5")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
