import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export const toneClass: Record<Tone, string> = {
  success: "tone-success",
  warning: "tone-warning",
  danger: "tone-danger",
  info: "tone-info",
  neutral: "tone-neutral",
};

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-xs font-medium leading-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        // Tinted with the current --tone; text stays in the foreground ink for contrast.
        tone: "border-tone/35 bg-tone/10 text-foreground [&_svg]:text-tone",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {
  tone?: Tone;
}

export function Badge({ className, variant, tone, ...props }: BadgeProps) {
  const v = tone ? "tone" : variant;
  return (
    <span className={cn(badgeVariants({ variant: v }), tone && toneClass[tone], className)} {...props} />
  );
}
