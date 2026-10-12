import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Network, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Allocation, Server } from "@blockforge/contracts";
import { serversApi } from "@/lib/api/servers-api";
import { useApiMutation } from "@/lib/mutations";
import { serverAllocationsQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { serverActionable } from "@/lib/server-permissions";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function allocationAddress(a: Pick<Allocation, "alias" | "ip" | "port">): string {
  const host = a.alias ?? a.ip;
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${a.port}`;
}

/** Additional allocations (besides the primary) count against the server's allocation limit. */
export function canAddAllocation(allocations: readonly Allocation[], limit: number): boolean {
  return allocations.filter((a) => !a.primary).length < limit;
}

function NotesDialog({
  server,
  allocation,
  onClose,
}: {
  server: Server;
  allocation: Allocation | null;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState("");
  useEffect(() => setNotes(allocation?.notes ?? ""), [allocation]);
  const save = useApiMutation({
    mutationFn: () => serversApi.updateAllocation(server.id, allocation!.id, { notes: notes.trim() || null }),
    success: "Notes saved",
    errorTitle: "Could not save notes",
    invalidate: [qk.server(server.id).allocations],
    onSuccess: () => onClose(),
  });
  return (
    <Dialog open={allocation !== null} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Notes for {allocation ? allocationAddress(allocation) : ""}</DialogTitle>
          </DialogHeader>
          <Field label="Notes" hint="E.g. what this port is for (dynmap, voice chat, query).">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={256} autoFocus />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function NetworkTab({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  const q = useQuery(serverAllocationsQuery(server.id));
  const canManage = serverActionable(server, "servers.allocations.manage");
  const [editing, setEditing] = useState<Allocation | null>(null);
  const [removing, setRemoving] = useState<Allocation | null>(null);
  const [promoting, setPromoting] = useState<Allocation | null>(null);
  const restartToast = (restartRequired: boolean, msg: string) =>
    restartRequired
      ? toast.success(msg, { description: "Restart the server to apply the change." })
      : toast.success(msg);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.server(server.id).allocations }),
      queryClient.invalidateQueries({ queryKey: qk.servers.detail(server.id) }),
    ]);

  const add = useApiMutation({
    mutationFn: () => serversApi.addAllocation(server.id),
    errorTitle: "Could not add an allocation",
    onSuccess: async (r) => {
      restartToast(r.restartRequired, `Added ${allocationAddress(r.allocation)}`);
      await refresh();
    },
  });
  const makePrimary = useApiMutation({
    mutationFn: (a: Allocation) => serversApi.updateAllocation(server.id, a.id, { primary: true }),
    errorTitle: "Could not change the primary allocation",
    onSuccess: async (r) => {
      restartToast(r.restartRequired, `${allocationAddress(r.allocation)} is now primary`);
      setPromoting(null);
      await refresh();
    },
  });
  const remove = useApiMutation({
    mutationFn: (a: Allocation) => serversApi.removeAllocation(server.id, a.id),
    errorTitle: "Could not remove the allocation",
    onSuccess: async (r) => {
      restartToast(r.restartRequired, "Allocation removed");
      setRemoving(null);
      await refresh();
    },
  });

  const items = [...(q.data ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary) || a.port - b.port);
  const additional = items.filter((a) => !a.primary).length;
  const primary = items.find((a) => a.primary) ?? null;
  const roomLeft = canAddAllocation(items, server.allocationLimit);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Allocations</CardTitle>
          <CardDescription>
            IP:port bindings (TCP and UDP). {additional} of {server.allocationLimit} additional allocation
            {server.allocationLimit === 1 ? "" : "s"} used. Changes apply on the next restart.
          </CardDescription>
        </div>
        {canManage ? (
          <Button
            size="sm"
            onClick={() => add.mutate()}
            loading={add.isPending}
            disabled={!roomLeft}
            title={roomLeft ? undefined : "The allocation limit is reached"}
          >
            <Plus aria-hidden />
            Add allocation
          </Button>
        ) : null}
      </CardHeader>
      {q.isPending ? (
        <TableSkeleton columns={4} rows={3} />
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load allocations" />
      ) : items.length === 0 ? (
        <EmptyState icon={Network} title="No allocations" compact />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Address</TableHead>
              <TableHead>Bind IP</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <code className="font-mono text-xs">{allocationAddress(a)}</code>
                    <CopyButton
                      value={allocationAddress(a)}
                      label={`Copy ${allocationAddress(a)}`}
                      className="size-6"
                    />
                    {a.primary ? <Badge tone="info">Primary</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs">{a.ip}</TableCell>
                <TableCell className="max-w-64 text-xs break-words">
                  {a.notes ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  {canManage ? (
                    <div className="flex justify-end gap-1">
                      {!a.primary ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={makePrimary.isPending && makePrimary.variables?.id === a.id}
                          aria-label={`Make ${allocationAddress(a)} primary`}
                          onClick={() => setPromoting(a)}
                        >
                          <Star aria-hidden />
                          Make primary
                        </Button>
                      ) : null}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Edit notes for ${allocationAddress(a)}`}
                        onClick={() => setEditing(a)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      {!a.primary ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove ${allocationAddress(a)}`}
                          onClick={() => setRemoving(a)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <NotesDialog server={server} allocation={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={promoting !== null}
        onOpenChange={(o) => !o && setPromoting(null)}
        title="Change the primary allocation?"
        description={`Players will connect to ${promoting ? allocationAddress(promoting) : ""} instead of ${
          primary ? allocationAddress(primary) : "the current address"
        }. The server usually needs a restart to listen on the new port, and anyone using the old address must update it.`}
        confirmLabel="Make primary"
        pending={makePrimary.isPending}
        onConfirm={() => promoting && makePrimary.mutate(promoting)}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove allocation?"
        description={`${removing ? allocationAddress(removing) : ""} is returned to the node's pool. Anything listening on it stops being reachable after the next restart.`}
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  );
}
