import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, FormEvent } from "react";
import {
  CreateServerDatabaseRequest,
  SERVER_DATABASE_NAME_MAX,
  ServerDatabaseName,
  normalizeDatabaseRemote,
  serverDatabaseFullName,
} from "@blockforge/contracts";
import type { DatabaseHost, Me, Server, ServerDatabase, ServerDatabaseStatus } from "@blockforge/contracts";
import { databaseHostsApi, serverDatabasesApi } from "@/lib/api/databases-api";
import { fieldErrorsFrom, isApiError } from "@/lib/api/errors";
import {
  connectionString,
  databaseErrorDetails,
  databaseErrorMessage,
  deleteBlockedReason,
  hostPort,
  jdbcUrl,
  passwordBlockedReason,
  rotateBlockedReason,
  statusAllowsPassword,
  statusInProgress,
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
import { StatusBadge } from "@/components/ui/status";
import type { StatusMeta } from "@/components/ui/status";
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

export const CLEANUP_PENDING_HINT =
  "BlockForge removes it automatically shortly. If its database host is gone for good, an administrator can forget it instead.";

export const FORGET_DESCRIPTION =
  "BlockForge forgets this database without contacting the host. The database and its account stay on the host and must be removed there by hand if it still exists.";

/**
 * How often the list is re-read (there are no realtime events for databases): every 5 s while an
 * operation talks to the host, every 30 s while a cleanup is pending, never after a failed read
 * (403/404/5xx — the error is shown with Retry instead).
 */
export function databasesRefetchInterval(state: {
  status: "pending" | "error" | "success";
  data?: readonly Pick<ServerDatabase, "status">[] | undefined;
}): number | false {
  if (state.status === "error") return false;
  if (state.data?.some((d) => statusInProgress(d.status))) return 5_000;
  if (state.data?.some((d) => d.status === "cleanup_pending")) return 30_000;
  return false;
}

/** `ServerDatabase.status` badges. `ready` shows none in the list. */
export const DATABASE_STATUS_META: Record<ServerDatabaseStatus, StatusMeta> = {
  creating: {
    label: "Creating…",
    tone: "info",
    icon: Loader2,
    description: "The database and its user are being created on the host.",
  },
  ready: {
    label: "Ready",
    tone: "success",
    icon: CircleCheck,
    description: "Usable; the stored password is the account's password.",
  },
  rotating: {
    label: "Rotating password…",
    tone: "info",
    icon: RefreshCw,
    description: "A new password is being set on the host. The current password works until it finishes.",
  },
  deleting: {
    label: "Deleting…",
    tone: "info",
    icon: Loader2,
    description: "The database and its user are being dropped on the host.",
  },
  password_unknown: {
    label: "Password unknown — rotate again",
    tone: "warning",
    icon: TriangleAlert,
    description:
      "The last password rotation could not be confirmed, so the stored password may be wrong. Rotate the password again.",
  },
  cleanup_pending: {
    label: "Cleanup pending",
    tone: "warning",
    icon: TriangleAlert,
    description: "Cleanup pending — BlockForge removes it automatically shortly.",
  },
};

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
      // The failure may have left a database behind (e.g. `cleanup_pending`): show the current list.
      void queryClient.invalidateQueries({ queryKey: qk.server(server.id).databases });
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
function usePasswordReveal(serverId: string, databaseId: string, onFailed: () => void) {
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
      if (!ctrl.signal.aborted) {
        toastDatabaseError(err, "Could not show the password");
        onFailed();
      }
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
  // The database's status may have changed (e.g. `password_unknown`): re-read the list.
  const refetchList = () => void queryClient.invalidateQueries({ queryKey: qk.server(server.id).databases });
  const secret = usePasswordReveal(server.id, database.id, refetchList);
  const [rotating, setRotating] = useState(false);
  const canViewPassword = serverCan(server, "servers.databases.view_password");
  const canRotate = serverActionable(server, "servers.databases.update");
  const passwordBlocked = passwordBlockedReason(database.status);
  const rotateBlocked = rotateBlockedReason(database.status);
  const rotate = useApiMutation({
    mutationFn: () => serverDatabasesApi.rotatePassword(server.id, database.id),
    success: "Password rotated",
    silentError: true,
    onError: (err) => {
      toastDatabaseError(err, "Could not rotate the password");
      refetchList();
    },
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
      {database.status === "password_unknown" ? (
        <Callout tone="warning" title="Password unknown — rotate again">
          {DATABASE_STATUS_META.password_unknown.description}
        </Callout>
      ) : database.status === "cleanup_pending" ? (
        <Callout tone="warning" title="Cleanup pending">
          {CLEANUP_PENDING_HINT}
        </Callout>
      ) : database.status !== "ready" ? (
        <StatusBadge meta={DATABASE_STATUS_META[database.status]} className="self-start" />
      ) : null}
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
            ) : passwordBlocked !== null ? (
              <span className="text-xs text-muted-foreground">{passwordBlocked}</span>
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
        <DialogFooter className="items-center sm:justify-start">
          <Button variant="outline" onClick={() => setRotating(true)} disabled={rotateBlocked !== null}>
            <RefreshCw aria-hidden />
            Rotate password
          </Button>
          {rotateBlocked ? <span className="text-xs text-muted-foreground">{rotateBlocked}</span> : null}
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
  /** Delete (drop on the host), or forget (BlockForge's record only). */
  const [removing, setRemoving] = useState<{ db: ServerDatabase; forget: boolean } | null>(null);
  const list = useQuery({
    queryKey: qk.server(server.id).databases,
    // No realtime events: every mutation here updates and re-reads the list. While an operation is
    // talking to the host (or a cleanup is pending) the list is re-read until it settles.
    queryFn: ({ signal }) => serverDatabasesApi.list(server.id, signal),
    refetchInterval: (q) => databasesRefetchInterval(q.state),
  });
  const databases = list.data ?? [];
  const details = databases.find((d) => d.id === detailsId) ?? null;

  const isAdmin = serverCan(server, "servers.admin");
  const canCreate = serverActionable(server, "servers.databases.create");
  const canDelete = serverActionable(server, "servers.databases.delete");
  // Forgetting leaves the database on the host: database host administrators only (the API enforces it).
  const canForget = canDelete && hasGlobal(me, "database_hosts.manage");
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
    mutationFn: ({ db, forget }: { db: ServerDatabase; forget: boolean }) =>
      serverDatabasesApi.remove(server.id, db.id, { forget }),
    success: (_r, { db, forget }) =>
      forget ? `${db.database} forgotten (left on the host)` : `Database ${db.database} deleted`,
    silentError: true,
    onError: (err, { forget }) => {
      toastDatabaseError(err, forget ? "Could not forget the database" : "Could not delete the database");
      void queryClient.invalidateQueries({ queryKey: qk.server(server.id).databases });
    },
    onSuccess: async (_r, { db }) => {
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
                    {db.status !== "ready" ? (
                      <StatusBadge meta={DATABASE_STATUS_META[db.status]} className="mt-1" />
                    ) : null}
                    {db.status === "cleanup_pending" ? (
                      <p className="mt-0.5 text-xs whitespace-normal text-muted-foreground">
                        {CLEANUP_PENDING_HINT}
                      </p>
                    ) : null}
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
                        <Tooltip content={deleteBlockedReason(db.status)}>
                          <span>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Delete ${db.database}`}
                              title={deleteBlockedReason(db.status) ? undefined : "Delete"}
                              disabled={deleteBlockedReason(db.status) !== null}
                              onClick={() => setRemoving({ db, forget: false })}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </span>
                        </Tooltip>
                      ) : null}
                      {canForget ? (
                        <Tooltip content={deleteBlockedReason(db.status) ?? "Forget (leave on host)"}>
                          <span>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Forget ${db.database} (leave on host)`}
                              disabled={deleteBlockedReason(db.status) !== null}
                              onClick={() => setRemoving({ db, forget: true })}
                            >
                              <Unlink aria-hidden />
                            </Button>
                          </span>
                        </Tooltip>
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
            // Remounted when the password is rotated (here or elsewhere) or stops being revealable
            // (`password_unknown`, cleanup): a revealed password is dropped.
            <DetailsBody
              key={`${details.id}:${details.passwordRotatedAt ?? 0}:${statusAllowsPassword(details.status)}`}
              server={server}
              database={details}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        // A fresh dialog per database: the typed confirmation never carries over.
        key={removing ? `${removing.db.id}:${removing.forget}` : "none"}
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.forget ? "Forget database?" : "Delete database?"}
        description={
          removing?.forget
            ? FORGET_DESCRIPTION
            : `${removing?.db.database ?? ""} and everything stored in it are deleted permanently, together with its user ${removing?.db.username ?? ""}. This cannot be undone.`
        }
        confirmLabel={removing?.forget ? "Forget database" : "Delete database"}
        destructive
        confirmText={removing?.db.database}
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  );
}
