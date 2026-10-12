import { createFileRoute } from "@tanstack/react-router";
import { parseTimeRange, serializeTimeRange } from "@/lib/time-range";
import { useMe } from "@/lib/use-me";
import { NodeDetailPage } from "@/features/nodes/node-detail-page";
import type { NodeTab } from "@/features/nodes/node-detail-page";

const TABS: NodeTab[] = ["overview", "metrics", "settings"];

export const Route = createFileRoute("/_app/nodes/$nodeId")({
  validateSearch: (search: Record<string, unknown>): { tab?: NodeTab; range?: string } => ({
    tab:
      TABS.includes(search.tab as NodeTab) && search.tab !== "overview" ? (search.tab as NodeTab) : undefined,
    range: typeof search.range === "string" ? search.range : undefined,
  }),
  component: function NodeDetail() {
    const me = useMe();
    const { nodeId } = Route.useParams();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <NodeDetailPage
        key={nodeId}
        me={me}
        nodeId={nodeId}
        tab={search.tab ?? "overview"}
        range={parseTimeRange(search.range)}
        onTabChange={(t) =>
          void navigate({ search: (s) => ({ ...s, tab: t === "overview" ? undefined : t }), replace: true })
        }
        onRangeChange={(r) =>
          void navigate({ search: (s) => ({ ...s, range: serializeTimeRange(r) }), replace: true })
        }
      />
    );
  },
});
