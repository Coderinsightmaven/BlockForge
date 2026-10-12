import { createFileRoute } from "@tanstack/react-router";
import { useMe } from "@/lib/use-me";
import { SettingsPage } from "@/features/settings/settings-page";
import { SETTINGS_TABS } from "@/features/settings/settings-tabs";
import type { SettingsTab } from "@/features/settings/settings-tabs";

export const Route = createFileRoute("/_app/settings")({
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab:
      typeof search.tab === "string" &&
      search.tab !== "account" &&
      SETTINGS_TABS.includes(search.tab as SettingsTab)
        ? (search.tab as SettingsTab)
        : undefined,
  }),
  component: function Settings() {
    const me = useMe();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <SettingsPage
        me={me}
        tab={search.tab ?? "account"}
        onTabChange={(t) =>
          void navigate({ search: { tab: t === "account" ? undefined : t }, replace: true })
        }
      />
    );
  },
});
