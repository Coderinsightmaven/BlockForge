import { Search } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import type { Me } from "@blockforge/contracts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

// cmdk and the searches load on first use (hover/focus of the trigger starts the download).
const loadDialog = () => import("./command-palette-dialog");
const CommandPaletteDialog = lazy(loadDialog);

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** Global search (Ctrl/⌘+K) over pages, actions, nodes and users the session can see. */
export function CommandPalette({ me }: { me: Me | undefined }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const show = (next: boolean | ((o: boolean) => boolean)) => {
    setMounted(true);
    setOpen(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setMounted(true);
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <Button
        variant="outline"
        onClick={() => show(true)}
        onPointerEnter={() => void loadDialog()}
        onFocus={() => void loadDialog()}
        className="h-8 w-full max-w-72 justify-start gap-2 px-2.5 text-muted-foreground"
        aria-label="Search"
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      >
        <Search aria-hidden />
        <span className="hidden flex-1 text-left sm:inline">Search…</span>
        <Kbd className="hidden sm:inline-flex">{isMac ? "⌘K" : "Ctrl K"}</Kbd>
      </Button>
      {mounted ? (
        <Suspense fallback={null}>
          <CommandPaletteDialog me={me} open={open} onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}
