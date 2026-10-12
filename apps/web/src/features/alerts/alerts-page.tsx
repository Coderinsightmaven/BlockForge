import type { Me } from "@blockforge/contracts";
import { canAny } from "@/lib/permissions";
import { useAlertsRealtime } from "@/lib/realtime/handlers";
import { PageHeader } from "@/components/common/page-header";
import { NoPermission } from "@/components/common/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChannelsTab } from "./channels-tab";
import { IncidentsTab } from "./incidents-tab";
import { RulesTab } from "./rules-tab";

export type AlertsTab = "incidents" | "rules" | "channels";

export function AlertsPage({
  me,
  tab,
  create,
  onTabChange,
  onCreateHandled,
}: {
  me: Me;
  tab: AlertsTab;
  create: boolean;
  onTabChange: (t: AlertsTab) => void;
  onCreateHandled: () => void;
}) {
  const allowed = canAny(me, "alerts.view");
  const canManage = canAny(me, "alerts.manage");
  useAlertsRealtime(allowed);
  if (!allowed) return <NoPermission what="view alerts" />;
  const current = tab === "channels" && !canManage ? "incidents" : tab;
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Incidents, the rules that raise them, and where notifications go."
      />
      <Tabs value={current} onValueChange={(v) => onTabChange(v as AlertsTab)}>
        <TabsList>
          <TabsTrigger value="incidents">Incidents</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          {canManage ? <TabsTrigger value="channels">Notification channels</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="incidents">
          <IncidentsTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab canManage={canManage} openCreate={create} onCreateHandled={onCreateHandled} />
        </TabsContent>
        {canManage ? (
          <TabsContent value="channels">
            <ChannelsTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}
