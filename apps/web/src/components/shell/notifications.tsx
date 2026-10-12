import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, BellOff } from "lucide-react";
import type { AlertIncident, Me } from "@blockforge/contracts";
import { alertsApi } from "@/lib/api/endpoints";
import { useApiMutation } from "@/lib/mutations";
import { canAny } from "@/lib/permissions";
import { incidentsQuery } from "@/lib/queries";
import { useAlertsRealtime } from "@/lib/realtime/handlers";
import { Timestamp } from "@/components/common/timestamp";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ALERT_SEVERITY_META, INCIDENT_STATUS_META, StatusDot, statusMeta } from "@/components/ui/status";
import { Skeleton } from "@/components/ui/skeleton";

function IncidentRow({ incident, canManage }: { incident: AlertIncident; canManage: boolean }) {
  const ack = useApiMutation({
    mutationFn: () => alertsApi.ack(incident.id),
    success: "Incident acknowledged",
    errorTitle: "Could not acknowledge",
    invalidate: [["alerts", "incidents"]],
  });
  return (
    <li className="flex items-start gap-2 border-b px-3 py-2 last:border-0">
      <StatusDot meta={statusMeta(ALERT_SEVERITY_META, incident.severity)} hideLabel className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-sm leading-snug break-words">{incident.summary}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="truncate">{incident.subjectName ?? incident.subjectId}</span>
          <Timestamp ts={incident.lastFiredAt} />
          {incident.status === "acknowledged" ? <StatusDot meta={INCIDENT_STATUS_META.acknowledged} /> : null}
        </div>
      </div>
      {canManage && incident.status === "firing" ? (
        <Button size="sm" variant="outline" loading={ack.isPending} onClick={() => ack.mutate()}>
          Ack
        </Button>
      ) : null}
    </li>
  );
}

export function NotificationsPopover({ me }: { me: Me | undefined }) {
  // The `alerts` topic and incident list both require alerts.view.
  const enabled = canAny(me, "alerts.view");
  const canManage = canAny(me, "alerts.manage");
  useAlertsRealtime(enabled);
  const firing = useInfiniteQuery({ ...incidentsQuery("firing"), enabled });
  const acked = useInfiniteQuery({ ...incidentsQuery("acknowledged"), enabled });
  if (!enabled) return null;

  const firingItems = firing.data?.pages[0]?.items ?? [];
  const ackedItems = acked.data?.pages[0]?.items ?? [];
  const firingMore = !!firing.data?.pages[0]?.nextCursor;
  const count = firingItems.length;
  const label = count
    ? `Notifications: ${count}${firingMore ? "+" : ""} firing alerts`
    : "Notifications: no firing alerts";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className="relative">
          <Bell aria-hidden />
          {count ? (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white tabular">
              {count > 9 || firingMore ? "9+" : count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Alerts</span>
          <Link to="/alerts" className="text-xs text-primary hover:underline">
            View all
          </Link>
        </div>
        <div className="max-h-[60vh] overflow-y-auto" aria-live="polite">
          {firing.isPending || acked.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : firing.isError ? (
            <ErrorState error={firing.error} onRetry={() => void firing.refetch()} compact />
          ) : firingItems.length + ackedItems.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-8 text-center text-sm text-muted-foreground">
              <BellOff className="size-5" aria-hidden />
              No firing or acknowledged alerts.
            </div>
          ) : (
            <>
              {firingItems.length ? (
                <section aria-label="Firing">
                  <h3 className="bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">Firing</h3>
                  <ul>
                    {firingItems.map((i) => (
                      <IncidentRow key={i.id} incident={i} canManage={canManage} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {ackedItems.length ? (
                <section aria-label="Acknowledged">
                  <h3 className="bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
                    Acknowledged
                  </h3>
                  <ul>
                    {ackedItems.slice(0, 10).map((i) => (
                      <IncidentRow key={i.id} incident={i} canManage={canManage} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
