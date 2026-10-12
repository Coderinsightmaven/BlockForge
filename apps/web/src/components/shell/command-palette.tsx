import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Moon, Search, Server, Sun, User } from "lucide-react";
import { useEffect, useState } from "react";
import type { Me } from "@blockforge/contracts";
import { canAny, hasGlobal } from "@/lib/permissions";
import { nodesQuery, usersQuery } from "@/lib/queries";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { NODE_CONNECTION_META, StatusDot, statusMeta } from "@/components/ui/status";
import { NAV_ITEMS, navAvailability } from "./nav-items";
import { useQuickActions } from "./quick-actions";

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** Global search (Ctrl/⌘+K) over pages, actions, nodes and users the session can see. */
export function CommandPalette({ me }: { me: Me | undefined }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { resolved, setPreference } = useTheme();
  const actions = useQuickActions(me);
  const canNodes = canAny(me, "nodes.view");
  const canUsers = hasGlobal(me, "users.view");
  const nodes = useQuery({ ...nodesQuery, enabled: open && canNodes });
  const users = useInfiniteQuery({ ...usersQuery, enabled: open && canUsers });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const pages = NAV_ITEMS.filter((i) => i.to && navAvailability(i, me).kind === "available");
  const userItems = users.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-8 w-full max-w-72 justify-start gap-2 px-2.5 text-muted-foreground"
        aria-label="Search"
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      >
        <Search aria-hidden />
        <span className="hidden flex-1 text-left sm:inline">Search…</span>
        <Kbd className="hidden sm:inline-flex">{isMac ? "⌘K" : "Ctrl K"}</Kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl gap-0 overflow-hidden p-0" hideClose>
          <DialogTitle className="sr-only">Search</DialogTitle>
          <DialogDescription className="sr-only">Search pages, nodes, users and actions</DialogDescription>
          <Command loop>
            <CommandInput placeholder="Search pages, nodes, users, actions…" />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup heading="Pages">
                {pages.map((p) => (
                  <CommandItem
                    key={p.label}
                    value={`page ${p.label}`}
                    keywords={p.keywords}
                    onSelect={() => run(() => void navigate({ to: p.to! }))}
                  >
                    <p.icon aria-hidden />
                    {p.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Actions">
                {actions.map((a) => (
                  <CommandItem key={a.id} value={`action ${a.label}`} onSelect={() => run(a.run)}>
                    <a.icon aria-hidden />
                    {a.label}
                  </CommandItem>
                ))}
                <CommandItem
                  value="action toggle theme dark light"
                  onSelect={() => run(() => setPreference(resolved === "dark" ? "light" : "dark"))}
                >
                  {resolved === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
                  Switch to {resolved === "dark" ? "light" : "dark"} theme
                </CommandItem>
              </CommandGroup>
              {canNodes && nodes.data?.length ? (
                <CommandGroup heading="Nodes">
                  {nodes.data.map((n) => (
                    <CommandItem
                      key={n.id}
                      value={`node ${n.name} ${n.slug} ${n.facts?.hostname ?? ""} ${n.id}`}
                      keywords={[...n.tags, n.location ?? ""]}
                      onSelect={() =>
                        run(() => void navigate({ to: "/nodes/$nodeId", params: { nodeId: n.id } }))
                      }
                    >
                      <Server aria-hidden />
                      <span className="truncate">{n.name}</span>
                      <span className="ml-auto">
                        <StatusDot meta={statusMeta(NODE_CONNECTION_META, n.connection)} />
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {canUsers && userItems.length ? (
                <CommandGroup heading="Users">
                  {userItems.map((u) => (
                    <CommandItem
                      key={u.id}
                      value={`user ${u.displayName} ${u.email}`}
                      onSelect={() => run(() => void navigate({ to: "/users", search: { q: u.email } }))}
                    >
                      <User aria-hidden />
                      <span className="truncate">{u.displayName}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">{u.email}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
