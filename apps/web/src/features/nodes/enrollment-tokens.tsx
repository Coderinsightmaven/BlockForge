import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import type { EnrollmentToken, Node } from "@blockforge/contracts";
import { nodesApi } from "@/lib/api/endpoints";
import { useApiMutation } from "@/lib/mutations";
import { enrollmentTokensQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp, useNow } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEnrollmentDialog } from "./enrollment-dialog";

export type TokenState = "used" | "expired" | "active";

export function tokenState(t: EnrollmentToken, now: number): TokenState {
  if (t.usedAt !== null) return "used";
  if (t.expiresAt <= now) return "expired";
  return "active";
}

export function EnrollmentTokens({ nodes }: { nodes: Node[] }) {
  const now = useNow();
  const enrollment = useEnrollmentDialog();
  const { data, isPending, error, refetch } = useQuery(enrollmentTokensQuery);
  const [revoking, setRevoking] = useState<EnrollmentToken | null>(null);
  const revoke = useApiMutation({
    mutationFn: (id: string) => nodesApi.revokeEnrollmentToken(id),
    success: "Enrollment token revoked",
    errorTitle: "Could not revoke token",
    invalidate: [qk.nodes.tokens],
    onSuccess: () => setRevoking(null),
  });
  const nodeName = (id: string | null) => (id ? (nodes.find((n) => n.id === id)?.name ?? id) : null);
  const sorted = [...(data ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b p-2.5">
        <p className="text-xs text-muted-foreground">
          Tokens are single-use and expire. Secrets are shown only when created; revoke unused tokens you no
          longer need.
        </p>
        <Button size="sm" variant="outline" onClick={enrollment.open}>
          <KeyRound aria-hidden />
          New token
        </Button>
      </div>
      {isPending ? (
        <TableSkeleton columns={6} />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} title="Could not load enrollment tokens" />
      ) : sorted.length === 0 ? (
        <EmptyState icon={KeyRound} title="No enrollment tokens" description="Create one to enroll a node." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Label</TableHead>
              <TableHead>Token ID</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Approval</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Used by</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((t) => {
              const state = tokenState(t, now);
              return (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.label}</TableCell>
                  <TableCell className="font-mono text-xs">{t.tokenId}</TableCell>
                  <TableCell>
                    <Badge tone={state === "active" ? "success" : "neutral"}>
                      {state === "active" ? "Active" : state === "used" ? "Used" : "Expired"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{t.requiresApproval ? "Required" : "Automatic"}</TableCell>
                  <TableCell className="text-xs">
                    <Timestamp ts={t.createdAt} />
                    {t.createdBy ? <div className="text-muted-foreground">by {t.createdBy}</div> : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Timestamp ts={t.expiresAt} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.usedByNodeId ? (
                      <Link
                        to="/nodes/$nodeId"
                        params={{ nodeId: t.usedByNodeId }}
                        className="hover:underline"
                      >
                        {nodeName(t.usedByNodeId)}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {state === "active" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRevoking(t)}
                        aria-label={`Revoke token ${t.label}`}
                      >
                        <Trash2 aria-hidden />
                        Revoke
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke enrollment token?"
        description={`“${revoking?.label ?? ""}” can no longer be used to enroll a node. Nodes already enrolled with it are not affected.`}
        confirmLabel="Revoke token"
        destructive
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Card>
  );
}
