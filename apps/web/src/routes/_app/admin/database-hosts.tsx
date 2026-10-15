import { createFileRoute } from "@tanstack/react-router";
import { useMe } from "@/lib/use-me";
import { DatabaseHostsPage } from "@/features/database-hosts/database-hosts-page";

export const Route = createFileRoute("/_app/admin/database-hosts")({
  component: function DatabaseHosts() {
    const me = useMe();
    return <DatabaseHostsPage me={me} />;
  },
});
