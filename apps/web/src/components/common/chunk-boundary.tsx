import { RotateCcw, TriangleAlert } from "lucide-react";
import { Component, Suspense } from "react";
import type { ReactNode } from "react";
import { isChunkLoadError, retryFailedChunks } from "@/lib/lazy";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface BoundaryProps {
  children: ReactNode;
  /** What to show when a lazy chunk inside failed to download; `retry` downloads it again. */
  fallback: (retry: () => void) => ReactNode;
}

/**
 * Catches lazy chunks that failed to download (`ChunkLoadError` from `retryableLazy`) and renders
 * `fallback(retry)`. Any other error propagates to the next boundary unchanged.
 */
export class ChunkBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  retry = () => {
    retryFailedChunks();
    this.setState({ error: null });
  };

  override render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!isChunkLoadError(error)) throw error;
    return this.props.fallback(this.retry);
  }
}

/** The error state for a part of a page whose code did not arrive. */
export function ChunkError({
  what,
  retry,
  compact,
  className,
}: {
  what: string;
  retry: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed text-center",
        compact ? "px-3 py-4" : "px-4 py-10",
        className,
      )}
    >
      <TriangleAlert className="size-5 text-danger" aria-hidden />
      <div className="text-sm font-medium">Could not load {what}</div>
      <p className="max-w-md text-xs text-muted-foreground">
        The download failed. Check the connection and retry; if BlockForge was updated since this page was
        opened, reload the page.
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={retry}>
          <RotateCcw aria-hidden />
          Retry
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    </div>
  );
}

/**
 * A lazily loaded part of a page (tab, card, widget): `loading` while its chunk downloads, an error
 * with Retry if the download fails.
 */
export function LazySection({
  what,
  loading,
  compact,
  children,
}: {
  what: string;
  loading: ReactNode;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <ChunkBoundary fallback={(retry) => <ChunkError what={what} retry={retry} compact={compact} />}>
      <Suspense fallback={loading}>{children}</Suspense>
    </ChunkBoundary>
  );
}
