import { useInfiniteQuery } from "@tanstack/react-query";
import { BellOff } from "lucide-react";
import { useMemo, useState } from "react";
import type { AlertIncident } from "@blockforge/contracts";
import { alertsApi } from "@/lib/api/endpoints";
import type { IncidentStatus } from "@/lib/api/endpoints";
import { formatNumber } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { incidentsQuery } from "@/lib/queries";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ALERT_SEVERITY_META, INCIDENT_STATUS_META, StatusBadge, statusMeta } from "@/components/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ruleKindMeta } from "./alert-meta";

type StatusFilter = IncidentStatus | "all";
type SeverityFilter = AlertIncident["severity"] | "all";

function IncidentActions({ incident }: { incident: AlertIncident }) {
  const ack = useApiMutation({
    mutationFn: () => alertsApi.ack(incident.id),
    success: "Incident acknowledged",
    errorTitle: "Could not acknowledge",
    invalidate: [["alerts", "incidents"], ["overview"]],
  });
  const resolve = useApiMutation({
    mutationFn: () => alertsApi.resolve(incident.id),
    success: "Incident resolved",
    errorTitle: "Could not resolve",
    invalidate: [["alerts", "incidents"], ["overview"]],
  });
  if (incident.status === "resolved") return null;
  return (
    <div className="flex justify-end gap-1.5">
      {incident.status === "firing" ? (
        <Button
          size="sm"
          variant="outline"
          loading={ack.isPending}
          disabled={resolve.isPending}
          onClick={() => ack.mutate()}
        >
          Acknowledge
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        loading={resolve.isPending}
        disabled={ack.isPending}
        onClick={() => resolve.mutate()}
      >
        Resolve
      </Button>
    </div>
  );
}

export function IncidentsTab({
  canManage,
  initialStatus,
}: {
  canManage: boolean;
  initialStatus?: StatusFilter;
}) {
  const [status, setStatus] = useState<StatusFilter>(initialStatus ?? "firing");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const q = useInfiniteQuery(incidentsQuery(status));
  const items = useMemo(() => {
    const all = q.data?.pages.flatMap((p) => p.items) ?? [];
    return severity === "all" ? all : all.filter((i) => i.severity === severity);
  }, [q.data, severity]);

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b p-2.5">
        <div className="flex flex-col gap-1">
          <Label htmlFor="incident-status">Status</Label>
          <Select
            id="incident-status"
            className="w-40"
            value={status}
            onValueChange={setStatus}
            options={[
              { value: "firing", label: "Firing" },
              { value: "acknowledged", label: "Acknowledged" },
              { value: "resolved", label: "Resolved" },
              { value: "all", label: "All" },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="incident-severity">Severity</Label>
          <Select
            id="incident-severity"
            className="w-40"
            value={severity}
            onValueChange={setSeverity}
            options={[
              { value: "all", label: "All severities" },
              { value: "critical", label: "Critical" },
              { value: "warning", label: "Warning" },
              { value: "info", label: "Info" },
            ]}
          />
        </div>
        {severity !== "all" ? (
          <p className="text-xs text-muted-foreground">Severity filters the incidents loaded so far.</p>
        ) : null}
      </div>
      {q.isPending ? (
        <TableSkeleton columns={7} />
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load incidents" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title={status === "firing" ? "Nothing is firing" : "No incidents"}
          description="Incidents appear here when an alert rule's condition is met."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>First fired</TableHead>
                <TableHead>Last fired</TableHead>
                <TableHead className="text-right">Count</TableHead>
                {canManage ? (
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <StatusBadge meta={statusMeta(ALERT_SEVERITY_META, i.severity)} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge meta={statusMeta(INCIDENT_STATUS_META, i.status)} />
                    {i.acknowledgedBy ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">by {i.acknowledgedBy}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <div className="break-words">{i.summary}</div>
                    <div className="text-xs text-muted-foreground">{ruleKindMeta(i.kind).label}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="truncate">{i.subjectName ?? i.subjectId}</div>
                    <div className="text-muted-foreground">{i.subjectType}</div>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {i.value === null ? "—" : formatNumber(i.value, 2)}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Timestamp ts={i.firstFiredAt} />
                  </TableCell>
                  <TableCell className="text-xs">
                    <Timestamp ts={i.resolvedAt ?? i.lastFiredAt} />
                    {i.resolvedAt ? <div className="text-muted-foreground">resolved</div> : null}
                  </TableCell>
                  <TableCell className="text-right">{i.occurrences}</TableCell>
                  {canManage ? (
                    <TableCell>
                      <IncidentActions incident={i} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {q.hasNextPage ? (
            <div className="flex justify-center border-t p-2">
              <Button
                variant="outline"
                size="sm"
                loading={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
