import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { useId, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "./button";
import { Input } from "./input";
import { Label } from "./label";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export function AlertDialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <AlertDialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-1.5rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl",
          className,
        )}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title className={cn("text-base font-semibold", className)} {...props} />;
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />
  );
}

export const AlertDialogCancel = AlertDialogPrimitive.Cancel;
export const AlertDialogAction = AlertDialogPrimitive.Action;

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Destructive styling for irreversible / disruptive actions. */
  destructive?: boolean;
  /**
   * For very destructive actions: the user must type this exact text (usually the resource
   * name) before the confirm button enables.
   */
  confirmText?: string;
  pending?: boolean;
  onConfirm: () => void;
}

/**
 * Confirmation for destructive or disruptive actions. The dialog stays open while `pending` so
 * the user sees the outcome; callers close it on success.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  confirmText,
  pending,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const ready = !confirmText || typed === confirmText;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        if (!o) setTyped("");
        onOpenChange(o);
      }}
    >
      <AlertDialogContent>
        <div className="flex flex-col gap-1.5">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </div>
        {confirmText ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>
              Type <span className="font-mono font-semibold break-all">{confirmText}</span> to confirm
            </Label>
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel className={buttonVariants({ variant: "outline" })} disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!ready}
            loading={pending}
            onClick={() => onConfirm()}
          >
            {confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
