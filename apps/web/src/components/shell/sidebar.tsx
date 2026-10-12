import { Link } from "@tanstack/react-router";
import type { Me } from "@blockforge/contracts";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { ADMIN_NAV_ITEMS, NAV_ITEMS, navAvailability } from "./nav-items";
import type { NavItem } from "./nav-items";

export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 px-1", className)}>
      <img src="/favicon.svg" alt="" className="size-6" />
      <span className="text-sm font-semibold tracking-tight">BlockForge</span>
    </div>
  );
}

const itemBase = "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm [&_svg]:size-4 [&_svg]:shrink-0";

function NavEntry({ item, me, onNavigate }: { item: NavItem; me: Me | undefined; onNavigate?: () => void }) {
  const Icon = item.icon;
  const availability = navAvailability(item, me);
  if (item.perServer) {
    // Per-server sections: point at the server list, where each server's page has the tab.
    return (
      <Tooltip content={item.perServer} side="right">
        <Link
          to="/servers"
          onClick={onNavigate}
          className={cn(itemBase, "text-muted-foreground hover:bg-accent hover:text-foreground")}
          activeOptions={{ exact: true }}
          activeProps={{}}
        >
          <Icon aria-hidden />
          <span className="truncate">{item.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground/80" aria-hidden>
            per server
          </span>
          <span className="sr-only"> ({item.perServer}; opens Game Servers)</span>
        </Link>
      </Tooltip>
    );
  }
  if (availability.kind !== "available" || !item.to) {
    return (
      <Tooltip content={availability.kind === "available" ? null : availability.reason} side="right">
        <span
          tabIndex={0}
          aria-disabled="true"
          className={cn(
            itemBase,
            "cursor-not-allowed text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-ring",
          )}
        >
          <Icon aria-hidden />
          <span className="truncate">{item.label}</span>
          <span className="sr-only"> ({availability.kind === "available" ? "" : availability.reason})</span>
        </span>
      </Tooltip>
    );
  }
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      activeOptions={{ exact: item.to === "/" }}
      className={cn(itemBase, "text-muted-foreground hover:bg-accent hover:text-foreground")}
      activeProps={{ className: "bg-accent font-medium text-foreground", "aria-current": "page" }}
    >
      <Icon aria-hidden />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function SidebarNav({ me, onNavigate }: { me: Me | undefined; onNavigate?: () => void }) {
  const admin = ADMIN_NAV_ITEMS.filter((i) => navAvailability(i, me).kind === "available");
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => (
        <NavEntry key={item.label} item={item} me={me} onNavigate={onNavigate} />
      ))}
      {admin.length ? (
        <>
          <div className="mt-3 mb-1 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Administration
          </div>
          {admin.map((item) => (
            <NavEntry key={item.label} item={item} me={me} onNavigate={onNavigate} />
          ))}
        </>
      ) : null}
    </nav>
  );
}

export function Sidebar({ me }: { me: Me | undefined }) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar lg:flex">
      <div className="flex h-12 items-center border-b px-3">
        <Link to="/" className="rounded-md">
          <BrandMark />
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <SidebarNav me={me} />
      </div>
    </aside>
  );
}
