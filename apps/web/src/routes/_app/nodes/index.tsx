import { createFileRoute } from "@tanstack/react-router";
import { useMe } from "@/lib/use-me";
import { NodesPage } from "@/features/nodes/nodes-page";
import type { NodesTab } from "@/features/nodes/nodes-page";

export const Route = createFileRoute("/_app/nodes/")({
  validateSearch: (search: Record<string, unknown>): { tab?: NodesTab; q?: string } => ({
    tab: search.tab === "tokens" ? "tokens" : undefined,
    q: typeof search.q === "string" && search.q ? search.q.slice(0, 100) : undefined,
  }),
  component: function Nodes() {
    const me = useMe();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <NodesPage
        me={me}
        tab={search.tab ?? "nodes"}
        q={search.q ?? ""}
        onTabChange={(t) =>
          void navigate({ search: (s) => ({ ...s, tab: t === "nodes" ? undefined : t }), replace: true })
        }
        onQueryChange={(q) => void navigate({ search: (s) => ({ ...s, q: q || undefined }), replace: true })}
      />
    );
  },
});
