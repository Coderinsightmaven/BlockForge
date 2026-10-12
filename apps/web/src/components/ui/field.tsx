import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

/**
 * Label + control + hint + error with ids wired for assistive tech. The single child control
 * receives `id`, `aria-describedby` and `aria-invalid`.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  labelAddon,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
  labelAddon?: ReactNode;
  required?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: (children.props.id as string | undefined) ?? id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })
    : children;
  const controlId = (isValidElement(children) && (children.props.id as string | undefined)) || id;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={controlId}>
          {label}
          {required ? (
            <span className="text-danger" aria-hidden>
              {" "}
              *
            </span>
          ) : null}
        </Label>
        {labelAddon}
      </div>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
