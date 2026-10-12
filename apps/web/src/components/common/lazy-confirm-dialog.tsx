import { useEffect, useState } from "react";
import { preloadWhenIdle, retryableLazy } from "@/lib/lazy";
import type { ConfirmDialogProps } from "@/components/ui/alert-dialog";
import { LazyDialog } from "./lazy-dialog";

const ConfirmDialogImpl = retryableLazy(() =>
  import("@/components/ui/alert-dialog").then((m) => ({ default: m.ConfirmDialog })),
);

/**
 * `ConfirmDialog` (same props) whose code is not part of the page's first load: it is fetched when
 * the page is idle, at the latest on first open (a loading dialog with the same title shows until
 * it arrives; a failed download offers Retry).
 */
export function LazyConfirmDialog(props: ConfirmDialogProps) {
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  useEffect(() => preloadWhenIdle(ConfirmDialogImpl.preload), []);
  if (!mounted) return null;
  return (
    <LazyDialog title={props.title} open={props.open} onClose={() => props.onOpenChange(false)}>
      <ConfirmDialogImpl {...props} />
    </LazyDialog>
  );
}
