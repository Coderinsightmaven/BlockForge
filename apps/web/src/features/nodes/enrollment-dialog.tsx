import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { retryableLazy } from "@/lib/lazy";
import { LazyDialog } from "@/components/common/lazy-dialog";

/*
 * The provider and hook are part of the always-loaded app shell; the dialog (form, token display,
 * select/switch widgets) is a separate chunk loaded the first time someone opens it.
 */
const EnrollmentDialog = retryableLazy(() => import("./enrollment-dialog-body"));

/** Start loading the dialog early (e.g. when the opening button is hovered or focused). */
export function prefetchEnrollmentDialog(): void {
  void EnrollmentDialog.preload();
}

interface EnrollmentContextValue {
  open: () => void;
}
const EnrollmentContext = createContext<EnrollmentContextValue | null>(null);

/** Hosts the single enrollment dialog so the header quick action and pages can open it. */
export function EnrollmentDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  // Mounted on first open and kept mounted afterwards (so closing animates and state resets normally).
  const [mounted, setMounted] = useState(false);
  const open = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <EnrollmentContext.Provider value={value}>
      {children}
      {mounted ? (
        <LazyDialog title="Enroll a node" open={isOpen} onClose={() => setOpen(false)}>
          <EnrollmentDialog open={isOpen} onOpenChange={setOpen} />
        </LazyDialog>
      ) : null}
    </EnrollmentContext.Provider>
  );
}

export function useEnrollmentDialog(): EnrollmentContextValue {
  const ctx = useContext(EnrollmentContext);
  if (!ctx) throw new Error("useEnrollmentDialog must be used inside EnrollmentDialogProvider");
  return ctx;
}
