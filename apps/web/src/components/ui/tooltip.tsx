import { Tooltip as TooltipPrimitive } from "radix-ui";
import { CircleHelp } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-72 rounded-md border bg-popover px-2.5 py-1.5 text-xs leading-snug text-popover-foreground shadow-md",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** Convenience wrapper: `<Tooltip content="…"><button/></Tooltip>`. The child must be focusable. */
export function Tooltip({
  content,
  children,
  side,
  delayDuration,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}) {
  if (content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <TooltipRoot delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipRoot>
  );
}

/** Keyboard-focusable "?" explaining a technical metric. */
export function InfoTip({
  children,
  label = "More information",
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        aria-label={label}
        className={cn("inline-flex rounded-full text-muted-foreground hover:text-foreground", className)}
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}
