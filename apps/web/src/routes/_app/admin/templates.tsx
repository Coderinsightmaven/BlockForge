import { createFileRoute } from "@tanstack/react-router";
import { useMe } from "@/lib/use-me";
import { TemplatesPage } from "@/features/templates/templates-page";

export const Route = createFileRoute("/_app/admin/templates")({
  component: function Templates() {
    const me = useMe();
    return <TemplatesPage me={me} />;
  },
});
