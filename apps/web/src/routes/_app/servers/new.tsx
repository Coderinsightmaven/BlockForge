import { createFileRoute } from "@tanstack/react-router";
import { useMe } from "@/lib/use-me";
import { NoPermission } from "@/components/common/states";
import { canCreateServers } from "@/lib/server-permissions";
import { CreateServerPage } from "@/features/servers/create/create-server-page";

export const Route = createFileRoute("/_app/servers/new")({
  component: function NewServer() {
    const me = useMe();
    if (!canCreateServers(me)) return <NoPermission what="create servers" />;
    return <CreateServerPage me={me} />;
  },
});
