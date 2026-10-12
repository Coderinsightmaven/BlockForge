import { CircleX } from "lucide-react";
import { describeJobError } from "@/lib/job-errors";
import { Button } from "@/components/ui/button";

/** A failed job's error: the classified description (SERVER_JOB_ERROR_CODES), the raw message, a hint. */
export function JobErrorNotice({
  error,
  title,
  onDismiss,
}: {
  error: { code: string; message: string };
  title?: string;
  onDismiss?: () => void;
}) {
  const view = describeJobError(error.code);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm"
    >
      <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {title ? `${title}: ` : ""}
          {view.description ?? error.code}
        </p>
        <p className="break-words text-muted-foreground">
          {view.description ? <span className="mr-1 font-mono text-xs">{error.code}</span> : null}
          {error.message}
        </p>
        {view.hint ? <p className="mt-1 text-xs">{view.hint}</p> : null}
      </div>
      {onDismiss ? (
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}
