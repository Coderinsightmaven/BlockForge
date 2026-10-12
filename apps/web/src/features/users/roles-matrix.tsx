import { useQuery } from "@tanstack/react-query";
import { Check, Minus } from "lucide-react";
import { Fragment, useMemo } from "react";
import { ALL_PERMISSIONS, PERMISSIONS } from "@blockforge/contracts";
import type { Permission } from "@blockforge/contracts";
import { rolesQuery } from "@/lib/queries";
import { ErrorState, TableSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";

const AREA_LABELS: Record<string, string> = {
  settings: "Settings",
  users: "Users",
  roles: "Roles",
  audit: "Audit",
  secrets: "Secrets",
  monitoring: "Monitoring",
  jobs: "Jobs",
  alerts: "Alerts",
  nodes: "Nodes",
  networks: "Networks",
  servers: "Servers",
  schedules: "Schedules",
};

export function groupPermissions(perms: readonly string[]): Array<{ area: string; permissions: string[] }> {
  const groups = new Map<string, string[]>();
  for (const p of perms) {
    const area = p.split(".")[0] ?? p;
    groups.set(area, [...(groups.get(area) ?? []), p]);
  }
  return [...groups].map(([area, permissions]) => ({ area, permissions }));
}

/** Permission × role matrix built from `GET /roles` (the server's definition is authoritative). */
export function RolesMatrix() {
  const { data, isPending, error, refetch } = useQuery(rolesQuery);
  const permissions = useMemo(() => {
    const fromRoles = new Set<string>(data?.flatMap((r) => r.permissions) ?? []);
    // Show every known permission (even ones no role grants), in contract order, plus unknown extras.
    return [...ALL_PERMISSIONS, ...[...fromRoles].filter((p) => !(ALL_PERMISSIONS as string[]).includes(p))];
  }, [data]);

  if (isPending)
    return (
      <Card>
        <TableSkeleton rows={10} columns={6} />
      </Card>
    );
  if (error || !data)
    return (
      <Card>
        <ErrorState error={error} onRetry={() => void refetch()} title="Could not load roles" />
      </Card>
    );

  return (
    <Card className="overflow-hidden">
      <div className="overflow-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Permissions granted by each role</caption>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b">
              <th
                scope="col"
                className="sticky left-0 z-20 min-w-56 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground"
              >
                Permission
              </th>
              <th scope="col" className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">
                Grantable at
              </th>
              {data.map((r) => (
                <th
                  key={r.id}
                  scope="col"
                  className="min-w-24 px-2 py-2 text-center align-bottom text-xs font-medium"
                >
                  <Tooltip content={r.description}>
                    <span tabIndex={0} className="inline-flex flex-col items-center gap-0.5">
                      {r.name}
                      {r.builtin ? null : <Badge variant="outline">custom</Badge>}
                    </span>
                  </Tooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groupPermissions(permissions).map((g) => (
              <Fragment key={g.area}>
                <tr className="bg-muted/50">
                  <th
                    scope="rowgroup"
                    colSpan={data.length + 2}
                    className="sticky left-0 px-3 py-1 text-left text-xs font-semibold"
                  >
                    {AREA_LABELS[g.area] ?? g.area}
                  </th>
                </tr>
                {g.permissions.map((p) => {
                  const scopes = (PERMISSIONS as Record<string, readonly string[]>)[p] ?? [];
                  return (
                    <tr key={p} className="border-b hover:bg-muted/40">
                      <th
                        scope="row"
                        className="sticky left-0 bg-card px-3 py-1.5 text-left font-mono text-xs font-normal"
                      >
                        {p}
                      </th>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{scopes.join(", ")}</td>
                      {data.map((r) => {
                        const has = r.permissions.includes(p as Permission);
                        return (
                          <td key={r.id} className="px-2 py-1.5 text-center">
                            {has ? (
                              <Check
                                className="mx-auto size-4 text-success"
                                aria-label={`${r.name}: granted`}
                              />
                            ) : (
                              <Minus
                                className="mx-auto size-3.5 text-muted-foreground/50"
                                aria-label={`${r.name}: not granted`}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
