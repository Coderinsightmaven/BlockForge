import { createFileRoute } from "@tanstack/react-router";
import { useMe } from "@/lib/use-me";
import { SettingsPage } from "@/features/settings/settings-page";
import type { SettingsTab } from "@/features/settings/settings-page";

export const Route = createFileRoute("/_app/settings")({
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab: search.tab === "security" || search.tab === "appearance" ? search.tab : undefined,
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
