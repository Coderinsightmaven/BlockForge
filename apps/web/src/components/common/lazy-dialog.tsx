import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChunkBoundary } from "./chunk-boundary";

/**
 * Hosts a dialog whose code is a lazy chunk (`retryableLazy`). While the chunk downloads a dialog
 * with the same title says so; if the download fails, a dialog offers Retry (download again) or
 * Close. With the chunk preloaded (hover/focus of the opener) the real dialog opens directly.
 *
 * `open` = whether the dialog is meant to be visible (dialogs that stay mounted while closed).
 */
export function LazyDialog({
  title,
  open = true,
  onClose,
  children,
}: {
  title: string;
  open?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const shell = (body: ReactNode, footer: ReactNode) => (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>{body}</DialogDescription>
        </DialogHeader>
        {footer}
      </DialogContent>
    </Dialog>
  );
  return (
    <ChunkBoundary
      fallback={(retry) =>
        shell(
          <p role="alert">
            Could not load this dialog. Check the connection and retry; if BlockForge was updated since this
            page was opened, reload the page.
          </p>,
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button onClick={retry}>Retry</Button>
          </DialogFooter>,
        )
      }
    >
      <Suspense
        fallback={shell(
          <p aria-busy="true" data-lazy-dialog="loading" className="flex items-center gap-2">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
            Loading…
          </p>,
          null,
        )}
      >
        {children}
      </Suspense>
    </ChunkBoundary>
  );
}
