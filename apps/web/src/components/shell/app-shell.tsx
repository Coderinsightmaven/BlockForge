import { useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Me } from "@blockforge/contracts";
import { canAny } from "@/lib/permissions";
import { useNodeListRealtime } from "@/lib/realtime/handlers";
import { RealtimeProvider } from "@/lib/realtime/provider";
import { EnrollmentDialogProvider } from "@/features/nodes/enrollment-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { CommandPalette } from "./command-palette";
import { NodeHealthIndicator } from "./node-health";
import { NotificationsPopover } from "./notifications";
import { QuickActionsMenu } from "./quick-actions";
import { RealtimeIndicator } from "./realtime-indicator";
import { BrandMark, Sidebar, SidebarNav } from "./sidebar";
import { UserMenu } from "./user-menu";

function ShellRealtime({ me }: { me: Me }) {
  // `nodes` topic requires monitoring.view; the node list itself requires nodes.view.
  useNodeListRealtime(canAny(me, "monitoring.view") && canAny(me, "nodes.view"));
  return null;
}

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const [mobileNav, setMobileNav] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the page on client-side navigation so keyboard/screen-reader users land in it.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [pathname]);

  return (
    <RealtimeProvider>
      <EnrollmentDialogProvider>
        <ShellRealtime me={me} />
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <div className="flex h-full">
          <Sidebar me={me} />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Open navigation"
                onClick={() => setMobileNav(true)}
              >
                <Menu aria-hidden />
              </Button>
              <div className="min-w-0 flex-1">
                <CommandPalette me={me} />
              </div>
              <div className="flex items-center gap-1">
                <NodeHealthIndicator me={me} />
                <RealtimeIndicator />
                <QuickActionsMenu me={me} />
                <NotificationsPopover me={me} />
                <UserMenu me={me} />
              </div>
            </header>
            <main
              id="main"
              ref={mainRef}
              tabIndex={-1}
              className="flex-1 overflow-y-auto px-3 py-4 outline-none sm:px-5 lg:px-6"
            >
              <div className="mx-auto w-full max-w-[1600px]">{children}</div>
            </main>
          </div>
        </div>
        <Sheet open={mobileNav} onOpenChange={setMobileNav}>
          <SheetContent side="left">
            <SheetTitle className="flex h-12 items-center border-b px-3">
              <BrandMark />
            </SheetTitle>
            <SheetDescription className="sr-only">Main navigation</SheetDescription>
            <div className="flex-1 overflow-y-auto p-2">
              <SidebarNav me={me} onNavigate={() => setMobileNav(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </EnrollmentDialogProvider>
    </RealtimeProvider>
  );
}
