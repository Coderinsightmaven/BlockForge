import { ScrollArea as ScrollPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({ className, children, ...props }: ComponentProps<typeof ScrollPrimitive.Root>) {
  return (
    <ScrollPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollPrimitive.Viewport className="size-full rounded-[inherit]">{children}</ScrollPrimitive.Viewport>
      <ScrollPrimitive.Scrollbar orientation="vertical" className="flex w-2 touch-none p-0.5 select-none">
        <ScrollPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
      </ScrollPrimitive.Scrollbar>
      <ScrollPrimitive.Corner />
    </ScrollPrimitive.Root>
  );
}
