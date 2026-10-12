import { createFileRoute } from "@tanstack/react-router";
import { useMe } from "@/lib/use-me";
import { AuditPage } from "@/features/audit/audit-page";

export const Route = createFileRoute("/_app/audit")({
  component: function Audit() {
    const me = useMe();
    return <AuditPage me={me} />;
  },
});
