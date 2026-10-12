import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { useMe } from "@/lib/use-me";
import { ServersPage } from "@/features/servers/servers-page";
import type { ServersView } from "@/features/servers/servers-page";

interface ServersSearch {
  filter?: "all";
  q?: string;
  view?: "table";
}

export const Route = createFileRoute("/_app/servers/")({
  validateSearch: (search: Record<string, unknown>): ServersSearch => ({
    filter: search.filter === "all" ? "all" : undefined,
    q: typeof search.q === "string" && search.q ? search.q.slice(0, 80) : undefined,
    view: search.view === "table" ? "table" : undefined,
  }),
  component: function Servers() {
    const me = useMe();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const onChange = useCallback(
      (patch: { filter?: "mine" | "all"; q?: string; view?: ServersView }) =>
        void navigate({
          replace: true,
          search: (s) => ({
            ...s,
            ...(patch.filter ? { filter: patch.filter === "all" ? ("all" as const) : undefined } : {}),
            ...(patch.q !== undefined ? { q: patch.q || undefined } : {}),
            ...(patch.view ? { view: patch.view === "table" ? ("table" as const) : undefined } : {}),
          }),
        }),
      [navigate],
    );
    return (
      <ServersPage
        me={me}
        filter={search.filter ?? "mine"}
        q={search.q ?? ""}
        view={search.view ?? "cards"}
        onChange={onChange}
      />
    );
  },
});
