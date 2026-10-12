import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { useMe } from "@/lib/use-me";
import { AlertsPage } from "@/features/alerts/alerts-page";
import type { AlertsTab } from "@/features/alerts/alerts-page";

const TABS: AlertsTab[] = ["incidents", "rules", "channels"];

export const Route = createFileRoute("/_app/alerts")({
  validateSearch: (search: Record<string, unknown>): { tab?: AlertsTab; create?: boolean } => ({
    tab:
      TABS.includes(search.tab as AlertsTab) && search.tab !== "incidents"
        ? (search.tab as AlertsTab)
        : undefined,
    create: search.create === true || search.create === "true" ? true : undefined,
  }),
  component: function Alerts() {
    const me = useMe();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const onCreateHandled = useCallback(
      () => void navigate({ search: (s) => ({ ...s, create: undefined }), replace: true }),
      [navigate],
    );
    return (
      <AlertsPage
        me={me}
        tab={search.tab ?? "incidents"}
        create={!!search.create}
        onTabChange={(t) =>
          void navigate({ search: (s) => ({ ...s, tab: t === "incidents" ? undefined : t }), replace: true })
        }
        onCreateHandled={onCreateHandled}
      />
    );
  },
});
