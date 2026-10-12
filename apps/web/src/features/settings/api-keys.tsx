import { useQuery } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { API_KEY_FORBIDDEN_PERMISSIONS, CreateApiKeyRequest } from "@blockforge/contracts";
import type { AccountPermissions, ApiKey, Me, Permission } from "@blockforge/contracts";
import { apiKeysApi } from "@/lib/api/phase4-api";
import { describeError, isApiError } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { linesToList } from "@/components/common/pattern-help";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp, useNow } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------------------------
// Pure helpers (tested)

const FORBIDDEN = new Set<string>(API_KEY_FORBIDDEN_PERMISSIONS);

export interface KeyPermissionOption {
  permission: Permission;
  /** Where the user holds it: everywhere, on some nodes/networks/servers, or as a server owner/user. */
  where: "global" | "scoped" | "servers";
  /** For `servers`: the servers that grant it (ownership or subuser grant). */
  serverNames?: string[];
}

/** What the picker is built from: `GET /account/permissions`, or Me's role grants as a fallback. */
export type HeldPermissions = Pick<AccountPermissions, "global" | "scoped"> &
  Partial<Pick<AccountPermissions, "servers">>;

/**
 * Permissions a key may be limited to — only what the user actually holds (global and scoped role
 * grants, plus owner/subuser server permissions when known), never the ones keys can't exercise.
 * The key's effective rights are re-intersected with the user's permissions on every request.
 */
export function keyPermissionOptions(held: HeldPermissions): KeyPermissionOption[] {
  const out = new Map<Permission, KeyPermissionOption>();
  for (const srv of held.servers ?? []) {
    for (const p of srv.permissions) {
      const o = out.get(p) ?? { permission: p, where: "servers" as const, serverNames: [] };
      o.serverNames!.push(srv.serverName);
      out.set(p, o);
    }
  }
  for (const s of held.scoped) for (const p of s.permissions) out.set(p, { permission: p, where: "scoped" });
  for (const p of held.global) out.set(p, { permission: p, where: "global" });
  return [...out.values()]
    .filter((o) => !FORBIDDEN.has(o.permission))
    .sort((a, b) => a.permission.localeCompare(b.permission));
}

/**
 * IP or CIDR, with the control plane's rules: the address must parse (IPv4 dotted decimal without
 * leading zeros, or IPv6; `::ffff:a.b.c.d` counts as IPv4), prefix ≤ 32 (IPv4) or ≤ 128 (IPv6).
 */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)$/;

function isIpv6(addr: string): boolean {
  if (!addr.includes(":") || !/^[0-9a-fA-F:.]+$/.test(addr)) return false;
  try {
    // The WHATWG URL parser implements the full IPv6 grammar (compression, embedded IPv4).
    return new URL(`http://[${addr}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export function isIpOrCidr(entry: string): boolean {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(entry.trim());
  if (!m) return false;
  const addr = m[1]!;
  const mapped = addr.toLowerCase().startsWith("::ffff:") && IPV4.test(addr.slice(7));
  const max = IPV4.test(addr) || mapped ? 32 : isIpv6(addr) ? 128 : null;
  if (max === null) return false;
  return m[2] === undefined || Number(m[2]) <= max;
}

/** "servers.files.read" → "servers"; groups the picker. */
export function permissionArea(p: string): string {
  return p.split(".")[0] ?? p;
}

export const EXPIRY_PRESETS = [
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
  { value: "never", label: "Never", days: null },
] as const;
export type ExpiryPreset = (typeof EXPIRY_PRESETS)[number]["value"];

/** IP/CIDR lines → list, with the lines that are not valid. */
export function parseAllowedIps(text: string): { ips: string[]; invalid: string[] } {
  const ips = linesToList(text);
  return { ips, invalid: ips.filter((ip) => !isIpOrCidr(ip)) };
}

export function usageExample(secret: string, origin = window.location.origin): string {
  return `curl -H "Authorization: Bearer ${secret}" ${origin}/api/v1/servers`;
}

// ---------------------------------------------------------------------------------------------
// Create

function CreateKeyDialog({
  me,
  open,
  onOpenChange,
  onCreated,
}: {
  me: Me;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (secret: string, key: ApiKey) => void;
}) {
  // Server permissions from ownership/subuser grants come from GET /account/permissions; until the
  // control plane serves it (404), only role grants from the session are offered.
  const held = useQuery({
    queryKey: qk.account.permissions,
    queryFn: ({ signal }) => apiKeysApi.permissions(signal),
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });
  const fallback = isApiError(held.error) && held.error.status === 404;
  const options = useMemo(
    () => keyPermissionOptions(held.data ?? { global: me.globalPermissions, scoped: me.scopedPermissions }),
    [held.data, me],
  );
  const areas = useMemo(() => {
    const m = new Map<string, KeyPermissionOption[]>();
    for (const o of options)
      m.set(permissionArea(o.permission), [...(m.get(permissionArea(o.permission)) ?? []), o]);
    return [...m];
  }, [options]);
  const [name, setName] = useState("");
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<Set<Permission>>(() => new Set());
  const [ips, setIps] = useState("");
  const [expiry, setExpiry] = useState<ExpiryPreset>("90");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const reset = () => {
    setName("");
    setAll(true);
    setSelected(new Set());
    setIps("");
    setExpiry("90");
    setErrors({});
  };
  const create = useApiMutation({
    mutationFn: (body: ReturnType<typeof CreateApiKeyRequest.parse>) => apiKeysApi.create(body),
    success: "API key created",
    errorTitle: "Could not create the API key",
    // The response carries the secret: keep it out of the mutation cache and devtools.
    sensitive: true,
    silentError: true,
    onError: (err) => setErrors({ form: describeError(err).title }),
    invalidate: [qk.account.apiKeys],
    onSuccess: (created) => {
      reset();
      onOpenChange(false);
      onCreated(created.secret, created.key);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const { ips: list, invalid } = parseAllowedIps(ips);
    if (invalid.length) next.allowedIps = `Not an IP address or CIDR range: ${invalid.join(", ")}`;
    if (!all && selected.size === 0)
      next.permissions = "Choose at least one permission, or allow all of yours.";
    const parsed = CreateApiKeyRequest.safeParse({
      name,
      permissions: all ? null : [...selected],
      allowedIps: list,
      expiresInDays: EXPIRY_PRESETS.find((p) => p.value === expiry)!.days,
    });
    if (!parsed.success)
      for (const i of parsed.error.issues)
        next[String(i.path[0])] ??=
          i.path[0] === "name" ? "Enter a name (at most 80 characters)." : i.message;
    setErrors(next);
    if (!parsed.success || Object.keys(next).length) return;
    create.mutate(parsed.data);
  };
  const toggle = (p: Permission, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(p);
      else n.delete(p);
      return n;
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (create.isPending) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-2xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>
              A key acts as you, limited to the permissions you choose — and never more than you hold at the
              time of each request. It cannot manage users, roles, settings, passwords, MFA, SSH or API keys.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" error={errors.name} required hint="e.g. the script or service using it">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Permissions</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="key-scope" checked={all} onChange={() => setAll(true)} />
              All my permissions
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="key-scope" checked={!all} onChange={() => setAll(false)} />
              Only selected permissions
            </label>
            {errors.permissions ? (
              <p role="alert" className="text-xs text-danger">
                {errors.permissions}
              </p>
            ) : null}
            {!all && fallback ? (
              <p className="text-xs text-muted-foreground">
                Server permissions from ownership/subuser grants: coming soon. Until then this list shows the
                permissions your roles give you; “All my permissions” includes your servers.
              </p>
            ) : null}
            {!all && held.isError && !fallback ? (
              <p role="alert" className="text-xs text-danger">
                Could not load your permissions: {describeError(held.error).title}. Showing your role grants
                only.
              </p>
            ) : null}
            {!all && held.isPending && open ? (
              <p className="text-xs text-muted-foreground">Loading your permissions…</p>
            ) : null}
            {!all && options.length === 0 && !held.isPending ? (
              <p className="text-xs text-muted-foreground">
                No permissions to choose from — use “All my permissions”.
              </p>
            ) : null}
            {!all && options.length > 0 ? (
              <div className="grid max-h-72 gap-3 overflow-y-auto rounded-md border p-2.5 sm:grid-cols-2">
                {areas.map(([area, opts]) => (
                  <fieldset key={area} className="flex flex-col gap-1">
                    <legend className="text-xs font-semibold capitalize">{area}</legend>
                    {opts.map((o) => {
                      const id = `key-perm-${o.permission}`;
                      return (
                        <div key={o.permission} className="flex items-center gap-2">
                          <Checkbox
                            id={id}
                            checked={selected.has(o.permission)}
                            onCheckedChange={(c) => toggle(o.permission, c === true)}
                          />
                          <label htmlFor={id} className="font-mono text-xs">
                            {o.permission}
                          </label>
                          {o.where !== "global" ? (
                            <span
                              className="text-[10px] text-muted-foreground"
                              title={o.serverNames?.join(", ")}
                            >
                              {o.where === "scoped"
                                ? "some scopes"
                                : `on ${o.serverNames!.length} server${o.serverNames!.length === 1 ? "" : "s"}`}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
            ) : null}
          </fieldset>
          <Field
            label="Allowed IP addresses"
            error={errors.allowedIps}
            hint="One IP or CIDR range per line (e.g. 203.0.113.7 or 10.0.0.0/8). Empty = any address."
          >
            <Textarea
              value={ips}
              onChange={(e) => setIps(e.target.value)}
              rows={3}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
          <Field label="Expires after" className="max-w-xs">
            <Select<ExpiryPreset>
              value={expiry}
              onValueChange={setExpiry}
              options={EXPIRY_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            />
          </Field>
          {expiry === "never" ? (
            <Callout tone="warning">A key that never expires stays valid until you revoke it.</Callout>
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
            <Button type="submit" loading={create.isPending}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Shown once after creation; the secret lives only in this component's state. */
function SecretDialog({
  secret,
  keyName,
  onClose,
}: {
  secret: string | null;
  keyName: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={secret !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Copy your API key now</DialogTitle>
          <DialogDescription>
            “{keyName}” is shown only this once. Store it in a password manager or secret store — it can't be
            retrieved later; revoke it and create a new one if it is lost.
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <>
            <div className="flex items-center gap-2 rounded-md border bg-muted px-2 py-1.5">
              <code className="min-w-0 flex-1 font-mono text-xs break-all" aria-label="API key">
                {secret}
              </code>
              <CopyButton value={secret} label="Copy API key" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Usage</span>
              <div className="flex items-start gap-2 rounded-md border bg-muted px-2 py-1.5">
                <code className="min-w-0 flex-1 font-mono text-xs break-all">{usageExample(secret)}</code>
                <CopyButton value={usageExample(secret)} label="Copy example" />
              </div>
            </div>
          </>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose}>I've stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// List

export default function ApiKeysCard({ me }: { me: Me }) {
  const now = useNow();
  const q = useQuery({ queryKey: qk.account.apiKeys, queryFn: ({ signal }) => apiKeysApi.list(signal) });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ secret: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revoke = useApiMutation({
    mutationFn: (k: ApiKey) => apiKeysApi.revoke(k.id),
    success: "API key revoked",
    errorTitle: "Could not revoke the key",
    invalidate: [qk.account.apiKeys],
    onSuccess: () => setRevoking(null),
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            For scripts and integrations: send <code className="font-mono">Authorization: Bearer …</code>.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          Create key
        </Button>
      </CardHeader>
      {q.isPending ? (
        <TableSkeleton columns={5} rows={2} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Could not load API keys"
          compact
        />
      ) : q.data.length === 0 ? (
        <EmptyState icon={KeyRound} title="No API keys" compact />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Key</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Allowed IPs</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((k) => {
                const expired = k.expiresAt !== null && k.expiresAt <= now;
                return (
                  <TableRow key={k.id}>
                    <TableCell>
                      <div className="font-medium">{k.name}</div>
                      <code className="font-mono text-xs text-muted-foreground">{k.prefix}…</code>
                    </TableCell>
                    <TableCell className="max-w-64 text-xs">
                      {k.permissions === null ? (
                        "All my permissions"
                      ) : (
                        <span title={k.permissions.join("\n")}>
                          {k.permissions.length} permission{k.permissions.length === 1 ? "" : "s"}:{" "}
                          <span className="text-muted-foreground">
                            {k.permissions.slice(0, 3).join(", ")}
                            {k.permissions.length > 3 ? ", …" : ""}
                          </span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {k.allowedIps.length ? (
                        k.allowedIps.join(", ")
                      ) : (
                        <span className="font-sans">Any address</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {k.expiresAt === null ? (
                        "Never"
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <Timestamp ts={k.expiresAt} />
                          {expired ? <Badge tone="danger">Expired</Badge> : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {k.lastUsedAt ? (
                        <span className="flex flex-col">
                          <Timestamp ts={k.lastUsedAt} />
                          {k.lastUsedIp ? (
                            <span className="font-mono text-muted-foreground">{k.lastUsedIp}</span>
                          ) : null}
                        </span>
                      ) : (
                        "Never"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Revoke ${k.name}`}
                        onClick={() => setRevoking(k)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <CreateKeyDialog
        me={me}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(secret, key) => setRevealed({ secret, name: key.name })}
      />
      <SecretDialog
        secret={revealed?.secret ?? null}
        keyName={revealed?.name ?? ""}
        onClose={() => setRevealed(null)}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke API key?"
        description={`Requests using “${revoking?.name ?? ""}” (${revoking?.prefix ?? ""}…) are refused from now on. This cannot be undone.`}
        confirmLabel="Revoke key"
        destructive
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </Card>
  );
}
