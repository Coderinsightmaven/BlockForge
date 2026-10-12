import { createFileRoute } from "@tanstack/react-router";
import type { ServerTab } from "@/lib/server-permissions";
import { SERVER_TABS } from "@/lib/server-permissions";
import { parseTimeRange, serializeTimeRange } from "@/lib/time-range";
import { useMe } from "@/lib/use-me";
import { ServerPage } from "@/features/servers/server-page";
import type { ServerPageSearch } from "@/features/servers/server-page";

const TABS = new Set<string>(SERVER_TABS.map((t) => t.id));
const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

export const Route = createFileRoute("/_app/servers/$serverId")({
  validateSearch: (search: Record<string, unknown>): ServerPageSearch => ({
    tab: typeof search.tab === "string" && TABS.has(search.tab) ? (search.tab as ServerTab) : undefined,
    path: str(search.path, 1024),
    edit: str(search.edit, 1024),
    range: str(search.range, 64),
  }),
  component: function ServerDetail() {
    const me = useMe();
    const { serverId } = Route.useParams();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <ServerPage
        key={serverId}
        me={me}
        serverId={serverId}
        search={search}
        range={parseTimeRange(search.range)}
        onSearch={(patch) => void navigate({ search: (s) => ({ ...s, ...patch }) })}
        onRangeChange={(r) =>
          void navigate({ search: (s) => ({ ...s, range: serializeTimeRange(r) }), replace: true })
        }
      />
    );
  },
});
