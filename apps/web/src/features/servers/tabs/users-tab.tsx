import { useQuery } from "@tanstack/react-query";
import { Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Permission, Server, ServerSubuser } from "@blockforge/contracts";
import { serversApi } from "@/lib/api/servers-api";
import { describeError } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/mutations";
import { serverSubusersQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import {
  BASE_SUBUSER_PERMISSIONS,
  SUBUSER_PERMISSION_GROUPS,
  defaultSubuserGrant,
  grantablePermissions,
  normalizeGrant,
  serverActionable,
} from "@/lib/server-permissions";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Grouped checkbox matrix; permissions the granter does not hold are disabled. */
export function PermissionMatrix({
  value,
  onChange,
  granter,
  existing = [],
}: {
  value: ReadonlySet<Permission>;
  onChange: (next: Set<Permission>) => void;
  granter: readonly Permission[];
  existing?: readonly Permission[];
}) {
  const grantable = useMemo(() => grantablePermissions(granter), [granter]);
  const base = new Set<Permission>(BASE_SUBUSER_PERMISSIONS);
  const toggle = (p: Permission, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(p);
    else next.delete(p);
    onChange(next);
  };
  const setGroup = (perms: Permission[], on: boolean) => {
    const next = new Set(value);
    for (const p of perms) {
      if (!grantable.has(p) || base.has(p)) continue;
      if (on) next.add(p);
      else next.delete(p);
    }
    onChange(next);
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {SUBUSER_PERMISSION_GROUPS.map((g) => {
        const editable = g.permissions.filter((p) => grantable.has(p.permission) && !base.has(p.permission));
        const allOn = editable.length > 0 && editable.every((p) => value.has(p.permission));
        return (
          <fieldset key={g.id} className="rounded-md border p-2.5">
            <legend className="flex w-full items-center justify-between gap-2 px-1 text-xs font-semibold">
              <span className="flex items-center gap-1.5">
                {g.label}
                {g.uiPhase ? (
                  <Badge
                    variant="outline"
                    className="font-normal"
                    title="These permissions apply through the API today; the panel pages arrive later."
                  >
                    API only · UI in Phase {g.uiPhase}
                  </Badge>
                ) : null}
              </span>
              {editable.length > 1 ? (
                <button
                  type="button"
                  className="text-[11px] font-normal text-primary hover:underline"
                  onClick={() =>
                    setGroup(
                      editable.map((p) => p.permission),
                      !allOn,
                    )
                  }
                >
                  {allOn ? "None" : "All"}
                </button>
              ) : null}
            </legend>
            <ul className="flex flex-col gap-1.5">
              {g.permissions.map((p) => {
                const id = `perm-${p.permission}`;
                const isBase = base.has(p.permission);
                const can = grantable.has(p.permission);
                const lockedHeld = !can && existing.includes(p.permission);
                return (
                  <li
                    key={p.permission}
                    className={cn("flex items-start gap-2", !can && !isBase && "opacity-60")}
                  >
                    <Checkbox
                      id={id}
                      // Never show a permission as granted that the granter cannot grant.
                      checked={isBase || lockedHeld || (can && value.has(p.permission))}
                      disabled={isBase || !can}
                      onCheckedChange={(c) => toggle(p.permission, c === true)}
                      className="mt-0.5"
                    />
                    <label htmlFor={id} className="text-xs leading-snug">
                      <span className="font-medium">{p.label}</span>
                      <span className="block text-muted-foreground">
                        {p.description}
                        {!can && !isBase
                          ? " You don't hold this permission, so you can't grant or change it."
                          : ""}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

function SubuserDialog({
  server,
  subuser,
  open,
  onOpenChange,
}: {
  server: Server;
  subuser: ServerSubuser | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [user, setUser] = useState("");
  const [perms, setPerms] = useState<Set<Permission>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setUser("");
    setError(null);
    setPerms(new Set(subuser?.permissions ?? defaultSubuserGrant(server.myPermissions)));
  }, [open, subuser]);
  const save = useApiMutation({
    mutationFn: (permissions: Permission[]) =>
      subuser
        ? serversApi.updateSubuser(server.id, subuser.id, permissions)
        : serversApi.addSubuser(server.id, { user: user.trim(), permissions }),
    success: subuser ? "Permissions saved" : "User added",
    errorTitle: subuser ? "Could not save permissions" : "Could not add the user",
    silentError: true,
    onError: (err) => setError(describeError(err).title),
    invalidate: [qk.server(server.id).subusers],
    onSuccess: () => onOpenChange(false),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!subuser && !user.trim()) {
      setError("Enter the email or username of an existing account.");
      return;
    }
    save.mutate(normalizeGrant(perms, server.myPermissions, subuser?.permissions ?? []));
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-3xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{subuser ? `Permissions for ${subuser.username}` : "Add a user"}</DialogTitle>
            <DialogDescription>
              Users get exactly the permissions ticked here on this server. You can only grant permissions you
              hold yourself.
            </DialogDescription>
          </DialogHeader>
          {!subuser ? (
            <Field label="Email or username" hint="The person needs an existing BlockForge account.">
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                autoFocus
                maxLength={254}
                autoComplete="off"
              />
            </Field>
          ) : null}
          {error ? (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          ) : null}
          <PermissionMatrix
            value={perms}
            onChange={setPerms}
            granter={server.myPermissions}
            existing={subuser?.permissions}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {subuser ? "Save permissions" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function UsersTab({ server }: { server: Server }) {
  const q = useQuery(serverSubusersQuery(server.id));
  const canManage = serverActionable(server, "servers.subusers.manage");
  const [dialog, setDialog] = useState<{ subuser: ServerSubuser | null } | null>(null);
  const [removing, setRemoving] = useState<ServerSubuser | null>(null);
  const remove = useApiMutation({
    mutationFn: (s: ServerSubuser) => serversApi.removeSubuser(server.id, s.id),
    success: "User removed",
    errorTitle: "Could not remove the user",
    invalidate: [qk.server(server.id).subusers],
    onSuccess: () => setRemoving(null),
  });
  const items = q.data ?? [];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            People with access to this server besides its owner ({server.ownerName}). Administrators get
            access through roles.
          </CardDescription>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setDialog({ subuser: null })}>
            <UserPlus aria-hidden />
            Add user
          </Button>
        ) : null}
      </CardHeader>
      {q.isPending ? (
        <TableSkeleton columns={4} rows={3} />
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load users" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No additional users"
          description="Add someone to share console, files or power controls."
          compact
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>User</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="font-medium">{s.username}</div>
                  <div className="text-xs text-muted-foreground">{s.email}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{s.permissions.length} permissions</Badge>
                </TableCell>
                <TableCell className="text-xs">
                  <Timestamp ts={s.createdAt} />
                </TableCell>
                <TableCell>
                  {canManage ? (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Edit ${s.username}`}
                        onClick={() => setDialog({ subuser: s })}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${s.username}`}
                        onClick={() => setRemoving(s)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canManage ? (
        <SubuserDialog
          server={server}
          subuser={dialog?.subuser ?? null}
          open={dialog !== null}
          onOpenChange={(o) => !o && setDialog(null)}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove user?"
        description={`${removing?.username ?? ""} loses all access to ${server.name}, including SFTP.`}
        confirmLabel="Remove user"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  );
}
