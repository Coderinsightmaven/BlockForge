import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Eye, EyeOff, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, FormEvent } from "react";
import {
  CreateServerDatabaseRequest,
  SERVER_DATABASE_NAME_MAX,
  ServerDatabaseName,
  normalizeDatabaseRemote,
  serverDatabaseFullName,
} from "@blockforge/contracts";
import type { DatabaseHost, Me, Server, ServerDatabase } from "@blockforge/contracts";
import { databaseHostsApi, serverDatabasesApi } from "@/lib/api/databases-api";
import { fieldErrorsFrom, isApiError } from "@/lib/api/errors";
import {
  connectionString,
  databaseErrorDetails,
  databaseErrorMessage,
  hostPort,
  jdbcUrl,
  toastDatabaseError,
} from "@/lib/databases";
import { useApiMutation } from "@/lib/mutations";
import { hasGlobal } from "@/lib/permissions";
import { qk } from "@/lib/query-keys";
import { serverActionable, serverCan } from "@/lib/server-permissions";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";

const REMOTE_HELP =
  "% allows connections from anywhere. Restrict it with an IP address, a wildcard like 10.0.%, a CIDR range like 10.0.0.0/8 or a host name.";
const REMOTE_INVALID =
  "Use %, an IPv4 address, a wildcard like 10.0.%, a CIDR range like 10.0.0.0/8, or a host name.";
const AUTO_HOST = "auto";

/** "Connections from" hint: what the value is saved as when it is normalised (CIDR → netmask, case). */
export function remoteHint(input: string): string {
  const normalized = normalizeDatabaseRemote(input);
  if (normalized === null || normalized === input.trim()) return REMOTE_HELP;
  return `Saved as ${normalized}. ${REMOTE_HELP}`;
}

function hostFull(h: Pick<DatabaseHost, "maxDatabases" | "databaseCount">): boolean {
  return h.maxDatabases !== null && h.databaseCount >= h.maxDatabases;
}

function replaceInList(list: ServerDatabase[] | undefined, db: ServerDatabase): ServerDatabase[] | undefined {
  if (!list) return list;
  return list.some((d) => d.id === db.id) ? list.map((d) => (d.id === db.id ? db : d)) : [...list, db];
}

function without(errors: Record<string, string>, key: string): Record<string, string> {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

// ---------------------------------------------------------------------------------------------
// Create

/** An input behind a fixed, non-editable prefix; `Field` wires its id/aria props to the input. */
function PrefixedInput({ prefix, className, ...props }: ComponentProps<"input"> & { prefix: string }) {
  return (
    <div className="flex min-w-0 items-stretch">
      <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2 font-mono text-xs text-muted-foreground">
        {prefix}
      </span>
      <Input {...props} className={cn("rounded-l-none font-mono", className)} />
    </div>
  );
}

function CreateDatabaseDialog({
  server,
  me,
  open,
  onOpenChange,
  blocked,
  overLimitAsAdmin,
}: {
  server: Server;
  me: Me;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Why a (non-administrator) create would be refused, or null. */
  blocked: string | null;
  overLimitAsAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  // Picking a host is reserved to database host administrators (the API refuses `hostId` otherwise).
  const pickHost = hasGlobal(me, "database_hosts.manage");
  const hosts = useQuery({
    queryKey: qk.databaseHosts.list,
    queryFn: ({ signal }) => databaseHostsApi.list(signal),
    enabled: open && pickHost,
  });
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("%");
  const [hostId, setHostId] = useState<string>(AUTO_HOST);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const reset = () => {
    setName("");
    setRemote("%");
    setHostId(AUTO_HOST);
    setErrors({});
  };
  const create = useApiMutation({
    mutationFn: (body: CreateServerDatabaseRequest) => serverDatabasesApi.create(server.id, body),
    success: (db) => `Database ${db.database} created`,
    silentError: true,
    onError: (err) => {
      if (databaseErrorDetails(err)?.reason === "name_taken") {
        setErrors({ name: databaseErrorMessage(err) });
        return;
      }
      if (isApiError(err) && err.code === "VALIDATION_FAILED") {
        const known = Object.fromEntries(
          Object.entries(fieldErrorsFrom(err)).filter(([k]) => ["name", "remote", "hostId"].includes(k)),
        );
        if (Object.keys(known).length) {
          setErrors(known);
          return;
        }
      }
      setErrors({ form: databaseErrorMessage(err) });
    },
    onSuccess: async (db) => {
      queryClient.setQueryData<ServerDatabase[]>(qk.server(server.id).databases, (l) => replaceInList(l, db));
      reset();
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: qk.server(server.id).databases });
      if (pickHost) await queryClient.invalidateQueries({ queryKey: qk.databaseHosts.all });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    const next: Record<string, string> = {};
    const n = ServerDatabaseName.safeParse(name);
    if (!n.success) next.name = n.error.issues[0]?.message ?? "Invalid name.";
    const normalized = normalizeDatabaseRemote(remote);
    if (normalized === null) next.remote = REMOTE_INVALID;
    setErrors(next);
    if (Object.keys(next).length) return;
    const parsed = CreateServerDatabaseRequest.safeParse({
      name,
      remote: normalized,
      ...(pickHost && hostId !== AUTO_HOST ? { hostId } : {}),
    });
    if (!parsed.success) {
      setErrors({ form: parsed.error.issues[0]?.message ?? "Invalid database settings." });
      return;
    }
    create.mutate(parsed.data);
  };
  const hostOptions = [
    { value: AUTO_HOST, label: "Automatic" },
    ...(hosts.data ?? []).map((h) => ({
      value: h.id,
      label: `${h.name} — ${hostPort(h.host, h.port)} (${h.databaseCount}${h.maxDatabases === null ? "" : ` / ${h.maxDatabases}`})${hostFull(h) ? " · full" : ""}`,
      disabled: hostFull(h),
    })),
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (create.isPending) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create a database</DialogTitle>
            <DialogDescription>
              A MySQL/MariaDB database with its own user, who can only access this database. The password is
              generated for you.
            </DialogDescription>
          </DialogHeader>
          <Field
            label="Database name"
            required
            error={errors.name}
            hint={`Lowercase letters, digits and underscores (up to ${SERVER_DATABASE_NAME_MAX}). Full name: ${serverDatabaseFullName(server.shortId, name || "…")}`}
          >
            <PrefixedInput
              prefix={`s${server.shortId}_`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((x) => without(without(x, "name"), "form"));
              }}
              maxLength={SERVER_DATABASE_NAME_MAX}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <Field label="Connections from" error={errors.remote} hint={remoteHint(remote)}>
            <Input
              value={remote}
              onChange={(e) => {
                setRemote(e.target.value);
                setErrors((x) => without(without(x, "remote"), "form"));
              }}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {pickHost ? (
            <Field
              label="Database host"
              error={errors.hostId}
              hint={
                hosts.isError
                  ? "Could not load the database hosts; Automatic still works."
                  : "Automatic picks a host with room, preferring hosts linked to this server's node."
              }
            >
              <Select value={hostId} onValueChange={setHostId} options={hostOptions} />
            </Field>
          ) : null}
          {blocked ? (
            <Callout tone="warning" title="Cannot create a database">
              {blocked}
            </Callout>
          ) : overLimitAsAdmin ? (
            <Callout tone="info">
              This server is at its database limit ({server.databaseLimit}). As an administrator you can still
              create databases.
            </Callout>
          ) : null}
          {errors.form ? (
            <p role="alert" className="text-sm text-danger">
              {errors.form}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={blocked !== null}>
              Create database
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Connection details (password reveal + rotation)

/**
 * The password, fetched on demand by a direct API call and held only in this component's state —
 * never in the query or mutation cache, never in storage. `hide` (and unmounting) drops it and
 * abandons a request still in flight.
 */
function usePasswordReveal(serverId: string, databaseId: string) {
  const [password, setPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  const hide = () => {
    inFlight.current?.abort();
    inFlight.current = null;
    setLoading(false);
    setPassword(null);
  };
  const reveal = async () => {
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setLoading(true);
    try {
      const r = await serverDatabasesApi.password(serverId, databaseId, ctrl.signal);
      if (!ctrl.signal.aborted) setPassword(r.password);
    } catch (err) {
      if (!ctrl.signal.aborted) toastDatabaseError(err, "Could not show the password");
    } finally {
      if (inFlight.current === ctrl) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  };
  return { password, loading, reveal, hide };
}

function DetailRow({ label, value, copy = true }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="grid items-center gap-1 sm:grid-cols-[9rem_1fr]">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <code className="min-w-0 font-mono text-xs break-all" aria-label={label}>
          {value}
        </code>
        {copy ? <CopyButton value={value} label={`Copy ${label}`} className="size-6 shrink-0" /> : null}
      </dd>
    </div>
  );
}

function DetailsBody({ server, database }: { server: Server; database: ServerDatabase }) {
  const queryClient = useQueryClient();
  const secret = usePasswordReveal(server.id, database.id);
  const [rotating, setRotating] = useState(false);
  const canViewPassword = serverCan(server, "servers.databases.view_password");
  const canRotate = serverActionable(server, "servers.databases.update");
  const rotate = useApiMutation({
    mutationFn: () => serverDatabasesApi.rotatePassword(server.id, database.id),
    success: "Password rotated",
    silentError: true,
    onError: (err) => toastDatabaseError(err, "Could not rotate the password"),
    onSuccess: async (updated) => {
      // A revealed password no longer works: drop it.
      secret.hide();
      setRotating(false);
      queryClient.setQueryData<ServerDatabase[]>(qk.server(server.id).databases, (l) =>
        replaceInList(l, updated),
      );
      await queryClient.invalidateQueries({ queryKey: qk.server(server.id).databases });
    },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connection details</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{database.database}</span> on {database.hostName}
        </DialogDescription>
      </DialogHeader>
      <dl className="flex flex-col gap-2 text-sm">
        <DetailRow label="Endpoint" value={hostPort(database.host, database.port)} />
        <DetailRow label="Database" value={database.database} />
        <DetailRow label="Username" value={database.username} />
        <DetailRow label="Connections from" value={database.remote} copy={false} />
        <div className="grid items-center gap-1 sm:grid-cols-[9rem_1fr]">
          <dt className="text-xs text-muted-foreground">Password</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {!canViewPassword ? (
              <span className="text-xs text-muted-foreground">
                Hidden — showing passwords needs the “View passwords” permission.
              </span>
            ) : secret.password !== null ? (
              <>
                <code className="min-w-0 font-mono text-xs break-all" aria-label="Password">
                  {secret.password}
                </code>
                <CopyButton value={secret.password} label="Copy password" className="size-6 shrink-0" />
                <Button size="sm" variant="ghost" onClick={secret.hide}>
                  <EyeOff aria-hidden />
                  Hide password
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                loading={secret.loading}
                onClick={() => void secret.reveal()}
              >
                <Eye aria-hidden />
                Show password
              </Button>
            )}
          </dd>
        </div>
        <DetailRow label="JDBC URL" value={jdbcUrl(database)} />
        {secret.password !== null ? (
          <DetailRow label="Connection string" value={connectionString(database, secret.password)} />
        ) : null}
      </dl>
      {database.passwordRotatedAt !== null ? (
        <p className="text-xs text-muted-foreground">
          Password last rotated <Timestamp ts={database.passwordRotatedAt} />.
        </p>
      ) : null}
      {canRotate ? (
        <DialogFooter className="sm:justify-start">
          <Button variant="outline" onClick={() => setRotating(true)}>
            <RefreshCw aria-hidden />
            Rotate password
          </Button>
        </DialogFooter>
      ) : null}
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title="Rotate the password?"
        description={`A new password is generated for ${database.username}. Applications using the old password will lose access until they are given the new one.`}
        confirmLabel="Rotate password"
        destructive
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tab

export default function DatabasesTab({ server, me }: { server: Server; me: Me }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ServerDatabase | null>(null);
  const list = useQuery({
    queryKey: qk.server(server.id).databases,
    // No realtime events: every mutation here updates and re-reads the list.
    queryFn: ({ signal }) => serverDatabasesApi.list(server.id, signal),
  });
  const databases = list.data ?? [];
  const details = databases.find((d) => d.id === detailsId) ?? null;

  const isAdmin = serverCan(server, "servers.admin");
  const canCreate = serverActionable(server, "servers.databases.create");
  const canDelete = serverActionable(server, "servers.databases.delete");
  const limit = server.databaseLimit;
  const disabled = limit === 0;
  const atLimit = list.data !== undefined && list.data.length >= limit;

  // Administrators are not bound by the limit (the API lets them through).
  const blocked = isAdmin
    ? null
    : disabled
      ? "Databases are disabled for this server."
      : atLimit
        ? `This server has reached its limit of ${limit} database${limit === 1 ? "" : "s"}. Delete one first.`
        : null;
  const createReason = !canCreate
    ? server.suspended
      ? "This server is suspended."
      : "You don't have permission to create databases."
    : blocked;

  const remove = useApiMutation({
    mutationFn: (db: ServerDatabase) => serverDatabasesApi.remove(server.id, db.id),
    success: (_r, db) => `Database ${db.database} deleted`,
    silentError: true,
    onError: (err) => toastDatabaseError(err, "Could not delete the database"),
    onSuccess: async (_r, db) => {
      setRemoving(null);
      if (detailsId === db.id) setDetailsId(null);
      queryClient.setQueryData<ServerDatabase[]>(qk.server(server.id).databases, (l) =>
        l?.filter((d) => d.id !== db.id),
      );
      await queryClient.invalidateQueries({ queryKey: qk.server(server.id).databases });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Databases</CardTitle>
          <CardDescription>
            {disabled
              ? "Databases are disabled for this server."
              : list.data
                ? `${list.data.length} / ${limit} used${isAdmin ? " · not enforced for administrators" : ""}`
                : `Limit ${limit}`}
          </CardDescription>
        </div>
        {serverCan(server, "servers.databases.create") ? (
          <Tooltip content={createReason}>
            <span>
              <Button size="sm" onClick={() => setCreating(true)} disabled={createReason !== null}>
                <Plus aria-hidden />
                Create database
              </Button>
            </span>
          </Tooltip>
        ) : null}
      </CardHeader>
      {disabled ? (
        <Callout tone="info" className="mx-4 mb-3" title="Databases are disabled for this server">
          Its database limit is 0, so only administrators can create databases. Raise the limit under Settings
          → Administration.
          {databases.length > 0 ? " Existing databases stay available below." : ""}
        </Callout>
      ) : null}
      {list.isPending ? (
        <TableSkeleton columns={6} rows={2} />
      ) : list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => void list.refetch()}
          title="Could not load databases"
          compact
        />
      ) : databases.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No databases yet"
          description={
            disabled ? undefined : "Create a MySQL database for plugins that keep their data in one."
          }
          compact
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Database</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Connections from</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {databases.map((db) => (
                <TableRow key={db.id}>
                  <TableCell className="max-w-72">
                    <div className="truncate font-mono text-xs font-medium" title={db.database}>
                      {db.database}
                    </div>
                    <div className="truncate text-xs text-muted-foreground" title={db.hostName}>
                      on {db.hostName}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs break-all">{hostPort(db.host, db.port)}</TableCell>
                  <TableCell className="font-mono text-xs">{db.username}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {db.remote}
                    {db.remote === "%" ? (
                      <span className="ml-1 font-sans text-muted-foreground">(anywhere)</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Timestamp ts={db.createdAt} />
                    {db.passwordRotatedAt !== null ? (
                      <div className="text-muted-foreground">
                        password rotated <Timestamp ts={db.passwordRotatedAt} />
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Connection details for ${db.database}`}
                        title="Connection details"
                        onClick={() => setDetailsId(db.id)}
                      >
                        <KeyRound aria-hidden />
                      </Button>
                      {canDelete ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${db.database}`}
                          title="Delete"
                          onClick={() => setRemoving(db)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <CreateDatabaseDialog
        server={server}
        me={me}
        open={creating}
        onOpenChange={setCreating}
        blocked={blocked}
        overLimitAsAdmin={isAdmin && atLimit && !disabled}
      />
      <Dialog open={details !== null} onOpenChange={(o) => !o && setDetailsId(null)}>
        <DialogContent className="max-w-2xl">
          {details ? (
            // Remounted when the password is rotated (here or elsewhere): a revealed password is dropped.
            <DetailsBody
              key={`${details.id}:${details.passwordRotatedAt ?? 0}`}
              server={server}
              database={details}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        // A fresh dialog per database: the typed confirmation never carries over.
        key={removing?.id ?? "none"}
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Delete database?"
        description={`${removing?.database ?? ""} and everything stored in it are deleted permanently, together with its user ${removing?.username ?? ""}. This cannot be undone.`}
        confirmLabel="Delete database"
        destructive
        confirmText={removing?.database}
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  );
}
