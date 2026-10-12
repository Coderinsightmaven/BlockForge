import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "./button";
import type { ButtonProps } from "./button";

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy",
  showLabel,
  ...props
}: { value: string; label?: string; showLabel?: boolean } & Omit<ButtonProps, "onClick" | "value">) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size={showLabel ? "sm" : "icon-sm"}
      aria-label={showLabel ? undefined : label}
      onClick={async () => {
        if (await copyToClipboard(value)) setCopied(true);
        else
          toast.error("Copy failed", {
            description: "Your browser blocked clipboard access; select the text and copy it manually.",
          });
      }}
      {...props}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {showLabel ? (copied ? "Copied" : label) : null}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </Button>
  );
}
