import { createFileRoute, redirect } from "@tanstack/react-router";
import { canAny } from "@/lib/permissions";
import { parseTimeRange, serializeTimeRange } from "@/lib/time-range";
import { useMe } from "@/lib/use-me";
import { OverviewPage } from "@/features/overview/overview-page";

export const Route = createFileRoute("/_app/")({
  validateSearch: (search: Record<string, unknown>): { range?: string } => ({
    range: typeof search.range === "string" ? search.range : undefined,
  }),
  // Like Pterodactyl, users without infrastructure monitoring land on their server list.
  beforeLoad: ({ context }) => {
    if (!canAny(context.me, "monitoring.view")) throw redirect({ to: "/servers" });
  },
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
