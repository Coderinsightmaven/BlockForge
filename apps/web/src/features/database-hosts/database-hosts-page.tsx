import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Pencil, PlugZap, Plus, Trash2, X } from "lucide-react";
import { Fragment, useState } from "react";
import type { FormEvent } from "react";
import { CreateDatabaseHostRequest, TestDatabaseHostRequest, tlsModeVerifies } from "@blockforge/contracts";
import type {
  DatabaseHost,
  DatabaseHostTestResult,
  DatabaseTlsMode,
  Me,
  UpdateDatabaseHostRequest,
} from "@blockforge/contracts";
import type { z } from "zod";
import { databaseHostsApi } from "@/lib/api/databases-api";
import { fieldErrorsFrom, isApiError } from "@/lib/api/errors";
import { databaseErrorMessage, hostPort, toastDatabaseError } from "@/lib/databases";
import { useApiMutation } from "@/lib/mutations";
import { canAny, hasGlobal } from "@/lib/permissions";
import { nodesQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, NoPermission, TableSkeleton } from "@/components/common/states";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/badge";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------------------------
// Form model (pure, tested)

export interface HostForm {
  name: string;
  host: string;
  port: string;
  publicHost: string;
  username: string;
  /** Write-only: never prefilled; empty on edit keeps the stored password. */
  password: string;
  /** "" = no linked node. */
  nodeId: string;
  /** "" = unlimited. */
  maxDatabases: string;
  tlsMode: DatabaseTlsMode;
  tlsCaCertificate: string;
  notes: string;
}

/** Wording shared by every TLS mode that encrypts without authenticating the host. */
export const TLS_NOT_VERIFIED_HELP =
  "This protects only against passive sniffing: an active attacker on the network path can impersonate the host (and receive the admin password). Use Verify CA to rule that out.";

/** Verify CA checks the chain, not the host name: a public CA would let any of its certificates pass. */
export const VERIFY_CA_PIN_WARNING =
  "Pin a private CA or the database server's own certificate — not a public CA: the host name is not checked, so any certificate that CA issued would be accepted.";

export const TLS_MODES: { value: DatabaseTlsMode; label: string; help: string }[] = [
  {
    value: "disabled",
    label: "Disabled (no encryption)",
    help: "Plain TCP: anyone on the network path can read the traffic, including credentials. Only for a trusted private network.",
  },
  {
    value: "preferred",
    label: "Preferred (encrypted if offered, host not verified)",
    help: `Encrypted when the server offers TLS, plain otherwise; its certificate is not checked. ${TLS_NOT_VERIFIED_HELP}`,
  },
  {
    value: "required",
    label: "Required (encrypted, host not verified)",
    help: `Always encrypted (or the connection fails), but the certificate is not checked. ${TLS_NOT_VERIFIED_HELP}`,
  },
  {
    value: "verify_ca",
    label: "Verify CA (encrypted, certificate verified against your CA)",
    help: `Always encrypted, and the server's certificate must chain to the CA certificate below. ${VERIFY_CA_PIN_WARNING}`,
  },
];

export const CA_REQUIRED_MESSAGE = "Paste the CA certificate the host's certificate is verified against.";

export const PASSWORD_REQUIRED_MESSAGE = "Re-enter the admin password when changing the connection settings.";

export function formFromHost(h: DatabaseHost | null): HostForm {
  return {
    name: h?.name ?? "",
    host: h?.host ?? "",
    port: String(h?.port ?? 3306),
    publicHost: h?.publicHost ?? "",
    username: h?.username ?? "",
    password: "",
    nodeId: h?.nodeId ?? "",
    maxDatabases: h?.maxDatabases === null || h?.maxDatabases === undefined ? "" : String(h.maxDatabases),
    tlsMode: h?.tlsMode ?? "preferred",
    tlsCaCertificate: h?.tlsCaCertificate ?? "",
    notes: h?.notes ?? "",
  };
}

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

/** The CA the form would send: only with Verify CA (the API refuses one with any other mode). */
export function effectiveCa(f: Pick<HostForm, "tlsMode" | "tlsCaCertificate">): string | null {
  return tlsModeVerifies(f.tlsMode) ? orNull(f.tlsCaCertificate) : null;
}

const savedCa = (h: DatabaseHost) => h.tlsCaCertificate?.trim() || null;

/**
 * Whether the connection settings differ from the saved host. The stored admin password is only
 * reused when none of them changed (the API refuses otherwise).
 */
export function connectionChanged(f: HostForm, saved: DatabaseHost): boolean {
  return (
    f.host.trim() !== saved.host ||
    Number(f.port) !== saved.port ||
    f.username !== saved.username ||
    f.tlsMode !== saved.tlsMode ||
    effectiveCa(f) !== savedCa(saved)
  );
}

type CreateBody = z.input<typeof CreateDatabaseHostRequest>;
type UpdateBody = z.input<typeof UpdateDatabaseHostRequest>;
type TestBody = z.input<typeof TestDatabaseHostRequest>;

function issuesToErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const i of issues) errors[String(i.path[0] ?? "form")] ??= i.message;
  return errors;
}

function numberOrNaN(v: string): number {
  return v.trim() === "" ? Number.NaN : Number(v);
}

/** The full set of values, validated with the create schema (shared by create and edit). */
function parseAll(f: HostForm, passwordPlaceholder: boolean) {
  return CreateDatabaseHostRequest.safeParse({
    name: f.name,
    host: f.host.trim(),
    port: numberOrNaN(f.port),
    publicHost: orNull(f.publicHost),
    username: f.username,
    // On edit an empty password is valid (keeps the stored one): validate the rest with a stand-in.
    password: passwordPlaceholder ? "-" : f.password,
    nodeId: f.nodeId || null,
    maxDatabases: f.maxDatabases.trim() === "" ? null : numberOrNaN(f.maxDatabases),
    tlsMode: f.tlsMode,
    tlsCaCertificate: effectiveCa(f),
    notes: f.notes,
  });
}

/** The CA rule as a field message (the schemas only check it once every other field passes). */
function caErrors(f: HostForm, errors: Record<string, string>): void {
  if (tlsModeVerifies(f.tlsMode) && effectiveCa(f) === null) errors.tlsCaCertificate = CA_REQUIRED_MESSAGE;
  else if (!tlsModeVerifies(f.tlsMode)) delete errors.tlsCaCertificate;
}

/**
 * Create: every field, password required. Edit: only the changed fields; the password only when
 * typed, and required when a connection setting changed.
 */
export function hostRequest(
  f: HostForm,
  saved: DatabaseHost | null,
):
  | { kind: "create"; body: CreateBody; errors: Record<string, string> }
  | { kind: "update"; body: UpdateBody; errors: Record<string, string> } {
  const typedPassword = f.password !== "";
  const parsed = parseAll(f, saved !== null && !typedPassword);
  const errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);
  if (errors.port) errors.port = "A port from 1 to 65535.";
  if (errors.maxDatabases) errors.maxDatabases = "A whole number from 0 to 100000, or empty for unlimited.";
  caErrors(f, errors);
  if (saved === null) {
    if (!typedPassword) errors.password = "Enter the admin password.";
    return { kind: "create", body: parsed.success ? parsed.data : ({} as CreateBody), errors };
  }
  if (!typedPassword && connectionChanged(f, saved)) errors.password = PASSWORD_REQUIRED_MESSAGE;
  const body: UpdateBody = {};
  if (parsed.success) {
    const v = parsed.data;
    if (v.name !== saved.name) body.name = v.name;
    if (v.host !== saved.host) body.host = v.host;
    if (v.port !== saved.port) body.port = v.port;
    if (v.publicHost !== saved.publicHost) body.publicHost = v.publicHost;
    if (v.username !== saved.username) body.username = v.username;
    if (typedPassword) body.password = f.password;
    if (v.nodeId !== saved.nodeId) body.nodeId = v.nodeId;
    if (v.maxDatabases !== saved.maxDatabases) body.maxDatabases = v.maxDatabases;
    if (v.tlsMode !== saved.tlsMode) body.tlsMode = v.tlsMode;
    // A CA only travels with Verify CA. Leaving Verify CA clears the stored CA server-side anyway; the
    // explicit null (allowed with every mode) also clears one left on a host from before that rule.
    if (v.tlsCaCertificate !== savedCa(saved)) body.tlsCaCertificate = v.tlsCaCertificate;
    if (v.notes !== saved.notes) body.notes = v.notes;
  }
  return { kind: "update", body, errors };
}

/**
 * `POST /database-hosts/test` body from the form. Editing with an empty password tests with the
 * stored one (`hostId`) — allowed only while the connection settings are unchanged.
 */
export function testRequest(
  f: HostForm,
  saved: DatabaseHost | null,
): { body: TestBody | null; errors: Record<string, string> } {
  const typedPassword = f.password !== "";
  const errors: Record<string, string> = {};
  if (!typedPassword && saved === null) errors.password = "Enter the admin password.";
  if (!typedPassword && saved !== null && connectionChanged(f, saved))
    errors.password = PASSWORD_REQUIRED_MESSAGE;
  const parsed = TestDatabaseHostRequest.safeParse({
    host: f.host.trim(),
    port: numberOrNaN(f.port),
    username: f.username,
    ...(typedPassword ? { password: f.password } : saved ? { hostId: saved.id } : {}),
    tlsMode: f.tlsMode,
    tlsCaCertificate: effectiveCa(f),
  });
  if (!parsed.success)
    for (const [k, v] of Object.entries(issuesToErrors(parsed.error.issues))) errors[k] ??= v;
  if (errors.port) errors.port = "A port from 1 to 65535.";
  caErrors(f, errors);
  return { body: parsed.success && Object.keys(errors).length === 0 ? parsed.data : null, errors };
}

// ---------------------------------------------------------------------------------------------
// Presentation

/** Table badge: whether the host is encrypted and, separately, whether it is authenticated. */
export function tlsBadge(mode: DatabaseTlsMode): { label: string; tone: Tone; title: string } {
  switch (mode) {
    case "disabled":
      return { label: "Disabled · not encrypted", tone: "danger", title: TLS_MODES[0]!.help };
    case "preferred":
      return { label: "Preferred · not verified", tone: "warning", title: TLS_NOT_VERIFIED_HELP };
    case "required":
      return { label: "Required · not verified", tone: "warning", title: TLS_NOT_VERIFIED_HELP };
    case "verify_ca":
      return {
        label: "Verify CA",
        tone: "success",
        title: `Encrypted; certificate verified against your CA; host name not checked. ${VERIFY_CA_PIN_WARNING}`,
      };
  }
}

/** What `tls` in a test result means for the tested mode (`true` alone only means encrypted). */
export function testTlsFact(result: DatabaseHostTestResult, mode: DatabaseTlsMode): string | null {
  if (result.tls === null) return null;
  if (!result.tls) return "Not encrypted";
  return result.ok && tlsModeVerifies(mode)
    ? "Encrypted, certificate verified"
    : "Encrypted (host not verified)";
}

export const PROXY_WARNING =
  "A proxy or load balancer seems to sit in front of this database server. BlockForge cannot safely stop a statement the host stops answering, so such operations end with an unknown outcome until they are reconciled. Connect BlockForge directly to the database server where possible.";

/** The admin account's missing global privileges (names come from the host test; rendered as text). */
export function missingPrivilegesWarning(privileges: readonly string[]): string {
  return `The admin account seems to lack: ${privileges.join(", ")}. (Privileges granted only through roles or on specific databases are not detected.)`;
}

export function TestResultView({
  result,
  mode,
  onDismiss,
}: {
  result: DatabaseHostTestResult;
  /** The TLS mode the test used. */
  mode: DatabaseTlsMode;
  onDismiss?: () => void;
}) {
  const dismiss = onDismiss ? (
    <Button size="icon-sm" variant="ghost" aria-label="Dismiss test result" onClick={onDismiss}>
      <X aria-hidden />
    </Button>
  ) : undefined;
  const facts = [
    result.serverVersion ? `Server ${result.serverVersion}` : null,
    testTlsFact(result, mode),
    result.latencyMs === null ? null : `${result.latencyMs} ms`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-2">
      {result.ok ? (
        <Callout tone="success" title="Connection works" role="status" action={dismiss}>
          {facts.length ? facts.join(" · ") : null}
        </Callout>
      ) : (
        <Callout tone="danger" title="Connection failed" role="alert" action={dismiss}>
          <span className="break-words">
            {result.error ?? "The database host did not accept the connection."}
          </span>
          {facts.length ? <span className="mt-0.5 block text-xs">{facts.join(" · ")}</span> : null}
        </Callout>
      )}
      {result.proxyDetected ? (
        <Callout tone="warning" title="Proxy or load balancer detected">
          {PROXY_WARNING}
        </Callout>
      ) : null}
      {result.missingPrivileges.length ? (
        <Callout tone="warning" title="Missing privileges">
          <span className="break-words">{missingPrivilegesWarning(result.missingPrivileges)}</span>
        </Callout>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Create / edit

function HostDialog({
  me,
  host,
  onClose,
}: {
  me: Me;
  /** null = create. */
  host: DatabaseHost | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<HostForm>(() => formFromHost(host));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ result: DatabaseHostTestResult; mode: DatabaseTlsMode } | null>(
    null,
  );
  const canListNodes = canAny(me, "nodes.view");
  const nodes = useQuery({ ...nodesQuery, enabled: canListNodes, refetchInterval: false });
  const set = <K extends keyof HostForm>(k: K, v: HostForm[K]) => {
    // The CA stays in the form across TLS mode changes (hidden outside Verify CA, restored when switching
    // back); `effectiveCa` keeps it out of every request made with another mode.
    setForm((f) => ({ ...f, [k]: v }));
    setResult(null);
    setErrors((e) => {
      if (!(k in e) && !("form" in e)) return e;
      const next = { ...e };
      delete next[k];
      delete next.form;
      return next;
    });
  };
  const passwordNeeded = host === null || connectionChanged(form, host);

  const save = useApiMutation({
    mutationFn: (req: ReturnType<typeof hostRequest>) =>
      req.kind === "create" ? databaseHostsApi.create(req.body) : databaseHostsApi.update(host!.id, req.body),
    success: host ? "Database host saved" : "Database host added",
    // The body may carry the admin password.
    sensitive: true,
    silentError: true,
    onError: (err) => {
      const f = fieldErrorsFrom(err);
      setErrors(Object.keys(f).length ? f : { form: databaseErrorMessage(err) });
    },
    onSuccess: async () => {
      setForm((f) => ({ ...f, password: "" }));
      onClose();
      await queryClient.invalidateQueries({ queryKey: qk.databaseHosts.all });
    },
  });
  const test = useApiMutation({
    mutationFn: (body: TestBody) =>
      databaseHostsApi.testSettings(body).then((r) => ({ result: r, mode: body.tlsMode ?? "preferred" })),
    sensitive: true,
    silentError: true,
    onError: (err) => {
      const f = fieldErrorsFrom(err);
      setErrors(Object.keys(f).length ? f : { form: databaseErrorMessage(err) });
    },
    onSuccess: (r) => setResult(r),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const req = hostRequest(form, host);
    setErrors(req.errors);
    if (Object.keys(req.errors).length) return;
    if (req.kind === "update" && Object.keys(req.body).length === 0) {
      onClose();
      return;
    }
    save.mutate(req);
  };
  const runTest = () => {
    const { body, errors: next } = testRequest(form, host);
    setErrors(next);
    setResult(null);
    if (body) test.mutate(body);
  };

  const nodeOptions = [
    { value: "none", label: "None" },
    ...(host?.nodeId && !nodes.data?.some((n) => n.id === host.nodeId)
      ? [{ value: host.nodeId, label: host.nodeName ?? host.nodeId }]
      : []),
    ...(nodes.data ?? []).map((n) => ({ value: n.id, label: n.name })),
  ];
  const tls = TLS_MODES.find((m) => m.value === form.tlsMode)!;
  const busy = save.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{host ? `Edit ${host.name}` : "Add a database host"}</DialogTitle>
            <DialogDescription>
              A MySQL or MariaDB server where server users' databases are created. The admin account needs to
              create databases and users and grant privileges; it can reach every database on the host.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" required error={errors.name}>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Field
              label="Host"
              required
              error={errors.host}
              hint="Host name or IP address the control plane connects to (no port or scheme)."
            >
              <Input
                value={form.host}
                onChange={(e) => set("host", e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field label="Port" required error={errors.port}>
              <Input
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => set("port", e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Public address"
            error={errors.publicHost}
            hint="Shown to server users in connection details. Empty = the host above."
          >
            <Input
              value={form.publicHost}
              onChange={(e) => set("publicHost", e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Admin username" required error={errors.username}>
              <Input
                value={form.username}
                onChange={(e) => set("username", e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Admin password"
              required={passwordNeeded}
              error={errors.password}
              hint={
                host === null
                  ? "Stored encrypted; never shown again."
                  : passwordNeeded
                    ? PASSWORD_REQUIRED_MESSAGE
                    : "Leave empty to keep the stored password; it is never shown."
              }
            >
              <Input
                type="password"
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Linked node"
              error={errors.nodeId}
              hint={
                canListNodes
                  ? "Servers on this node prefer this host while it has room."
                  : "Listing nodes needs the nodes.view permission."
              }
            >
              <Select
                value={form.nodeId || "none"}
                onValueChange={(v) => set("nodeId", v === "none" ? "" : v)}
                options={nodeOptions}
              />
            </Field>
            <Field label="Max databases" error={errors.maxDatabases} hint="Empty = unlimited.">
              <Input
                type="number"
                min={0}
                value={form.maxDatabases}
                onChange={(e) => set("maxDatabases", e.target.value)}
              />
            </Field>
          </div>
          <Field label="TLS" error={errors.tlsMode} hint={tls.help}>
            <Select<DatabaseTlsMode>
              value={form.tlsMode}
              onValueChange={(v) => set("tlsMode", v)}
              options={TLS_MODES.map((m) => ({ value: m.value, label: m.label }))}
            />
          </Field>
          {tlsModeVerifies(form.tlsMode) ? (
            <Field
              label="CA certificate"
              required
              error={errors.tlsCaCertificate}
              hint="PEM of the private CA that issued the database server's certificate, or of that certificate itself."
            >
              <Textarea
                value={form.tlsCaCertificate}
                onChange={(e) => set("tlsCaCertificate", e.target.value)}
                rows={4}
                className="font-mono text-xs"
                spellCheck={false}
                placeholder="-----BEGIN CERTIFICATE-----"
              />
            </Field>
          ) : null}
          <Field label="Notes" error={errors.notes}>
            <Textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              maxLength={1024}
            />
          </Field>
          {result ? <TestResultView result={result.result} mode={result.mode} /> : null}
          {errors.form ? (
            <p role="alert" className="text-sm text-danger">
              {errors.form}
            </p>
          ) : null}
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" loading={test.isPending} onClick={runTest} disabled={busy}>
              <PlugZap aria-hidden />
              Test connection
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                {host ? "Save" : "Add host"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function DatabaseHostsPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const allowed = hasGlobal(me, "database_hosts.manage");
  const q = useQuery({
    queryKey: qk.databaseHosts.list,
    queryFn: ({ signal }) => databaseHostsApi.list(signal),
    enabled: allowed,
  });
  const [editing, setEditing] = useState<DatabaseHost | "new" | null>(null);
  const [deleting, setDeleting] = useState<DatabaseHost | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [results, setResults] = useState<
    Record<string, { result: DatabaseHostTestResult; mode: DatabaseTlsMode }>
  >({});

  const test = useApiMutation({
    mutationFn: (h: DatabaseHost) => databaseHostsApi.test(h.id),
    silentError: true,
    onError: (err) => toastDatabaseError(err, "Could not run the connection test"),
    onSuccess: (r, h) => setResults((all) => ({ ...all, [h.id]: { result: r, mode: h.tlsMode } })),
  });
  const remove = useApiMutation({
    mutationFn: (h: DatabaseHost) => databaseHostsApi.remove(h.id),
    success: (_r, h) => `${h.name} deleted`,
    silentError: true,
    onError: (err) => {
      setDeleteError(databaseErrorMessage(err));
      // A count that changed since the list was loaded.
      if (isApiError(err) && err.code === "CONFLICT")
        void queryClient.invalidateQueries({ queryKey: qk.databaseHosts.all });
    },
    onSuccess: async () => {
      setDeleting(null);
      setDeleteError(null);
      await queryClient.invalidateQueries({ queryKey: qk.databaseHosts.all });
    },
  });

  if (!allowed) return <NoPermission what="manage database hosts" />;
  const hosts = q.data ?? [];

  return (
    <>
      <PageHeader
        title="Database hosts"
        description="MySQL/MariaDB servers where server users create databases for their plugins."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            Add database host
          </Button>
        }
      />
      <Card>
        {q.isPending ? (
          <TableSkeleton columns={6} rows={3} />
        ) : q.isError ? (
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            title="Could not load database hosts"
          />
        ) : hosts.length === 0 ? (
          <EmptyState
            icon={Database}
            title="No database hosts"
            description="Add a MySQL or MariaDB server so server users can create databases."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Public address</TableHead>
                  <TableHead>Linked node</TableHead>
                  <TableHead className="text-right">Databases</TableHead>
                  <TableHead>TLS</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hosts.map((h) => {
                  const result = results[h.id];
                  const badge = tlsBadge(h.tlsMode);
                  return (
                    <Fragment key={h.id}>
                      <TableRow>
                        <TableCell className="max-w-64">
                          <div className="truncate font-medium" title={h.name}>
                            {h.name}
                          </div>
                          {h.notes ? (
                            <div className="line-clamp-2 text-xs break-words text-muted-foreground">
                              {h.notes}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="font-mono text-xs break-all">
                          {hostPort(h.host, h.port)}
                          <div className="font-sans text-muted-foreground">as {h.username}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs break-all">
                          {h.publicHost ?? <span className="font-sans text-muted-foreground">Same</span>}
                        </TableCell>
                        <TableCell className="text-xs">
                          {h.nodeName ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right text-xs whitespace-nowrap tabular">
                          {h.databaseCount} / {h.maxDatabases ?? "unlimited"}
                        </TableCell>
                        <TableCell>
                          <Badge tone={badge.tone} title={badge.title}>
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Test ${h.name}`}
                              title="Test connection"
                              loading={test.isPending && test.variables?.id === h.id}
                              onClick={() => test.mutate(h)}
                            >
                              <PlugZap aria-hidden />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Edit ${h.name}`}
                              title="Edit"
                              onClick={() => setEditing(h)}
                            >
                              <Pencil aria-hidden />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Delete ${h.name}`}
                              title={
                                h.databaseCount > 0 ? "Delete the databases on this host first" : "Delete"
                              }
                              disabled={h.databaseCount > 0}
                              onClick={() => {
                                setDeleteError(null);
                                setDeleting(h);
                              }}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {result ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={7} className="pt-0">
                            <TestResultView
                              result={result.result}
                              mode={result.mode}
                              onDismiss={() =>
                                setResults((all) => {
                                  const next = { ...all };
                                  delete next[h.id];
                                  return next;
                                })
                              }
                            />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
      {editing !== null ? (
        <HostDialog
          key={editing === "new" ? "new" : editing.id}
          me={me}
          host={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (o) return;
          setDeleting(null);
          setDeleteError(null);
        }}
        title={`Delete ${deleting?.name ?? "database host"}?`}
        description={
          <div className="flex flex-col gap-2">
            <p>
              Its connection settings and stored admin password are removed from BlockForge. A host that still
              holds databases cannot be deleted.
            </p>
            {deleteError ? (
              <p role="alert" className="text-danger">
                {deleteError}
              </p>
            ) : null}
          </div>
        }
        confirmLabel="Delete host"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}
