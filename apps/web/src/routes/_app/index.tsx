import { createFileRoute } from "@tanstack/react-router";
import { parseTimeRange, serializeTimeRange } from "@/lib/time-range";
import { useMe } from "@/lib/use-me";
import { OverviewPage } from "@/features/overview/overview-page";

export const Route = createFileRoute("/_app/")({
  validateSearch: (search: Record<string, unknown>): { range?: string } => ({
    range: typeof search.range === "string" ? search.range : undefined,
  }),
  component: function Overview() {
    const me = useMe();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <OverviewPage
        me={me}
        range={parseTimeRange(search.range)}
        onRangeChange={(r) =>
          void navigate({ search: (s) => ({ ...s, range: serializeTimeRange(r) }), replace: true })
        }
      />
    );
  },
});
