import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Network, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { PortList, expandPortList } from "@blockforge/contracts";
import type { Allocation, CreateAllocationsResponse, Node } from "@blockforge/contracts";
import type { z } from "zod";
import { allocationsApi } from "@/lib/api/servers-api";
import { useApiMutation } from "@/lib/mutations";
import { nodeAllocationsQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SpacerRow, VirtualTable, useVirtualRows } from "@/components/ui/virtual-table";

type Filter = "all" | "free" | "used";

/** Validates "25570-25600,25610" with the contract and expands it; at most 1000 ports. */
export function parsePortInput(input: string): { ports: number[]; error: string | null } {
  if (!input.trim()) return { ports: [], error: "Enter ports, e.g. 25565 or 25570-25600,25610." };
  const shape = PortList.safeParse(input);
  if (!shape.success) return { ports: [], error: shape.error.issues[0]?.message ?? "Invalid port list." };
  try {
    const ports = expandPortList(input);
    if (ports.length === 0) return { ports, error: "No ports in that list." };
    return { ports, error: null };
  } catch (e) {
    return { ports: [], error: e instanceof Error ? e.message : "Invalid port list." };
  }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function isIp(v: string): boolean {
  if (IPV4.test(v)) return true;
  try {
    return v.includes(":") && new URL(`http://[${v}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

/** Bindable addresses reported by the agent (IPv4/IPv6 without prefix), plus 0.0.0.0. */
export function nodeAddresses(node: Pick<Node, "facts">): string[] {
  const out = new Set<string>(["0.0.0.0"]);
  for (const i of node.facts?.interfaces ?? []) {
    for (const a of i.addresses) {
      const ip = a.split("/")[0]!;
      if (isIp(ip) && !ip.startsWith("127.") && ip !== "::1" && !ip.toLowerCase().startsWith("fe80"))
        out.add(ip);
    }
  }
  return [...out];
}

function CreateDialog({
  node,
  open,
  onOpenChange,
}: {
  node: Node;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const addresses = useMemo(() => nodeAddresses(node), [node]);
  const [ip, setIp] = useState("0.0.0.0");
  const [customIp, setCustomIp] = useState("");
  const [ports, setPorts] = useState("");
  const [alias, setAlias] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<z.infer<typeof CreateAllocationsResponse> | null>(null);
  useEffect(() => {
    if (!open) return;
    setPorts("");
    setAlias(node.publicAddress ?? "");
    setErrors({});
    setResult(null);
  }, [open, node.publicAddress]);
  const parsed = parsePortInput(ports);
  const create = useApiMutation({
    mutationFn: (body: { ip: string; ports: string; alias: string | null }) =>
      allocationsApi.create(node.id, body),
    errorTitle: "Could not create allocations",
    onSuccess: async (r) => {
      setResult(r);
      await queryClient.invalidateQueries({ queryKey: qk.nodes.allocationsAll(node.id) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const bindIp = ip === "__custom" ? customIp.trim() : ip;
    const next: Record<string, string> = {};
    if (!isIp(bindIp)) next.ip = "Enter an IPv4 or IPv6 address.";
    if (parsed.error) next.ports = parsed.error;
    if (alias.length > 253) next.alias = "At most 253 characters.";
    setErrors(next);
    if (Object.keys(next).length) return;
    create.mutate({ ip: bindIp, ports: ports.replace(/\s+/g, ""), alias: alias.trim() || null });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent>
        {result ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Allocations created</DialogTitle>
              <DialogDescription>
                {result.created} created
                {result.skipped.length ? `, ${result.skipped.length} already existed` : ""}.
              </DialogDescription>
            </DialogHeader>
            {result.skipped.length ? (
              <p className="text-xs break-words text-muted-foreground">
                Skipped: {result.skipped.join(", ")}
              </p>
            ) : null}
            {result.warnings.length ? (
              <Callout tone="warning" title="The agent reports these ports may be in use">
                <ul className="list-disc pl-4">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Create allocations on {node.name}</DialogTitle>
              <DialogDescription>
                Each port is published for TCP and UDP when a server uses it.
              </DialogDescription>
            </DialogHeader>
            <Field label="Bind IP" error={errors.ip} hint="0.0.0.0 listens on every interface.">
              <Select
                value={ip}
                onValueChange={setIp}
                options={[
                  ...addresses.map((a) => ({ value: a, label: a })),
                  { value: "__custom", label: "Other…" },
                ]}
              />
            </Field>
            {ip === "__custom" ? (
              <Field label="IP address" error={errors.ip}>
                <Input
                  value={customIp}
                  onChange={(e) => setCustomIp(e.target.value)}
                  className="font-mono"
                  spellCheck={false}
                />
              </Field>
            ) : null}
            <Field
              label="Ports"
              error={errors.ports}
              hint={
                !parsed.error && ports.trim()
                  ? `${parsed.ports.length} port(s): ${parsed.ports[0]}–${parsed.ports[parsed.ports.length - 1]}`
                  : "Ports and ranges, e.g. 25570-25600,25610 (max 1000)."
              }
            >
              <Input
                value={ports}
                onChange={(e) => setPorts(e.target.value)}
                className="font-mono"
                inputMode="numeric"
                spellCheck={false}
                placeholder="25565-25600"
              />
            </Field>
            <Field
              label="Alias"
              error={errors.alias}
              hint="Hostname shown to players instead of the IP (optional)."
            >
              <Input
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                maxLength={253}
                placeholder="play.example.com"
              />
            </Field>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending} disabled={!!parsed.error && !!ports.trim()}>
                Create {parsed.error ? "" : parsed.ports.length || ""}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  nodeId,
  allocation,
  onClose,
}: {
  nodeId: string;
  allocation: Allocation | null;
  onClose: () => void;
}) {
  const [alias, setAlias] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    setAlias(allocation?.alias ?? "");
    setNotes(allocation?.notes ?? "");
  }, [allocation]);
  const save = useApiMutation({
    mutationFn: () =>
      allocationsApi.update(allocation!.id, { alias: alias.trim() || null, notes: notes.trim() || null }),
    success: "Allocation saved",
    errorTitle: "Could not save the allocation",
    invalidate: [qk.nodes.allocationsAll(nodeId)],
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
            <DialogTitle>
              {allocation?.ip}:{allocation?.port}
            </DialogTitle>
          </DialogHeader>
          <Field label="Alias" hint="Hostname players see instead of the IP.">
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={253} />
          </Field>
          <Field label="Notes">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={256} />
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

export function NodeAllocations({ node, canManage }: { node: Node; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  // "used" is the full list filtered client-side (the API only filters for free ones).
  const q = useInfiniteQuery(nodeAllocationsQuery(node.id, filter === "free" ? "free" : "all"));
  const all = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const items = useMemo(
    () =>
      (filter === "used" ? all.filter((a) => a.serverId) : all)
        .slice()
        .sort((a, b) => a.ip.localeCompare(b.ip) || a.port - b.port),
    [all, filter],
  );
  const v = useVirtualRows(items, { estimateSize: 41, getKey: (a) => a.id });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Allocation | null>(null);
  const [deleting, setDeleting] = useState<Allocation | null>(null);
  const remove = useApiMutation({
    mutationFn: (a: Allocation) => allocationsApi.remove(a.id),
    success: "Allocation deleted",
    errorTitle: "Could not delete the allocation",
    onSuccess: async () => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: qk.nodes.allocationsAll(node.id) });
    },
  });

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Filter">
          {(["all", "free", "used"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "h-7 rounded-sm px-2.5 text-xs text-muted-foreground hover:text-foreground",
                filter === f && "bg-accent font-medium text-foreground",
              )}
            >
              {f === "all" ? "All" : f === "free" ? "Free" : "Assigned"}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {items.length}
          {q.hasNextPage ? "+" : ""} allocation(s)
        </span>
        {canManage ? (
          <Button size="sm" className="ml-auto" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden />
            Create allocations
          </Button>
        ) : null}
      </div>
      {q.isPending ? (
        <TableSkeleton columns={5} />
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load allocations" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Network}
          title={filter === "all" ? "No allocations yet" : "Nothing matches the filter"}
          description={
            filter === "all" ? "Servers need at least one free IP:port allocation on their node." : undefined
          }
          compact
        />
      ) : (
        <VirtualTable scrollRef={v.scrollRef} rowCount={items.length}>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent" aria-rowindex={1}>
              <TableHead>IP:port</TableHead>
              <TableHead>Alias</TableHead>
              <TableHead>Server</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <tbody>
            <SpacerRow height={v.padTop} colSpan={5} />
            {v.items.map((vi) => {
              const a = items[vi.index]!;
              return (
                <TableRow
                  key={vi.key}
                  ref={v.virtualizer.measureElement}
                  data-index={vi.index}
                  aria-rowindex={vi.index + 2}
                >
                  <TableCell className="font-mono text-xs">
                    {a.ip}:{a.port}
                  </TableCell>
                  <TableCell className="text-xs">
                    {a.alias ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-xs">
                    {a.serverId ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Link
                          to="/servers/$serverId"
                          params={{ serverId: a.serverId }}
                          className="hover:underline"
                        >
                          {a.serverName ?? a.serverId}
                        </Link>
                        {a.primary ? <Badge tone="info">Primary</Badge> : null}
                      </span>
                    ) : (
                      <Badge tone="success">Free</Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-56 truncate text-xs" title={a.notes ?? undefined}>
                    {a.notes ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Edit ${a.ip}:${a.port}`}
                          onClick={() => setEditing(a)}
                        >
                          <Pencil aria-hidden />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${a.ip}:${a.port}`}
                          disabled={!!a.serverId}
                          title={a.serverId ? "Assigned to a server" : undefined}
                          onClick={() => setDeleting(a)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
            <SpacerRow height={v.padBottom} colSpan={5} />
          </tbody>
        </VirtualTable>
      )}
      {q.hasNextPage ? (
        <div className="flex justify-center border-t p-2">
          <Button
            size="sm"
            variant="outline"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
      {canManage ? (
        <>
          <CreateDialog node={node} open={createOpen} onOpenChange={setCreateOpen} />
          <EditDialog nodeId={node.id} allocation={editing} onClose={() => setEditing(null)} />
        </>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete allocation?"
        description={`${deleting?.ip}:${deleting?.port} is removed from the node's pool.`}
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Card>
  );
}
