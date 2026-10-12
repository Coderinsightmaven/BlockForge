import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { useMe } from "@/lib/use-me";
import { UsersPage } from "@/features/users/users-page";
import type { UsersTab } from "@/features/users/users-page";

export const Route = createFileRoute("/_app/users")({
  validateSearch: (search: Record<string, unknown>): { tab?: UsersTab; q?: string; create?: boolean } => ({
    tab: search.tab === "roles" ? "roles" : undefined,
    q: typeof search.q === "string" && search.q ? search.q.slice(0, 100) : undefined,
    create: search.create === true || search.create === "true" ? true : undefined,
  }),
  component: function Users() {
    const me = useMe();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const onCreateHandled = useCallback(
      () => void navigate({ search: (s) => ({ ...s, create: undefined }), replace: true }),
      [navigate],
    );
    return (
      <UsersPage
        me={me}
        tab={search.tab ?? "users"}
        q={search.q ?? ""}
        create={!!search.create}
        onTabChange={(t) =>
          void navigate({ search: (s) => ({ ...s, tab: t === "users" ? undefined : t }), replace: true })
        }
        onQueryChange={(q) => void navigate({ search: (s) => ({ ...s, q: q || undefined }), replace: true })}
        onCreateHandled={onCreateHandled}
      />
    );
  },
});
