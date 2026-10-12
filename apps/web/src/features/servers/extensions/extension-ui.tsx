import { Puzzle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { safeCdnIcon, safeHttpsLink } from "./extension-model";

/** Opens a link in a new context without opener or referrer; renders nothing for unsafe URLs. */
export function SafeLink({
  href,
  children,
  className,
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
}) {
  const safe = safeHttpsLink(href);
  if (!safe) return <>{children}</>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className={className}
    >
      {children}
    </a>
  );
}

/** Modrinth CDN icons only; anything else shows the placeholder. */
export function ExtensionIcon({
  url,
  className = "size-8",
}: {
  url: string | null | undefined;
  className?: string;
}) {
  const src = safeCdnIcon(url);
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn(className, "shrink-0 rounded")}
    />
  ) : (
    <span
      className={cn(className, "inline-flex shrink-0 items-center justify-center rounded bg-muted")}
      aria-hidden
    >
      <Puzzle className="size-4 text-muted-foreground" />
    </span>
  );
}
