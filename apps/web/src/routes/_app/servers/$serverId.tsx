import { createFileRoute } from "@tanstack/react-router";
import { parseTimeRange, serializeTimeRange } from "@/lib/time-range";
import { useMe } from "@/lib/use-me";
import { ServerPage } from "@/features/servers/server-page";
import type { ServerPageSearch } from "@/features/servers/server-page";
import { parseServerSearch } from "@/features/servers/server-search";

export const Route = createFileRoute("/_app/servers/$serverId")({
  validateSearch: (search: Record<string, unknown>): ServerPageSearch => parseServerSearch(search),
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
