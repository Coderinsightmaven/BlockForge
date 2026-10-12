import { Inbox, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { describeError, isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "py-6" : "py-12",
        className,
      )}
    >
      <Icon className="size-6 text-muted-foreground" aria-hidden />
      <div className="text-sm font-medium">{title}</div>
      {description ? <div className="max-w-md text-xs text-muted-foreground">{description}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** Error with the API's message + code and a retry action. */
export function ErrorState({
  error,
  onRetry,
  title = "Could not load data",
  className,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
  compact?: boolean;
}) {
  if (isApiError(error) && error.code === "FORBIDDEN") {
    return (
      <EmptyState
        icon={Lock}
        title="You don't have access"
        description={error.message}
        className={className}
        compact={compact}
      />
    );
  }
  const d = describeError(error);
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "py-6" : "py-12",
        className,
      )}
    >
      <TriangleAlert className="size-6 text-danger" aria-hidden />
      <div className="text-sm font-medium">{title}</div>
      <div className="max-w-md text-xs text-muted-foreground">
        {d.title}
        {d.detail ? <span className="mt-0.5 block font-mono text-[11px]">{d.detail}</span> : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-1">
          <RotateCcw aria-hidden />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="flex flex-col gap-2 p-3" aria-busy aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={cn("h-5", c === 0 ? "w-1/4" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function NoPermission({ what }: { what: string }) {
  return (
    <EmptyState
      icon={Lock}
      title="You don't have access"
      description={`Your role does not include permission to ${what}. Ask an administrator if you need it.`}
    />
  );
}
